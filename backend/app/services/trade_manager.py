from __future__ import annotations

import asyncio
import contextlib
import hashlib
import hmac
import json
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlencode

import httpx
from cryptography.hazmat.primitives.asymmetric import ed25519
from fastapi import HTTPException

from app.models.execution import ExecutionLegPlan, ExecutionPlanResponse
from app.models.market import ArbitrageOpportunity, ExchangeName, FundingSnapshot
from app.models.trade import (
    FundingLegResult,
    TradeCreateRequest,
    TradeCredentialInput,
    TradeCredentialVerificationRequest,
    TradeCredentialVerificationResponse,
    TradeCredentialVerificationResult,
    TradeEvent,
    TradeLegExecution,
    TradeMode,
    TradeScenario,
    TradeSessionResponse,
)
from app.services.arbitrage import build_opportunities
from app.services.execution import build_execution_plan, reverse_opportunity
from app.services.liquidity import enabled_exchange_names
from app.services.liquidity import OrderBookFetcher, impact_percent
from app.services.opportunity_ranker import (
    build_opportunity,
    capture_opportunity,
    funding_events,
    is_snapshot_usable,
    select_rankable_pair,
)
from app.services.settled_funding import SettledFundingResolver
from app.services.trade_journal import FINAL_STATUSES, TradeJournal


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


WALL_CLOCK_STEP_SECONDS = 5.0
# Entering later than this after the planned entry moment is refused: the funding window is likely gone.
MAX_ENTRY_LATENESS_SECONDS = 20.0
# Maker-first paper fills: how often the book is re-read while a limit order waits.
MAKER_POLL_SECONDS = 2.0
DEFAULT_MAKER_FEE_PERCENT = 0.02


def _compact_json(payload: dict[str, Any]) -> str:
    return json.dumps(payload, separators=(",", ":"), ensure_ascii=False)


def _format_decimal(value: float, digits: int = 8) -> str:
    return f"{value:.{digits}f}".rstrip("0").rstrip(".") or "0"


def _stable_ratio(*parts: str) -> float:
    digest = hashlib.sha256("|".join(parts).encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big") / float(2**64 - 1)


def _support_for_exchange(exchange: ExchangeName) -> tuple[bool, str | None]:
    if exchange == "binance":
        return True, "Requires Binance USD-M futures permission and Hedge Mode enabled."
    if exchange == "coindcx":
        return True, "Uses CoinDCX USDT futures endpoints and market orders for both legs."
    if exchange == "coinswitch":
        return True, "CoinSwitch standard futures API supports live market orders, but leverage must already be configured on the venue."
    if exchange == "delta":
        return True, "Delta Exchange India live mode is enabled with market orders. Contract size is normalized to the nearest supported integer quantity."
    if exchange == "wazirx":
        return False, "WazirX is monitor-only for now; live order routing is not wired up."
    return False, "Live support is unavailable for this exchange in the current phase."


@dataclass
class _TradeCredentialSecret:
    api_key: str
    api_secret: str
    extra: dict[str, str] = field(default_factory=dict)


@dataclass
class _TradeSessionRecord:
    response: TradeSessionResponse
    request: TradeCreateRequest
    plan: ExecutionPlanResponse
    opportunity: ArbitrageOpportunity
    long_snapshot: FundingSnapshot
    short_snapshot: FundingSnapshot
    credentials: dict[ExchangeName, _TradeCredentialSecret] = field(default_factory=dict)
    task: asyncio.Task[None] | None = None


class TradeManager:
    def __init__(self, settings, market_store, ranking_context=None) -> None:
        self.settings = settings
        self.market_store = market_store
        self.ranking_context = ranking_context
        self.client = httpx.AsyncClient(timeout=30.0, headers={"User-Agent": "Fundex/1.0"})
        self._sessions: dict[str, _TradeSessionRecord] = {}
        self._lock = asyncio.Lock()
        self._delta_products_by_symbol: dict[str, int] = {}
        self._delta_products_updated_at: datetime | None = None
        self.journal = TradeJournal(settings.database_file)
        self._books = OrderBookFetcher(self.client)
        self._funding_resolver = SettledFundingResolver(self.client, market_store)
        self._background: set[asyncio.Task[None]] = set()
        # Open carry positions (strategy bot). Paper positions are virtual, so they survive restarts.
        self._carry: dict[str, TradeSessionResponse] = {}
        # Set by the app: sends trade results to Telegram (optional).
        self.notifier = None

    async def start(self) -> None:
        # A restart kills in-flight sessions; record that honestly instead of leaving them "running".
        for session in await self.journal.interrupted():
            if session.strategy == "carry" and session.mode == "paper":
                # Nothing was running in-process: the position is still "open" and the bot picks it up again.
                session.status = "entered"
                session.current_phase = "Holding: collecting funding"
                self._carry[session.id] = session
                continue
            session.status = "failed"
            session.current_phase = "Interrupted by a server restart"
            session.updated_at = _utcnow()
            message = "The server restarted during this trade."
            if session.mode == "live":
                message += " Check both exchanges for open positions and close them manually."
            session.events.append(TradeEvent(at=session.updated_at, phase="failed", message=message, level="error"))
            session.warnings.append(message)
            await self.journal.save(session)

    async def list_journal(self, limit: int = 500, mode: str | None = None) -> list[TradeSessionResponse]:
        return await self.journal.list(limit=limit, mode=mode)

    async def _persist(self, session_id: str) -> None:
        async with self._lock:
            record = self._sessions.get(session_id)
        if record is not None:
            with contextlib.suppress(Exception):
                await self.journal.save(record.response)

    async def _notify(self, session_id: str, kind: str) -> None:
        if self.notifier is None:
            return
        with contextlib.suppress(Exception):
            await self.notifier.notify_trade(await self.get_session(session_id), kind)

    def _spawn(self, coroutine) -> None:
        task = asyncio.create_task(coroutine)
        self._background.add(task)
        task.add_done_callback(self._background.discard)

    async def stop(self) -> None:
        async with self._lock:
            records = list(self._sessions.values())
        for record in records:
            if record.task and not record.task.done():
                record.task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await record.task
        for task in list(self._background):
            task.cancel()
        await self.client.aclose()

    async def create_session(self, request: TradeCreateRequest) -> TradeSessionResponse:
        selected_exchanges = request.selected_exchanges or enabled_exchange_names(self.settings, self.ranking_context)
        snapshots = [
            snapshot
            for snapshot in await self.market_store.get_snapshots()
            if snapshot.exchange in selected_exchanges
        ]
        opportunities = build_opportunities(snapshots, self.settings, self.ranking_context)
        base_opportunity = next(
            (item for item in opportunities if item.canonical_symbol.upper() == request.canonical_symbol.upper()),
            None,
        )
        if base_opportunity is None:
            symbol_snapshots = [
                snapshot
                for snapshot in snapshots
                if snapshot.canonical_symbol.upper() == request.canonical_symbol.upper() and is_snapshot_usable(snapshot)
            ]
            pair = select_rankable_pair(symbol_snapshots, self.settings)
            if pair is not None:
                base_opportunity = build_opportunity(pair[0], pair[1], self.settings, context=self.ranking_context)
        if base_opportunity is None:
            raise HTTPException(status_code=404, detail="Trade setup not found in the current live exchange scope.")

        settles_at_override: datetime | None = None
        if request.strategy == "capture":
            captured = capture_opportunity(base_opportunity, snapshots, self.settings, self.ranking_context)
            if captured is None or captured.capture is None:
                raise HTTPException(status_code=404, detail="No next-settlement setup for this coin right now.")
            base_opportunity = captured
            settles_at_override = captured.capture.settles_at

        execution_target = reverse_opportunity(base_opportunity) if request.scenario == "reverse" else base_opportunity
        plan = build_execution_plan(
            execution_target,
            notional_usd=None,
            capital_usd=request.capital_usd,
            leverage=request.leverage,
            leverage_overrides=request.leverage_overrides,
            holding_periods=request.holding_periods,
            basis_risk_buffer_percent=request.basis_risk_buffer_percent,
            scenario=request.scenario,
        )

        long_snapshot = self._resolve_snapshot(snapshots, execution_target.canonical_symbol, execution_target.long_leg.exchange)
        short_snapshot = self._resolve_snapshot(snapshots, execution_target.canonical_symbol, execution_target.short_leg.exchange)

        pair_funding_time = settles_at_override or self._pair_funding_time(execution_target)
        if pair_funding_time is None:
            raise HTTPException(status_code=400, detail="Live funding timing is missing for this setup, so the trade cannot be armed.")

        entry_at = pair_funding_time - timedelta(seconds=request.schedule.entry_seconds_before_funding)
        exit_at = pair_funding_time + timedelta(seconds=request.schedule.exit_seconds_after_funding)
        cancellable_until = entry_at - timedelta(minutes=10)
        now = _utcnow()
        warnings = list(plan.warnings)
        if entry_at <= now:
            entry_at = now + timedelta(seconds=2)
            cancellable_until = min(cancellable_until, now)
            warnings.append("The setup was armed too close to funding, so entry will begin almost immediately.")

        # Only settlements that land between entry and exit are collected. With legs on different
        # schedules that can be one leg's payment only, which may even be a cost.
        window_hours = max((exit_at - entry_at).total_seconds() / 3600, 0.0)
        window_events = funding_events(execution_target.long_leg, execution_target.short_leg, window_hours, now=entry_at) or []
        settling_legs = set(self._settling_leg_names(execution_target, entry_at, exit_at))
        window_funding_pnl_usd = sum(amount for _, amount in window_events) * plan.notional_usd
        window_net_pnl_usd = plan.expected_net_pnl_usd - plan.estimated_funding_pnl_usd + window_funding_pnl_usd
        window_return_percent = (
            (window_net_pnl_usd / plan.capital_required_usd) * 100 if plan.capital_required_usd > 0 else 0.0
        )
        if settling_legs != {"long", "short"}:
            collected = (
                execution_target.long_leg.display_name if "long" in settling_legs else execution_target.short_leg.display_name
            ) if settling_legs else "neither leg"
            warnings.append(
                f"Only {collected} settles inside the trade window, so the other leg's funding is not collected."
            )
        if window_net_pnl_usd <= 0:
            warnings.append("This trade window is not net profitable after fees, slippage, and basis reserve.")

        long_live_supported, long_support_note = _support_for_exchange(execution_target.long_leg.exchange)
        short_live_supported, short_support_note = _support_for_exchange(execution_target.short_leg.exchange)

        if request.mode == "live":
            unsupported_notes = [note for supported, note in ((long_live_supported, long_support_note), (short_live_supported, short_support_note)) if not supported and note]
            if unsupported_notes:
                raise HTTPException(status_code=400, detail=" ".join(unsupported_notes))

        credentials = self._resolve_credentials(request.credentials)
        if request.mode == "live":
            required = {execution_target.long_leg.exchange, execution_target.short_leg.exchange}
            missing = [exchange for exchange in required if exchange not in credentials]
            if missing:
                raise HTTPException(
                    status_code=400,
                    detail=f"Missing API credentials for {', '.join(sorted(missing))}.",
                )

        session_id = uuid.uuid4().hex
        response = TradeSessionResponse(
            id=session_id,
            canonical_symbol=execution_target.canonical_symbol,
            mode=request.mode,
            scenario=request.scenario,
            status="armed",
            current_phase="Waiting for entry window",
            created_at=now,
            updated_at=now,
            pair_funding_time=pair_funding_time,
            scheduled_entry_at=entry_at,
            scheduled_exit_at=exit_at,
            cancellable_until=cancellable_until,
            capital_input_usd=request.capital_usd,
            leverage=request.leverage,
            holding_periods=request.holding_periods,
            expected_net_pnl_usd=window_net_pnl_usd,
            expected_funding_pnl_usd=window_funding_pnl_usd,
            estimated_total_fees_usd=plan.estimated_total_fees_usd,
            expected_net_return_on_capital_percent=window_return_percent,
            realized_price_pnl_usd=None,
            realized_funding_pnl_usd=None,
            realized_total_fees_usd=None,
            realized_net_pnl_usd=None,
            warnings=warnings,
            events=[
                TradeEvent(
                    at=now,
                    phase="armed",
                    message=(
                        f"{request.mode.title()} trade armed for {execution_target.canonical_symbol}: enter at "
                        f"{entry_at.strftime('%H:%M:%S')} UTC, settlement {pair_funding_time.strftime('%H:%M:%S')} UTC, "
                        f"exit at {exit_at.strftime('%H:%M:%S')} UTC."
                    ),
                )
            ],
            long_leg=self._build_trade_leg(plan.long_leg, execution_target.long_leg.max_leverage, long_live_supported, long_support_note),
            short_leg=self._build_trade_leg(plan.short_leg, execution_target.short_leg.max_leverage, short_live_supported, short_support_note),
            strategy=request.strategy,
            expected_slippage_usd=plan.estimated_total_slippage_usd,
            funding_legs=[
                FundingLegResult(
                    exchange=leg.exchange,
                    side=name,  # type: ignore[arg-type]
                    settles_at=leg.next_funding_time or pair_funding_time,
                    predicted_rate=leg.funding_rate,
                )
                for name, leg in (("long", execution_target.long_leg), ("short", execution_target.short_leg))
                if name in settling_legs
            ],
            funding_status="pending" if settling_legs else "not_applicable",
        )
        record = _TradeSessionRecord(
            response=response,
            request=request,
            plan=plan,
            opportunity=execution_target,
            long_snapshot=long_snapshot,
            short_snapshot=short_snapshot,
            credentials=credentials if request.mode == "live" else {},
        )

        async with self._lock:
            self._sessions[session_id] = record
            record.task = asyncio.create_task(self._run_session(session_id), name=f"trade-session-{session_id}")
        await self.journal.save(response)

        return response

    async def verify_credentials(self, request: TradeCredentialVerificationRequest) -> TradeCredentialVerificationResponse:
        required = list(dict.fromkeys(request.required_exchanges))
        if not required:
            raise HTTPException(status_code=400, detail="required_exchanges cannot be empty.")

        credentials = self._resolve_credentials(request.credentials)
        results: list[TradeCredentialVerificationResult] = []
        checked_at = _utcnow()

        for exchange in required:
            supported, support_note = _support_for_exchange(exchange)
            if not supported:
                results.append(
                    TradeCredentialVerificationResult(
                        exchange=exchange,
                        ok=False,
                        message=support_note or "Live trading is not supported for this exchange.",
                    )
                )
                continue

            credential = credentials.get(exchange)
            if credential is None or not credential.api_key.strip() or not credential.api_secret.strip():
                results.append(
                    TradeCredentialVerificationResult(
                        exchange=exchange,
                        ok=False,
                        message="Missing API key/secret for this exchange.",
                    )
                )
                continue

            try:
                permission_level, permission_note = await self._verify_exchange_credentials(exchange, credential)
                wallet_available_usd, wallet_total_usd, wallet_balance_note = await self._fetch_wallet_balance(exchange, credential)
                if exchange in {"coinswitch", "delta"} and wallet_balance_note is None:
                    permission_level = "trading"
                    permission_note = "Trading access confirmed via private wallet endpoint."
                results.append(
                    TradeCredentialVerificationResult(
                        exchange=exchange,
                        ok=True,
                        message="API credentials verified successfully.",
                        permission_level=permission_level,
                        permission_note=permission_note,
                        wallet_balance_usd=wallet_available_usd,
                        wallet_total_usd=wallet_total_usd,
                        wallet_balance_note=wallet_balance_note,
                    )
                )
            except Exception as exc:  # noqa: BLE001
                results.append(
                    TradeCredentialVerificationResult(
                        exchange=exchange,
                        ok=False,
                        message=self._format_verify_error(exchange, exc),
                        permission_level="unknown",
                    )
                )

        return TradeCredentialVerificationResponse(
            ok=all(result.ok for result in results),
            checked_at=checked_at,
            results=results,
        )

    async def get_session(self, session_id: str) -> TradeSessionResponse:
        async with self._lock:
            record = self._sessions.get(session_id)
            carry = self._carry.get(session_id)
        if carry is not None:
            return carry
        if record is not None:
            return record.response
        stored = await self.journal.get(session_id)
        if stored is None:
            raise HTTPException(status_code=404, detail="Trade session not found.")
        return stored

    async def cancel_session(self, session_id: str) -> TradeSessionResponse:
        async with self._lock:
            record = self._sessions.get(session_id)
            if record is None:
                raise HTTPException(status_code=404, detail="Trade session not found.")
            if record.response.status in {"completed", "failed", "cancelled"}:
                return record.response
            if record.response.status != "armed":
                raise HTTPException(status_code=400, detail="This trade can no longer be cancelled because execution has already started.")
            if record.response.cancellable_until is not None and _utcnow() >= record.response.cancellable_until:
                raise HTTPException(status_code=400, detail="This trade is locked during the final 10 minutes before entry.")
            record.response.status = "cancelled"
            record.response.current_phase = "Cancelled before execution"
            record.response.updated_at = _utcnow()
            record.response.events.append(
                TradeEvent(at=record.response.updated_at, phase="cancelled", message="Trade was cancelled by the user.", level="warning")
            )
            task = record.task
        if task and not task.done():
            task.cancel()
        await self._persist(session_id)
        return await self.get_session(session_id)

    async def _run_session(self, session_id: str) -> None:
        try:
            record = await self._get_record(session_id)
            await self._sleep_until(record.response.scheduled_entry_at)
            record = await self._get_record(session_id)
            if record.response.status == "cancelled":
                return
            late = (_utcnow() - record.response.scheduled_entry_at).total_seconds() if record.response.scheduled_entry_at else 0.0
            if late > MAX_ENTRY_LATENESS_SECONDS:
                await self._mark_failed(
                    session_id,
                    f"Missed the entry window by {late / 60:.1f} minutes (the computer was asleep or the server was busy). No orders were sent.",
                )
                return

            await self._update_phase(session_id, status="entering", phase="Submitting entry orders", message="Entry window opened.")
            if record.request.mode == "paper":
                await self._simulate_entry(session_id)
            else:
                await self._execute_live_entry(session_id)

            await self._update_phase(session_id, status="entered", phase="Waiting for exit window", message="Both entry legs are in place.")
            await self._sleep_until(record.response.scheduled_exit_at)
            record = await self._get_record(session_id)
            if record.response.status == "cancelled":
                return
            exit_late = (_utcnow() - record.response.scheduled_exit_at).total_seconds() if record.response.scheduled_exit_at else 0.0
            if exit_late > MAX_ENTRY_LATENESS_SECONDS:
                # Positions are open, so exit anyway; just say why the timing is off.
                await self._append_event(session_id, "exit", f"Exit is {exit_late:.0f}s late; closing now.", level="warning")

            await self._update_phase(session_id, status="exiting", phase="Submitting exit orders", message="Exit window opened.")
            if record.request.mode == "paper":
                await self._simulate_exit(session_id)
            else:
                await self._execute_live_exit(session_id)

            await self._finalize_results(session_id)
            await self._update_phase(session_id, status="completed", phase="Trade finished", message="Trade session completed.")
            record = await self._get_record(session_id)
            await self._notify(session_id, "completed")
            if record.response.funding_legs:
                self._spawn(self._resolve_settled_funding(session_id))
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            await self._mark_failed(session_id, str(exc))
        finally:
            async with self._lock:
                record = self._sessions.get(session_id)
                if record and record.response.status in FINAL_STATUSES:
                    record.credentials = {}
            await self._persist(session_id)

    async def _book_fill(self, leg: ExecutionLegPlan, action: str) -> tuple[float, float | None, str]:
        """Fill price for `action` ("buy"/"sell") of this leg's notional on the live book right now.

        Returns (fill price, book mid, note). Falls back to the latest mark when the book can't be read;
        raises when the visible book is too thin for the size, because a real order would not fill cleanly.
        """
        note = "no public order book for this venue; used latest mark"
        try:
            book = await self._books.fetch(leg.exchange, leg.exchange_symbol)  # type: ignore[arg-type]
        except Exception as exc:  # noqa: BLE001
            book = None
            note = f"book unavailable ({exc.__class__.__name__}); used latest mark"
        if book:
            bids = sorted(((p, q) for p, q in book[0] if p > 0 and q > 0), key=lambda level: -level[0])
            asks = sorted(((p, q) for p, q in book[1] if p > 0 and q > 0), key=lambda level: level[0])
            if bids and asks:
                mid = (bids[0][0] + asks[0][0]) / 2
                impact = impact_percent(asks if action == "buy" else bids, leg.notional_usd, mid)
                if impact is None:
                    raise RuntimeError(f"{leg.display_name} order book is too thin to fill ${leg.notional_usd:,.0f} right now.")
                price = mid * (1 + impact / 100) if action == "buy" else mid * (1 - impact / 100)
                return price, mid, f"filled on the live book ({impact:.3f}% from mid)"
            note = "book was empty; used latest mark"
        snapshots = await self.market_store.get_snapshots({leg.exchange})  # type: ignore[arg-type]
        mark = next((item.mark_price for item in snapshots if item.exchange_symbol == leg.exchange_symbol and item.mark_price), None)
        return (mark or leg.reference_price), None, note

    async def _simulate_fill(self, session_id: str, leg_name: str, *, exit_order: bool) -> None:
        record = await self._get_record(session_id)
        plan_leg = record.plan.long_leg if leg_name == "long" else record.plan.short_leg
        target = record.response.long_leg if leg_name == "long" else record.response.short_leg
        # Long buys to enter and sells to exit; short does the opposite.
        action = ("sell" if plan_leg.side == "buy" else "buy") if exit_order else plan_leg.side
        price, mid, note = await self._book_fill(plan_leg, action)
        stage = "exit" if exit_order else "entry"
        raw = {"mode": "paper", "simulated": True, "action": action, "fill_price": price, "mid_price": mid, "note": note, "at": _utcnow().isoformat()}
        if exit_order:
            target.status = "closed"
            target.exit_order_id = f"paper-{stage}-{record.response.id}-{leg_name}"
            target.exit_fill_price = price
            target.exit_mid_price = mid
            target.raw_exit_response = raw
        else:
            target.status = "filled"
            target.entry_order_id = f"paper-{stage}-{record.response.id}-{leg_name}"
            target.entry_fill_price = price
            target.entry_mid_price = mid
            target.raw_entry_response = raw
        await self._append_event(session_id, stage, f"Paper {leg_name} {action} at {_format_decimal(price)}: {note}.")

    async def _simulate_entry(self, session_id: str) -> None:
        await asyncio.gather(
            self._simulate_fill(session_id, "long", exit_order=False),
            self._simulate_fill(session_id, "short", exit_order=False),
        )

    async def _simulate_exit(self, session_id: str) -> None:
        await asyncio.gather(
            self._simulate_fill(session_id, "long", exit_order=True),
            self._simulate_fill(session_id, "short", exit_order=True),
        )

    # ---------- Carry positions, opened and closed by the strategy bot ----------

    async def open_carry(
        self,
        *,
        canonical_symbol: str,
        long_exchange: ExchangeName,
        short_exchange: ExchangeName,
        notional_usd: float,
        leverage: float,
        signal_apr: float,
        opened_by: str,
        mode: TradeMode = "paper",
        execution: str = "taker",
        maker_wait_seconds: float = 30.0,
    ) -> TradeSessionResponse:
        """Open an open-ended hedge at live order-book prices. It stays open until close_carry.

        execution "maker_first" posts a limit order at the touch on each leg and crosses the book only if it
        has not filled after maker_wait_seconds; "taker" crosses straight away.
        """
        if mode != "paper":
            raise HTTPException(status_code=400, detail="Automatic live trading is not switched on yet; the strategy bot trades on paper.")
        snapshots = await self.market_store.get_snapshots()
        long_snapshot = self._resolve_snapshot(snapshots, canonical_symbol, long_exchange)
        short_snapshot = self._resolve_snapshot(snapshots, canonical_symbol, short_exchange)
        opportunity = build_opportunity(long_snapshot, short_snapshot, self.settings, context=self.ranking_context)
        plan = build_execution_plan(
            opportunity,
            notional_usd=notional_usd,
            capital_usd=None,
            leverage=leverage,
            leverage_overrides=None,
            holding_periods=1,
            basis_risk_buffer_percent=0.0,
        )
        # Both fills first: a thin book raises here and nothing is recorded.
        (long_price, long_mid, long_note, long_fee), (short_price, short_mid, short_note, short_fee) = await asyncio.gather(
            self._carry_fill(plan.long_leg, "buy", execution, maker_wait_seconds, long_snapshot.maker_fee_bps / 100, plan.long_leg.taker_fee_percent),
            self._carry_fill(plan.short_leg, "sell", execution, maker_wait_seconds, short_snapshot.maker_fee_bps / 100, plan.short_leg.taker_fee_percent),
        )

        now = _utcnow()
        session_id = uuid.uuid4().hex
        legs = []
        for plan_leg, max_leverage, price, mid, note, fee_percent in (
            (plan.long_leg, opportunity.long_leg.max_leverage, long_price, long_mid, long_note, long_fee),
            (plan.short_leg, opportunity.short_leg.max_leverage, short_price, short_mid, short_note, short_fee),
        ):
            supported, support_note = _support_for_exchange(plan_leg.exchange)  # type: ignore[arg-type]
            leg = self._build_trade_leg(plan_leg, max_leverage, supported, support_note)
            leg.status = "filled"
            leg.entry_order_id = f"paper-entry-{session_id}-{plan_leg.side}"
            leg.entry_fill_price = price
            leg.entry_mid_price = mid
            # Fee rates travel with the leg so the exit can be charged the same way after a restart.
            leg.raw_entry_response = {
                "mode": "paper",
                "simulated": True,
                "fill_price": price,
                "mid_price": mid,
                "note": note,
                "fee_percent": fee_percent,
                "taker_fee_percent": plan_leg.taker_fee_percent,
                "maker_fee_percent": (long_snapshot if plan_leg.side == "buy" else short_snapshot).maker_fee_bps / 100,
                "at": now.isoformat(),
            }
            legs.append(leg)

        entry_fees = sum(leg.entry_fill_price * leg.estimated_quantity * leg.raw_entry_response["fee_percent"] / 100 for leg in legs)  # type: ignore[index, operator]
        response = TradeSessionResponse(
            id=session_id,
            canonical_symbol=opportunity.canonical_symbol,
            mode=mode,
            scenario="best",
            status="entered",
            current_phase="Holding: collecting funding",
            created_at=now,
            updated_at=now,
            scheduled_entry_at=now,
            capital_input_usd=plan.capital_required_usd,
            leverage=leverage,
            holding_periods=1,
            expected_net_pnl_usd=-plan.estimated_total_fees_usd,
            expected_funding_pnl_usd=0.0,
            estimated_total_fees_usd=plan.estimated_total_fees_usd,
            expected_net_return_on_capital_percent=0.0,
            realized_funding_pnl_usd=0.0,
            realized_total_fees_usd=entry_fees,
            realized_net_pnl_usd=-entry_fees,
            strategy="carry",
            funding_status="pending",
            expected_slippage_usd=plan.estimated_total_slippage_usd,
            opened_by=opened_by,
            entry_signal_apr=signal_apr,
            warnings=list(plan.warnings),
            events=[
                TradeEvent(
                    at=now,
                    phase="entered",
                    message=(
                        f"Opened by the strategy bot: long {legs[0].display_name} at {_format_decimal(long_price)} ({long_note}), "
                        f"short {legs[1].display_name} at {_format_decimal(short_price)} ({short_note}). Spread {signal_apr:.0f}% a year."
                    ),
                )
            ],
            long_leg=legs[0],
            short_leg=legs[1],
        )
        async with self._lock:
            self._carry[session_id] = response
        await self.journal.save(response)
        return response

    async def open_carry_positions(self, opened_by: str | None = None) -> list[TradeSessionResponse]:
        async with self._lock:
            return [item for item in self._carry.values() if opened_by is None or item.opened_by == opened_by]

    async def credit_carry_funding(self, session_id: str, payments: list[tuple[str, datetime, float]]) -> float:
        """Credit settled funding to an open carry position: [(exchange, settled at, rate)]. Returns USD added."""
        async with self._lock:
            response = self._carry.get(session_id)
        if response is None:
            return 0.0
        seen = {(leg.exchange, leg.settles_at) for leg in response.funding_legs}
        added = 0.0
        for exchange, settles_at, rate in payments:
            if (exchange, settles_at) in seen or settles_at <= response.created_at:
                continue
            side = "long" if response.long_leg.exchange == exchange else "short"
            trade_leg = response.long_leg if side == "long" else response.short_leg
            position_value = (trade_leg.entry_fill_price or trade_leg.reference_price) * trade_leg.estimated_quantity
            # Longs pay a positive rate, shorts receive it.
            payment = (-rate if side == "long" else rate) * position_value
            response.funding_legs.append(
                FundingLegResult(exchange=exchange, side=side, settles_at=settles_at, predicted_rate=rate, actual_rate=rate, source="exchange_history", payment_usd=payment)  # type: ignore[arg-type]
            )
            added += payment
        if added or len(response.funding_legs) != len(seen):
            response.funding_legs.sort(key=lambda leg: leg.settles_at)
            response.funding_status = "settled"
            response.realized_funding_pnl_usd = sum(leg.payment_usd or 0.0 for leg in response.funding_legs)
            response.realized_net_pnl_usd = response.realized_funding_pnl_usd - (response.realized_total_fees_usd or 0.0)
            response.updated_at = _utcnow()
            await self.journal.save(response)
        return added

    async def close_carry(self, session_id: str, reason: str, execution: str = "taker", maker_wait_seconds: float = 30.0) -> TradeSessionResponse:
        async with self._lock:
            response = self._carry.get(session_id)
        if response is None:
            raise HTTPException(status_code=404, detail="Open strategy position not found.")
        response.status = "exiting"
        notes = []

        async def exit_fill(leg: TradeLegExecution) -> tuple[float, float | None, str, float]:
            action = "sell" if leg.side == "buy" else "buy"
            rates = leg.raw_entry_response or {}
            taker = rates.get("taker_fee_percent", 0.05)
            try:
                return await self._carry_fill(leg, action, execution, maker_wait_seconds, rates.get("maker_fee_percent", DEFAULT_MAKER_FEE_PERCENT), taker)  # type: ignore[arg-type]
            except Exception as exc:  # noqa: BLE001
                # Paper positions must always close; say how the price was taken.
                return leg.reference_price, None, f"book too thin ({exc}); closed at the entry reference", taker

        fills = await asyncio.gather(exit_fill(response.long_leg), exit_fill(response.short_leg))
        for leg, (price, mid, note, fee_percent) in zip((response.long_leg, response.short_leg), fills):
            action = "sell" if leg.side == "buy" else "buy"
            leg.status = "closed"
            leg.exit_order_id = f"paper-exit-{response.id}-{leg.side}"
            leg.exit_fill_price = price
            leg.exit_mid_price = mid
            leg.raw_exit_response = {"mode": "paper", "simulated": True, "fill_price": price, "mid_price": mid, "note": note, "fee_percent": fee_percent, "at": _utcnow().isoformat()}
            notes.append(f"{leg.display_name} {action} at {_format_decimal(price)} ({note})")

        fees = 0.0
        slippage = 0.0
        for leg in (response.long_leg, response.short_leg):
            for fill, mid, raw in ((leg.entry_fill_price, leg.entry_mid_price, leg.raw_entry_response), (leg.exit_fill_price, leg.exit_mid_price, leg.raw_exit_response)):
                if fill is not None:
                    raw = raw or {}
                    rate = raw.get("fee_percent", raw.get("taker_fee_percent", (leg.raw_entry_response or {}).get("taker_fee_percent", 0.05)))
                    fees += fill * leg.estimated_quantity * rate / 100
                    if mid:
                        slippage += abs(fill - mid) * leg.estimated_quantity
        now = _utcnow()
        response.realized_price_pnl_usd = self._leg_price_pnl(response.long_leg) + self._leg_price_pnl(response.short_leg)
        response.realized_total_fees_usd = fees
        response.realized_slippage_usd = slippage
        response.realized_funding_pnl_usd = sum(leg.payment_usd or 0.0 for leg in response.funding_legs)
        response.realized_net_pnl_usd = response.realized_price_pnl_usd + response.realized_funding_pnl_usd - fees
        response.funding_status = "settled" if response.funding_legs else "not_applicable"
        response.status = "completed"
        response.current_phase = "Closed by the strategy bot" if response.opened_by else "Closed"
        response.scheduled_exit_at = now
        response.exit_reason = reason
        response.updated_at = now
        response.events.append(TradeEvent(at=now, phase="exit", message=f"Closed: {reason}. " + "; ".join(notes) + "."))
        response.events.append(
            TradeEvent(
                at=now,
                phase="completed",
                message=(
                    f"{len(response.funding_legs)} settlements, funding {response.realized_funding_pnl_usd:+.2f} USD, price {response.realized_price_pnl_usd:+.2f} USD, "
                    f"fees {fees:.2f} USD. Net {response.realized_net_pnl_usd:+.2f} USD."
                ),
            )
        )
        async with self._lock:
            self._carry.pop(session_id, None)
        await self.journal.save(response)
        self._spawn(self._notify_response(response, "completed"))
        return response

    async def _carry_fill(
        self, leg: ExecutionLegPlan, action: str, execution: str, maker_wait_seconds: float, maker_fee_percent: float, taker_fee_percent: float
    ) -> tuple[float, float | None, str, float]:
        """(price, mid, note, fee %) for one paper fill, maker-first or straight across the book."""
        if execution == "maker_first" and maker_wait_seconds > 0:
            filled = await self._paper_limit_fill(leg, action, maker_wait_seconds)
            if filled is not None:
                price, waited = filled
                # Resting at the touch pays no spread: the fill is the reference, so no slippage is booked.
                return price, price, f"limit at the touch filled after {waited:.0f}s (maker)", maker_fee_percent
            price, mid, note = await self._book_fill(leg, action)
            return price, mid, f"limit not filled in {maker_wait_seconds:.0f}s, crossed the book: {note}", taker_fee_percent
        price, mid, note = await self._book_fill(leg, action)
        return price, mid, note, taker_fee_percent

    async def _paper_limit_fill(self, leg: ExecutionLegPlan, action: str, wait_seconds: float) -> tuple[float, float] | None:
        """Paper limit order at the best bid (buy) or best ask (sell). It counts as filled only once the other
        side of the book reaches that price, a conservative stand-in for queue position. Returns (price, seconds)."""

        async def touch() -> tuple[float, float] | None:
            try:
                book = await self._books.fetch(leg.exchange, leg.exchange_symbol)  # type: ignore[arg-type]
            except Exception:  # noqa: BLE001
                return None
            if not book or not book[0] or not book[1]:
                return None
            return max(price for price, _ in book[0]), min(price for price, _ in book[1])

        first = await touch()
        if first is None:
            return None
        limit = first[0] if action == "buy" else first[1]
        started = time.monotonic()
        while time.monotonic() - started < wait_seconds:
            await asyncio.sleep(MAKER_POLL_SECONDS)
            current = await touch()
            if current is None:
                continue
            best_bid, best_ask = current
            if (action == "buy" and best_ask <= limit) or (action == "sell" and best_bid >= limit):
                return limit, time.monotonic() - started
        return None

    async def _notify_response(self, response: TradeSessionResponse, kind: str) -> None:
        if self.notifier is None:
            return
        with contextlib.suppress(Exception):
            await self.notifier.notify_trade(response, kind)

    async def _book_mid(self, leg: ExecutionLegPlan) -> float | None:
        with contextlib.suppress(Exception):
            book = await self._books.fetch(leg.exchange, leg.exchange_symbol)  # type: ignore[arg-type]
            if book and book[0] and book[1]:
                return (max(p for p, _ in book[0]) + min(p for p, _ in book[1])) / 2
        return None

    async def _live_leg(self, record: _TradeSessionRecord, leg_name: str, *, is_exit: bool) -> dict[str, Any]:
        snapshot = record.long_snapshot if leg_name == "long" else record.short_snapshot
        plan_leg = record.plan.long_leg if leg_name == "long" else record.plan.short_leg
        # Read the mid alongside the order so realised slippage can be measured.
        response, mid = await asyncio.gather(
            self._submit_live_order(
                snapshot=snapshot,
                credential=record.credentials[snapshot.exchange],
                leg=plan_leg,
                leverage=plan_leg.leverage,
                is_exit=is_exit,
            ),
            self._book_mid(plan_leg),
        )
        target = record.response.long_leg if leg_name == "long" else record.response.short_leg
        if is_exit:
            target.exit_mid_price = mid
        else:
            target.entry_mid_price = mid
        return response

    async def _execute_live_entry(self, session_id: str) -> None:
        record = await self._get_record(session_id)
        # Both legs go out together so the position is never one-sided for longer than the slower venue.
        results = await asyncio.gather(
            self._live_leg(record, "long", is_exit=False),
            self._live_leg(record, "short", is_exit=False),
            return_exceptions=True,
        )
        failures = []
        for leg_name, result in zip(("long", "short"), results):
            if isinstance(result, Exception):
                failures.append(f"{leg_name}: {result}")
            else:
                await self._apply_order_response(session_id, leg_name, result, status="filled")
        if failures:
            for leg_name, result in zip(("long", "short"), results):
                if not isinstance(result, Exception):
                    await self._attempt_emergency_close(record, leg_name)
            raise RuntimeError("Entry failed (" + "; ".join(failures) + "). Any filled leg was sent an emergency close.")
        await self._append_event(session_id, "entry", "Live entry orders were accepted on both exchanges.")

    async def _execute_live_exit(self, session_id: str) -> None:
        record = await self._get_record(session_id)

        async def close_with_retry(leg_name: str) -> dict[str, Any]:
            last_error: Exception | None = None
            for attempt in range(3):
                try:
                    return await self._live_leg(record, leg_name, is_exit=True)
                except Exception as exc:  # noqa: BLE001
                    last_error = exc
                    await self._append_event(session_id, "exit", f"{leg_name} close attempt {attempt + 1} failed: {exc}", level="warning")
                    await asyncio.sleep(2)
            raise RuntimeError(str(last_error))

        results = await asyncio.gather(close_with_retry("long"), close_with_retry("short"), return_exceptions=True)
        still_open = []
        for leg_name, result in zip(("long", "short"), results):
            if isinstance(result, Exception):
                still_open.append(leg_name)
            else:
                await self._apply_order_response(session_id, leg_name, result, status="closed", exit_order=True)
        if still_open:
            raise RuntimeError(
                f"Could not close the {' and '.join(still_open)} leg after 3 attempts. That position is STILL OPEN; close it on the exchange now."
            )
        await self._append_event(session_id, "exit", "Live exit orders were accepted on both exchanges.")

    async def _finalize_results(self, session_id: str) -> None:
        """Price PnL, fees and slippage from the actual fills. Funding starts as the prediction and is
        replaced by the settled rate once the exchanges publish it."""
        record = await self._get_record(session_id)
        response = record.response
        fees = 0.0
        slippage = 0.0
        slippage_known = False
        for leg, plan_leg in ((response.long_leg, record.plan.long_leg), (response.short_leg, record.plan.short_leg)):
            for fill, mid in ((leg.entry_fill_price, leg.entry_mid_price), (leg.exit_fill_price, leg.exit_mid_price)):
                if fill is None:
                    continue
                fees += fill * leg.estimated_quantity * plan_leg.taker_fee_percent / 100
                if mid:
                    slippage += abs(fill - mid) * leg.estimated_quantity
                    slippage_known = True
        response.realized_price_pnl_usd = self._leg_price_pnl(response.long_leg) + self._leg_price_pnl(response.short_leg)
        response.realized_total_fees_usd = fees
        response.realized_slippage_usd = slippage if slippage_known else None
        response.realized_funding_pnl_usd = response.expected_funding_pnl_usd if response.funding_legs else 0.0
        response.realized_net_pnl_usd = response.realized_price_pnl_usd + response.realized_funding_pnl_usd - fees
        funding_note = " (funding is the prediction until the settled rate is published)" if response.funding_legs else ""
        await self._append_event(
            session_id,
            "result",
            f"Price {response.realized_price_pnl_usd:+.2f} USD, fees {fees:.2f} USD, funding {response.realized_funding_pnl_usd:+.2f} USD{funding_note}.",
        )

    async def _resolve_settled_funding(self, session_id: str) -> None:
        record = await self._get_record(session_id)
        response = record.response
        settles_at = max(leg.settles_at for leg in response.funding_legs)
        await self._sleep_until(settles_at + timedelta(seconds=90))
        for attempt in range(6):
            pending = False
            for funding_leg in response.funding_legs:
                if funding_leg.source in {"exchange_history", "post_settlement_feed"}:
                    continue
                trade_leg = response.long_leg if funding_leg.side == "long" else response.short_leg
                rate, source = await self._funding_resolver.resolve(
                    funding_leg.exchange,
                    trade_leg.exchange_symbol,
                    response.canonical_symbol,
                    funding_leg.settles_at,
                    funding_leg.predicted_rate,
                )
                funding_leg.actual_rate = rate
                funding_leg.source = source  # type: ignore[assignment]
                position_value = (trade_leg.entry_fill_price or trade_leg.reference_price) * trade_leg.estimated_quantity
                # Longs pay a positive rate, shorts receive it.
                funding_leg.payment_usd = (-rate if funding_leg.side == "long" else rate) * position_value
                if source == "estimate" and funding_leg.exchange in {"binance", "delta", "coindcx"}:
                    pending = True
            if not pending or attempt == 5:
                break
            await asyncio.sleep(60)

        sources = {leg.source for leg in response.funding_legs}
        response.funding_status = "settled" if sources <= {"exchange_history", "post_settlement_feed"} else "estimated" if sources == {"estimate"} else "partly_estimated"
        response.realized_funding_pnl_usd = sum(leg.payment_usd or 0.0 for leg in response.funding_legs)
        response.realized_net_pnl_usd = (response.realized_price_pnl_usd or 0.0) + response.realized_funding_pnl_usd - (response.realized_total_fees_usd or 0.0)
        detail = ", ".join(
            f"{leg.exchange} {leg.side} predicted {leg.predicted_rate * 100:+.4f}% settled {((leg.actual_rate or 0) * 100):+.4f}% ({leg.source.replace('_', ' ')})"
            for leg in response.funding_legs
        )
        await self._append_event(
            session_id,
            "funding",
            f"Funding resolved: {detail}. Net result {response.realized_net_pnl_usd:+.2f} USD.",
        )
        await self._persist(session_id)
        await self._notify(session_id, "settled")

    async def _attempt_emergency_close(self, record: _TradeSessionRecord, leg_name: str) -> None:
        target_leg = record.response.long_leg if leg_name == "long" else record.response.short_leg
        target_snapshot = record.long_snapshot if leg_name == "long" else record.short_snapshot
        credential = record.credentials.get(target_snapshot.exchange)
        if credential is None or target_leg.entry_order_id is None:
            return
        with contextlib.suppress(Exception):
            await self._submit_live_order(
                snapshot=target_snapshot,
                credential=credential,
                leg=record.plan.long_leg if leg_name == "long" else record.plan.short_leg,
                leverage=(record.plan.long_leg if leg_name == "long" else record.plan.short_leg).leverage,
                is_exit=True,
            )
            await self._append_event(record.response.id, "recovery", f"Emergency close was submitted for the {leg_name} leg.", level="warning")

    async def _verify_exchange_credentials(self, exchange: ExchangeName, credential: _TradeCredentialSecret) -> tuple[str, str | None]:
        if exchange == "binance":
            return await self._verify_binance_credentials(credential)
        if exchange == "coindcx":
            return await self._verify_coindcx_credentials(credential)
        if exchange == "coinswitch":
            return await self._verify_coinswitch_credentials(credential)
        if exchange == "delta":
            return await self._verify_delta_credentials(credential)
        raise RuntimeError(f"Credential verification is unavailable for {exchange}.")

    async def _fetch_wallet_balance(self, exchange: ExchangeName, credential: _TradeCredentialSecret) -> tuple[float | None, float | None, str | None]:
        try:
            if exchange == "binance":
                available, total = await self._fetch_binance_wallet_balance(credential)
                return available, total, None
            if exchange == "coindcx":
                available, total = await self._fetch_coindcx_wallet_balance(credential)
                return available, total, None
            if exchange == "coinswitch":
                return await self._fetch_coinswitch_wallet_balance(credential)
            if exchange == "delta":
                available, total = await self._fetch_delta_wallet_balance(credential)
                return available, total, None
            return None, None, "Wallet balance fetch is not available for this exchange."
        except Exception as exc:  # noqa: BLE001
            return None, None, f"Wallet balance fetch failed: {str(exc)}"

    async def _verify_binance_credentials(self, credential: _TradeCredentialSecret) -> tuple[str, str | None]:
        params = {
            "recvWindow": 5_000,
            "timestamp": int(_utcnow().timestamp() * 1000),
        }
        payload = await self._binance_signed_request("GET", "/fapi/v2/account", credential, params=params)
        can_trade = bool(payload.get("canTrade"))
        if can_trade:
            return "trading", "Trading enabled on Binance futures API key."
        return "read_only", "Authenticated, but Binance reports trading is disabled on this API key."

    async def _verify_coindcx_credentials(self, credential: _TradeCredentialSecret) -> tuple[str, str | None]:
        payload = {"timestamp": int(_utcnow().timestamp() * 1000)}
        response = await self._coindcx_post(credential, "/exchange/v1/users/info", payload)
        if isinstance(response, dict):
            can_trade = response.get("can_trade") or response.get("is_user_allowed_to_trade") or response.get("trade_enabled")
            if isinstance(can_trade, bool):
                return ("trading", "Trading enabled on CoinDCX API key.") if can_trade else ("read_only", "CoinDCX key is authenticated but trading appears disabled.")
        return "unknown", "Authenticated on CoinDCX. Trading permission could not be determined explicitly."

    async def _verify_coinswitch_credentials(self, credential: _TradeCredentialSecret) -> tuple[str, str | None]:
        epoch_time = await self._coinswitch_server_epoch()
        params = {"exchange": credential.extra.get("exchange", "EXCHANGE_2")}
        endpoint = "/trade/api/v2/futures/instrument_info"
        request_path = endpoint
        if params:
            request_path += "?" + urlencode(params)

        signature = self._coinswitch_sign_get_request(request_path, str(epoch_time), credential.api_secret)
        response = await self.client.get(
            f"https://coinswitch.co{request_path}",
            headers={
                "Content-Type": "application/json",
                "X-AUTH-SIGNATURE": signature,
                "X-AUTH-APIKEY": credential.api_key,
                "X-AUTH-EPOCH": str(epoch_time),
                "User-Agent": "Fundex/1.0",
            },
        )
        response.raise_for_status()
        return "unknown", "Authenticated on CoinSwitch. Trading permission is inferred via wallet/trade endpoints."

    async def _verify_delta_credentials(self, credential: _TradeCredentialSecret) -> tuple[str, str | None]:
        await self._delta_signed_request("GET", "/v2/wallet/balances", credential)
        return "trading", "Trading-level private wallet access verified on Delta."

    async def _fetch_binance_wallet_balance(self, credential: _TradeCredentialSecret) -> tuple[float | None, float | None]:
        params = {
            "recvWindow": 5_000,
            "timestamp": int(_utcnow().timestamp() * 1000),
        }
        payload = await self._binance_signed_request("GET", "/fapi/v2/balance", credential, params=params)
        if not isinstance(payload, list):
            return None
        for item in payload:
            if not isinstance(item, dict):
                continue
            if str(item.get("asset", "")).upper() != "USDT":
                continue
            for key in ("availableBalance", "crossWalletBalance", "balance"):
                value = item.get(key)
                if value in (None, ""):
                    continue
                available = float(value)
                total_raw = item.get("balance")
                total = float(total_raw) if total_raw not in (None, "") else available
                return available, total
        return None, None

    async def _fetch_coindcx_wallet_balance(self, credential: _TradeCredentialSecret) -> tuple[float | None, float | None]:
        payload = {"timestamp": int(_utcnow().timestamp() * 1000)}
        response = await self._coindcx_post(credential, "/exchange/v1/users/balances", payload)
        if not isinstance(response, list):
            return None
        for item in response:
            if not isinstance(item, dict):
                continue
            currency = str(item.get("currency", "")).upper()
            if currency not in {"USDT", "USDTFUT"}:
                continue
            value = item.get("balance") or item.get("available_balance")
            if value in (None, ""):
                continue
            total = float(item.get("balance")) if item.get("balance") not in (None, "") else None
            available = float(item.get("available_balance")) if item.get("available_balance") not in (None, "") else total
            return available, total
        return None, None

    async def _fetch_coinswitch_wallet_balance(self, credential: _TradeCredentialSecret) -> tuple[float | None, float | None, str | None]:
        epoch_time = await self._coinswitch_server_epoch()
        endpoint = "/trade/api/v2/futures/wallet_balance"
        request_path = endpoint
        signature = self._coinswitch_sign_get_request(request_path, str(epoch_time), credential.api_secret)
        response = await self.client.get(
            f"https://coinswitch.co{request_path}",
            headers={
                "Content-Type": "application/json",
                "X-AUTH-SIGNATURE": signature,
                "X-AUTH-APIKEY": credential.api_key,
                "X-AUTH-EPOCH": str(epoch_time),
                "User-Agent": "Fundex/1.0",
            },
        )
        if response.status_code >= 400:
            return None, None, f"Wallet endpoint returned HTTP {response.status_code}."
        payload = response.json()
        data = payload.get("data")
        if isinstance(data, dict):
            # Common top-level wallet keys.
            for key in ("available_balance", "available_margin", "free_balance"):
                value = data.get(key)
                if value not in (None, ""):
                    available = float(value)
                    total_raw = data.get("total_balance") or data.get("wallet_balance") or data.get("balance") or value
                    total = float(total_raw) if total_raw not in (None, "") else available
                    return available, total, None
            # Nested wallets map/list patterns.
            nested_wallet = data.get("wallet") or data.get("wallet_balance") or data.get("balances") or data.get("result")
            if isinstance(nested_wallet, dict):
                usdt_bucket = nested_wallet.get("USDT") or nested_wallet.get("usdt")
                if isinstance(usdt_bucket, dict):
                    available_raw = usdt_bucket.get("available_balance") or usdt_bucket.get("free") or usdt_bucket.get("available")
                    total_raw = usdt_bucket.get("total_balance") or usdt_bucket.get("balance") or usdt_bucket.get("wallet_balance")
                    available = float(available_raw) if available_raw not in (None, "") else None
                    total = float(total_raw) if total_raw not in (None, "") else available
                    if available is not None or total is not None:
                        return available, total, None
            for key in ("available_balance", "balance", "wallet_balance", "equity"):
                value = data.get(key)
                if value in (None, ""):
                    continue
                parsed = float(value)
                return parsed, parsed, None
        if isinstance(data, list):
            totals: list[float] = []
            candidate_available: list[float] = []
            for row in data:
                if not isinstance(row, dict):
                    continue
                base_asset = str(row.get("base_asset", "")).upper()
                if base_asset != "USDT":
                    continue
                available_row = row.get("available_balance") or row.get("free_balance")
                if available_row not in (None, ""):
                    candidate_available.append(float(available_row))
                subtotal = 0.0
                saw_value = False
                for key in ("available_balance", "blocked_balance", "position_margin", "open_order_margin"):
                    value = row.get(key)
                    if value in (None, ""):
                        continue
                    subtotal += float(value)
                    saw_value = True
                if saw_value:
                    totals.append(subtotal)
            if totals:
                total = max(totals)
                available = max(candidate_available) if candidate_available else None
                if available is None:
                    return None, total, "CoinSwitch returned margin-by-symbol data; total wallet estimated from largest USDT bucket."
                return available, total, None
        if isinstance(data, dict) and isinstance(data.get("result"), list):
            result_rows = data.get("result")
            if isinstance(result_rows, list):
                usdt_rows = [row for row in result_rows if isinstance(row, dict) and str(row.get("base_asset", "")).upper() == "USDT"]
                if usdt_rows:
                    available_values = [
                        float(row["available_balance"])
                        for row in usdt_rows
                        if row.get("available_balance") not in (None, "")
                    ]
                    total_values = [
                        sum(
                            float(row[key]) for key in ("blocked_balance", "position_margin", "open_order_margin")
                            if row.get(key) not in (None, "")
                        )
                        for row in usdt_rows
                    ]
                    available = max(available_values) if available_values else None
                    total = max(total_values) if total_values else available
                    if available is not None or total is not None:
                        return available, total, None
        return None, None, "Wallet balance not returned by exchange response."

    async def _fetch_delta_wallet_balance(self, credential: _TradeCredentialSecret) -> tuple[float | None, float | None]:
        payload = await self._delta_signed_request("GET", "/v2/wallet/balances", credential)
        rows = payload.get("result")
        if not isinstance(rows, list):
            return None, None

        selected_value: float | None = None
        for preferred_currency in ("USDT", "INR"):
            for row in rows:
                if not isinstance(row, dict):
                    continue
                symbol = str(row.get("asset_symbol") or row.get("asset") or "").upper()
                if symbol != preferred_currency:
                    continue
                for key in ("available_balance", "balance", "wallet_balance"):
                    value = row.get(key)
                    if value in (None, ""):
                        continue
                    available = float(value)
                    total_raw = row.get("balance") or row.get("wallet_balance") or value
                    total = float(total_raw) if total_raw not in (None, "") else available
                    return available, total

        for row in rows:
            if not isinstance(row, dict):
                continue
            for key in ("available_balance", "balance", "wallet_balance"):
                value = row.get(key)
                if value in (None, ""):
                    continue
                parsed = float(value)
                if selected_value is None:
                    selected_value = parsed
        return selected_value, selected_value

    async def _coinswitch_server_epoch(self) -> int:
        response = await self.client.get("https://coinswitch.co/trade/api/v2/time")
        response.raise_for_status()
        payload = response.json()
        return int(payload.get("serverTime") or int(_utcnow().timestamp() * 1000))

    @staticmethod
    def _coinswitch_sign_get_request(request_path: str, epoch_time: str, secret_hex: str) -> str:
        request_string = f"GET{request_path}{epoch_time}".encode("utf-8")
        private_key = ed25519.Ed25519PrivateKey.from_private_bytes(bytes.fromhex(secret_hex))
        return private_key.sign(request_string).hex()

    @staticmethod
    def _format_verify_error(exchange: ExchangeName, exc: Exception) -> str:
        if isinstance(exc, httpx.HTTPStatusError):
            status = exc.response.status_code
            body = exc.response.text.strip()
            trimmed_body = body[:180] + ("..." if len(body) > 180 else "")
            if trimmed_body:
                return f"{exchange} verification failed with HTTP {status}: {trimmed_body}"
            return f"{exchange} verification failed with HTTP {status}."
        return f"{exchange} verification failed: {str(exc)}"

    async def _submit_live_order(
        self,
        *,
        snapshot: FundingSnapshot,
        credential: _TradeCredentialSecret,
        leg: ExecutionLegPlan,
        leverage: float,
        is_exit: bool,
    ) -> dict[str, Any]:
        if snapshot.exchange == "binance":
            if not is_exit:
                await self._binance_set_leverage(credential, snapshot.exchange_symbol, leverage)
            return await self._binance_order(credential, snapshot.exchange_symbol, leg, is_exit)
        if snapshot.exchange == "coindcx":
            if not is_exit:
                await self._coindcx_set_leverage(credential, snapshot.exchange_symbol, leverage)
            return await self._coindcx_order(credential, snapshot.exchange_symbol, leg, leverage, is_exit)
        if snapshot.exchange == "coinswitch":
            return await self._coinswitch_order(credential, snapshot.exchange_symbol, leg, is_exit)
        if snapshot.exchange == "delta":
            if not is_exit:
                await self._delta_set_leverage(credential, snapshot.exchange_symbol, leverage)
            return await self._delta_order(credential, snapshot.exchange_symbol, leg, is_exit)
        raise RuntimeError(f"Live trading is not supported for {snapshot.exchange} in this phase.")

    async def _binance_set_leverage(self, credential: _TradeCredentialSecret, symbol: str, leverage: float) -> None:
        params = {
            "symbol": symbol,
            "leverage": int(round(leverage)),
            "timestamp": int(_utcnow().timestamp() * 1000),
        }
        await self._binance_signed_request("POST", "/fapi/v1/leverage", credential, params=params)

    async def _binance_order(
        self,
        credential: _TradeCredentialSecret,
        symbol: str,
        leg: ExecutionLegPlan,
        is_exit: bool,
    ) -> dict[str, Any]:
        entry_side = "BUY" if leg.side == "buy" else "SELL"
        close_side = "SELL" if leg.side == "buy" else "BUY"
        position_side = "LONG" if leg.side == "buy" else "SHORT"
        params = {
            "symbol": symbol,
            "side": close_side if is_exit else entry_side,
            "positionSide": position_side,
            "type": "MARKET",
            "quantity": _format_decimal(leg.estimated_quantity, 6),
            "newOrderRespType": "RESULT",
            "timestamp": int(_utcnow().timestamp() * 1000),
        }
        return await self._binance_signed_request("POST", "/fapi/v1/order", credential, params=params)

    async def _binance_signed_request(
        self,
        method: str,
        path: str,
        credential: _TradeCredentialSecret,
        *,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        query_string = urlencode(params)
        signature = hmac.new(
            credential.api_secret.encode("utf-8"),
            query_string.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        response = await self.client.request(
            method,
            f"https://fapi.binance.com{path}",
            headers={"X-MBX-APIKEY": credential.api_key},
            params={**params, "signature": signature},
        )
        response.raise_for_status()
        return response.json()

    async def _coindcx_set_leverage(self, credential: _TradeCredentialSecret, pair: str, leverage: float) -> None:
        payload = {
            "timestamp": int(_utcnow().timestamp() * 1000),
            "leverage": str(int(round(leverage))),
            "pair": pair,
            "margin_currency_short_name": "USDT",
        }
        await self._coindcx_post(credential, "/exchange/v1/derivatives/futures/positions/update_leverage", payload)

    async def _coindcx_order(
        self,
        credential: _TradeCredentialSecret,
        pair: str,
        leg: ExecutionLegPlan,
        leverage: float,
        is_exit: bool,
    ) -> dict[str, Any]:
        payload = {
            "timestamp": int(_utcnow().timestamp() * 1000),
            "order": {
                "side": ("sell" if leg.side == "buy" else "buy") if is_exit else leg.side,
                "pair": pair,
                "order_type": "market_order",
                "total_quantity": float(_format_decimal(leg.estimated_quantity, 6)),
                "leverage": int(round(leverage)),
                "notification": "no_notification",
                "margin_currency_short_name": "USDT",
            },
        }
        response = await self._coindcx_post(credential, "/exchange/v1/derivatives/futures/orders/create", payload)
        return response[0] if isinstance(response, list) and response else response

    async def _coindcx_post(self, credential: _TradeCredentialSecret, path: str, payload: dict[str, Any]) -> Any:
        encoded = _compact_json(payload)
        signature = hmac.new(
            credential.api_secret.encode("utf-8"),
            encoded.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        response = await self.client.post(
            f"https://api.coindcx.com{path}",
            headers={
                "Content-Type": "application/json",
                "X-AUTH-APIKEY": credential.api_key,
                "X-AUTH-SIGNATURE": signature,
            },
            content=encoded,
        )
        response.raise_for_status()
        return response.json()

    async def _coinswitch_order(
        self,
        credential: _TradeCredentialSecret,
        symbol: str,
        leg: ExecutionLegPlan,
        is_exit: bool,
    ) -> dict[str, Any]:
        payload = {
            "symbol": symbol.upper(),
            "exchange": credential.extra.get("exchange", "EXCHANGE_2"),
            "side": ("SELL" if leg.side == "buy" else "BUY") if is_exit else leg.side.upper(),
            "order_type": "MARKET",
            "quantity": float(_format_decimal(leg.estimated_quantity, 6)),
        }
        if is_exit:
            payload["reduce_only"] = True

        endpoint = "/trade/api/v2/futures/order"
        signature = self._coinswitch_sign_payload("POST", endpoint, payload, credential.api_secret)
        response = await self.client.post(
            f"https://coinswitch.co{endpoint}",
            headers={
                "Content-Type": "application/json",
                "X-AUTH-SIGNATURE": signature,
                "X-AUTH-APIKEY": credential.api_key,
            },
            content=_compact_json(payload),
        )
        response.raise_for_status()
        return response.json()

    async def _delta_set_leverage(self, credential: _TradeCredentialSecret, symbol: str, leverage: float) -> None:
        product_id = await self._delta_product_id(symbol)
        await self._delta_signed_request(
            "POST",
            f"/v2/products/{product_id}/orders/leverage",
            credential,
            payload={"leverage": int(round(leverage))},
        )

    async def _delta_order(
        self,
        credential: _TradeCredentialSecret,
        symbol: str,
        leg: ExecutionLegPlan,
        is_exit: bool,
    ) -> dict[str, Any]:
        product_id = await self._delta_product_id(symbol)
        side = ("sell" if leg.side == "buy" else "buy") if is_exit else leg.side
        payload = {
            "product_id": product_id,
            "order_type": "market_order",
            "size": max(1, int(round(leg.estimated_quantity))),
            "side": side,
        }
        if is_exit:
            payload["reduce_only"] = True
        return await self._delta_signed_request("POST", "/v2/orders", credential, payload=payload)

    async def _delta_product_id(self, symbol: str) -> int:
        await self._refresh_delta_products_if_needed()
        product_id = self._delta_products_by_symbol.get(symbol)
        if product_id is not None:
            return product_id
        raise RuntimeError(f"Delta product id not found for symbol {symbol}.")

    async def _refresh_delta_products_if_needed(self) -> None:
        now = _utcnow()
        if self._delta_products_updated_at and now - self._delta_products_updated_at < timedelta(hours=6):
            return
        response = await self.client.get(
            "https://api.india.delta.exchange/v2/products",
            params={"contract_types": "perpetual_futures", "states": "live", "page_size": 500},
        )
        response.raise_for_status()
        payload = response.json()
        products: dict[str, int] = {}
        for item in payload.get("result", []):
            if not isinstance(item, dict):
                continue
            symbol = item.get("symbol")
            product_id = item.get("id")
            if not symbol or product_id in (None, ""):
                continue
            products[str(symbol)] = int(product_id)
        self._delta_products_by_symbol = products
        self._delta_products_updated_at = now

    async def _delta_signed_request(
        self,
        method: str,
        path: str,
        credential: _TradeCredentialSecret,
        *,
        query_params: dict[str, Any] | None = None,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        timestamp = str(int(time.time()))
        query_string = urlencode(query_params or {})
        query_suffix = f"?{query_string}" if query_string else ""
        body = _compact_json(payload) if payload is not None else ""
        signature_data = f"{method.upper()}{timestamp}{path}{query_suffix}{body}"
        signature = hmac.new(
            credential.api_secret.encode("utf-8"),
            signature_data.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        headers = {
            "Accept": "application/json",
            "api-key": credential.api_key,
            "signature": signature,
            "timestamp": timestamp,
        }
        if payload is not None:
            headers["Content-Type"] = "application/json"
        response = await self.client.request(
            method.upper(),
            f"https://api.india.delta.exchange{path}",
            params=query_params,
            headers=headers,
            content=body if payload is not None else None,
        )
        response.raise_for_status()
        return response.json()

    @staticmethod
    def _coinswitch_sign_payload(method: str, endpoint: str, payload: dict[str, Any], secret_hex: str) -> str:
        request_string = f"{method}{endpoint}{_compact_json(payload)}".encode("utf-8")
        private_key = ed25519.Ed25519PrivateKey.from_private_bytes(bytes.fromhex(secret_hex))
        return private_key.sign(request_string).hex()

    async def _apply_order_response(
        self,
        session_id: str,
        leg_name: str,
        response_payload: dict[str, Any],
        *,
        status: str,
        exit_order: bool = False,
    ) -> None:
        record = await self._get_record(session_id)
        target = record.response.long_leg if leg_name == "long" else record.response.short_leg
        target.status = status  # type: ignore[assignment]
        order_id = response_payload.get("orderId") or response_payload.get("id") or response_payload.get("order_id")
        avg_price = response_payload.get("avgPrice") or response_payload.get("avg_price") or response_payload.get("average_price") or response_payload.get("price")
        parsed_price = float(avg_price) if avg_price not in (None, "", 0, "0") else target.reference_price
        if exit_order:
            target.exit_order_id = str(order_id) if order_id is not None else None
            target.exit_fill_price = parsed_price
            target.raw_exit_response = response_payload
        else:
            target.entry_order_id = str(order_id) if order_id is not None else None
            target.entry_fill_price = parsed_price
            target.raw_entry_response = response_payload
        record.response.updated_at = _utcnow()

    async def _append_event(self, session_id: str, phase: str, message: str, level: str = "info") -> None:
        record = await self._get_record(session_id)
        timestamp = _utcnow()
        record.response.updated_at = timestamp
        record.response.events.append(TradeEvent(at=timestamp, phase=phase, message=message, level=level))  # type: ignore[arg-type]

    async def _update_phase(self, session_id: str, *, status: str, phase: str, message: str) -> None:
        record = await self._get_record(session_id)
        timestamp = _utcnow()
        record.response.status = status  # type: ignore[assignment]
        record.response.current_phase = phase
        record.response.updated_at = timestamp
        record.response.events.append(TradeEvent(at=timestamp, phase=status, message=message))
        await self._persist(session_id)

    async def _mark_failed(self, session_id: str, message: str) -> None:
        try:
            record = await self._get_record(session_id)
        except HTTPException:
            return
        timestamp = _utcnow()
        record.response.status = "failed"
        record.response.current_phase = "Trade failed"
        record.response.updated_at = timestamp
        record.response.events.append(TradeEvent(at=timestamp, phase="failed", message=message, level="error"))
        record.response.warnings.append(message)
        await self._persist(session_id)
        self._spawn(self._notify(session_id, "failed"))

    @staticmethod
    def _leg_price_pnl(leg: TradeLegExecution) -> float:
        if leg.entry_fill_price is None or leg.exit_fill_price is None:
            return 0.0
        if leg.side == "buy":
            return (leg.exit_fill_price - leg.entry_fill_price) * leg.estimated_quantity
        return (leg.entry_fill_price - leg.exit_fill_price) * leg.estimated_quantity

    async def _get_record(self, session_id: str) -> _TradeSessionRecord:
        async with self._lock:
            record = self._sessions.get(session_id)
        if record is None:
            raise HTTPException(status_code=404, detail="Trade session not found.")
        return record

    async def _sleep_until(self, target: datetime | None) -> None:
        # asyncio.sleep runs on a monotonic clock that stops while the machine is suspended, so one long
        # sleep can wake hours late. Re-check the wall clock in short steps instead.
        if target is None:
            return
        while True:
            remaining = (target - _utcnow()).total_seconds()
            if remaining <= 0:
                return
            await asyncio.sleep(min(remaining, WALL_CLOCK_STEP_SECONDS))

    @staticmethod
    def _resolve_snapshot(snapshots: list[FundingSnapshot], canonical_symbol: str, exchange: ExchangeName) -> FundingSnapshot:
        for snapshot in snapshots:
            if snapshot.canonical_symbol.upper() == canonical_symbol.upper() and snapshot.exchange == exchange:
                return snapshot
        raise HTTPException(status_code=404, detail=f"Live snapshot missing for {canonical_symbol} on {exchange}.")

    @staticmethod
    def _settling_leg_names(opportunity: ArbitrageOpportunity, start: datetime, end: datetime) -> list[str]:
        names: list[str] = []
        for name, leg in (("long", opportunity.long_leg), ("short", opportunity.short_leg)):
            if leg.next_funding_time is not None and start <= leg.next_funding_time <= end:
                names.append(name)
        return names

    @staticmethod
    def _pair_funding_time(opportunity: ArbitrageOpportunity) -> datetime | None:
        timestamps = [opportunity.long_leg.next_funding_time, opportunity.short_leg.next_funding_time]
        valid = [timestamp for timestamp in timestamps if timestamp is not None]
        return min(valid) if valid else None

    @staticmethod
    def _build_trade_leg(
        leg: ExecutionLegPlan,
        max_leverage: float | None,
        live_supported: bool,
        support_note: str | None,
    ) -> TradeLegExecution:
        return TradeLegExecution(
            exchange=leg.exchange,  # type: ignore[arg-type]
            display_name=leg.display_name,
            exchange_symbol=leg.exchange_symbol,
            side=leg.side,
            reference_price=leg.reference_price,
            estimated_quantity=leg.estimated_quantity,
            leverage=leg.leverage,
            max_leverage=max_leverage,
            notional_usd=leg.notional_usd,
            initial_margin_usd=leg.initial_margin_usd,
            trade_url=leg.trade_url,
            live_supported=live_supported,
            support_note=support_note,
        )

    @staticmethod
    def _resolve_credentials(credentials: list[TradeCredentialInput]) -> dict[ExchangeName, _TradeCredentialSecret]:
        resolved: dict[ExchangeName, _TradeCredentialSecret] = {}
        for item in credentials:
            resolved[item.exchange] = _TradeCredentialSecret(
                api_key=item.api_key,
                api_secret=item.api_secret,
                extra=item.extra,
            )
        return resolved
