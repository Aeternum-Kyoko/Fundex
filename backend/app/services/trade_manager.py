from __future__ import annotations

import asyncio
import contextlib
import hashlib
import hmac
import json
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
    TradeCreateRequest,
    TradeCredentialInput,
    TradeEvent,
    TradeLegExecution,
    TradeMode,
    TradeScenario,
    TradeSessionResponse,
)
from app.services.arbitrage import build_opportunities
from app.services.execution import build_execution_plan, reverse_opportunity
from app.services.opportunity_ranker import (
    build_opportunity_leg,
    combined_open_interest_usd,
    estimate_max_leg_age_seconds,
    estimate_price_dislocation_percent,
    is_snapshot_usable,
    score_opportunity_pair,
    select_rankable_pair,
)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


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
        return False, "Delta live automation is not enabled in this phase because contract-size validation still needs a dedicated product map."
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
    def __init__(self, settings, market_store) -> None:
        self.settings = settings
        self.market_store = market_store
        self.client = httpx.AsyncClient(timeout=30.0, headers={"User-Agent": "ArbRadar/1.0"})
        self._sessions: dict[str, _TradeSessionRecord] = {}
        self._lock = asyncio.Lock()

    async def stop(self) -> None:
        async with self._lock:
            records = list(self._sessions.values())
        for record in records:
            if record.task and not record.task.done():
                record.task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await record.task
        await self.client.aclose()

    async def create_session(self, request: TradeCreateRequest) -> TradeSessionResponse:
        selected_exchanges = request.selected_exchanges or self.settings.enabled_exchange_names
        snapshots = [
            snapshot
            for snapshot in await self.market_store.get_snapshots()
            if snapshot.exchange in selected_exchanges
        ]
        opportunities = build_opportunities(snapshots, self.settings)
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
            pair = select_rankable_pair(symbol_snapshots)
            if pair is not None:
                long_snapshot, short_snapshot = pair
                spread_rate = short_snapshot.funding_rate - long_snapshot.funding_rate
                interval_hours = min(long_snapshot.funding_interval_hours, short_snapshot.funding_interval_hours)
                periods_per_year = (24 / interval_hours) * 365
                price_dislocation_percent = estimate_price_dislocation_percent(long_snapshot, short_snapshot)
                confidence_score, warnings, estimated_slippage_percent = score_opportunity_pair(
                    long_snapshot,
                    short_snapshot,
                    self.settings,
                    price_dislocation_percent,
                )
                round_trip_fee_percent = ((long_snapshot.taker_fee_bps + short_snapshot.taker_fee_bps) * 2) / 100
                base_opportunity = ArbitrageOpportunity(
                    canonical_symbol=long_snapshot.canonical_symbol,
                    base_asset=long_snapshot.base_asset,
                    quote_asset=long_snapshot.quote_asset,
                    long_leg=build_opportunity_leg(long_snapshot),
                    short_leg=build_opportunity_leg(short_snapshot),
                    spread_rate=spread_rate,
                    funding_interval_hours=interval_hours,
                    gross_apr_percent=spread_rate * periods_per_year * 100,
                    net_apr_percent=(
                        spread_rate - (round_trip_fee_percent / 100) - (estimated_slippage_percent / 100)
                    )
                    * periods_per_year
                    * 100,
                    estimated_round_trip_fee_percent=round_trip_fee_percent,
                    estimated_slippage_percent=estimated_slippage_percent,
                    combined_open_interest_usd=combined_open_interest_usd(long_snapshot, short_snapshot),
                    price_dislocation_percent=price_dislocation_percent,
                    max_leg_age_seconds=estimate_max_leg_age_seconds(long_snapshot, short_snapshot),
                    confidence_score=confidence_score,
                    warnings=warnings,
                )
        if base_opportunity is None:
            raise HTTPException(status_code=404, detail="Trade setup not found in the current live exchange scope.")

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

        pair_funding_time = self._pair_funding_time(execution_target)
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
            expected_net_pnl_usd=plan.expected_net_pnl_usd,
            expected_funding_pnl_usd=plan.estimated_funding_pnl_usd,
            estimated_total_fees_usd=plan.estimated_total_fees_usd,
            expected_net_return_on_capital_percent=plan.expected_net_return_on_capital_percent,
            realized_price_pnl_usd=None,
            realized_funding_pnl_usd=None,
            realized_total_fees_usd=None,
            realized_net_pnl_usd=None,
            warnings=warnings,
            events=[
                TradeEvent(
                    at=now,
                    phase="armed",
                    message=f"{request.mode.title()} trade armed for {execution_target.canonical_symbol}. Entry targets {entry_at.isoformat()} and exit targets {exit_at.isoformat()}.",
                )
            ],
            long_leg=self._build_trade_leg(plan.long_leg, execution_target.long_leg.max_leverage, long_live_supported, long_support_note),
            short_leg=self._build_trade_leg(plan.short_leg, execution_target.short_leg.max_leverage, short_live_supported, short_support_note),
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

        return response

    async def get_session(self, session_id: str) -> TradeSessionResponse:
        async with self._lock:
            record = self._sessions.get(session_id)
            if record is None:
                raise HTTPException(status_code=404, detail="Trade session not found.")
            return record.response

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
        return await self.get_session(session_id)

    async def _run_session(self, session_id: str) -> None:
        try:
            record = await self._get_record(session_id)
            await self._sleep_until(record.response.scheduled_entry_at)
            record = await self._get_record(session_id)
            if record.response.status == "cancelled":
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

            await self._update_phase(session_id, status="exiting", phase="Submitting exit orders", message="Exit window opened.")
            if record.request.mode == "paper":
                await self._simulate_exit(session_id)
            else:
                await self._execute_live_exit(session_id)

            await self._update_phase(session_id, status="completed", phase="Trade finished", message="Trade session completed.")
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            await self._mark_failed(session_id, str(exc))
        finally:
            async with self._lock:
                record = self._sessions.get(session_id)
                if record and record.response.status in {"completed", "failed", "cancelled"}:
                    record.credentials = {}

    async def _simulate_entry(self, session_id: str) -> None:
        record = await self._get_record(session_id)
        now = _utcnow()
        record.response.long_leg.status = "submitted"
        record.response.long_leg.entry_order_id = f"paper-entry-{record.response.id}-long"
        record.response.long_leg.raw_entry_response = {
            "mode": "paper",
            "submitted_at": now.isoformat(),
            "simulated": True,
        }
        record.response.short_leg.status = "submitted"
        record.response.short_leg.entry_order_id = f"paper-entry-{record.response.id}-short"
        record.response.short_leg.raw_entry_response = {
            "mode": "paper",
            "submitted_at": now.isoformat(),
            "simulated": True,
        }
        await self._append_event(session_id, "entry", "Paper entry orders were submitted with demo credentials.")
        await asyncio.sleep(1)

        long_entry = self._paper_fill_price(record.response.id, record.plan.long_leg, stage="entry")
        short_entry = self._paper_fill_price(record.response.id, record.plan.short_leg, stage="entry")
        record.response.long_leg.status = "filled"
        record.response.long_leg.entry_fill_price = long_entry
        record.response.long_leg.raw_entry_response = {
            "mode": "paper",
            "filled_at": _utcnow().isoformat(),
            "simulated": True,
            "reference_price": record.plan.long_leg.reference_price,
            "fill_price": long_entry,
        }
        record.response.short_leg.status = "filled"
        record.response.short_leg.entry_fill_price = short_entry
        record.response.short_leg.raw_entry_response = {
            "mode": "paper",
            "filled_at": _utcnow().isoformat(),
            "simulated": True,
            "reference_price": record.plan.short_leg.reference_price,
            "fill_price": short_entry,
        }
        await self._append_event(session_id, "entry", "Paper entry filled with simulated slippage around the live reference prices.")

    async def _simulate_exit(self, session_id: str) -> None:
        record = await self._get_record(session_id)
        now = _utcnow()
        record.response.long_leg.status = "submitted"
        record.response.long_leg.exit_order_id = f"paper-exit-{record.response.id}-long"
        record.response.long_leg.raw_exit_response = {"mode": "paper", "submitted_at": now.isoformat(), "simulated": True}
        record.response.short_leg.status = "submitted"
        record.response.short_leg.exit_order_id = f"paper-exit-{record.response.id}-short"
        record.response.short_leg.raw_exit_response = {"mode": "paper", "submitted_at": now.isoformat(), "simulated": True}
        await self._append_event(session_id, "exit", "Paper exit orders were submitted after the funding window.")
        await asyncio.sleep(1)

        long_exit = self._paper_fill_price(record.response.id, record.plan.long_leg, stage="exit")
        short_exit = self._paper_fill_price(record.response.id, record.plan.short_leg, stage="exit")
        record.response.long_leg.status = "closed"
        record.response.long_leg.exit_fill_price = long_exit
        record.response.long_leg.raw_exit_response = {
            "mode": "paper",
            "closed_at": _utcnow().isoformat(),
            "simulated": True,
            "reference_price": record.plan.long_leg.reference_price,
            "fill_price": long_exit,
        }
        record.response.short_leg.status = "closed"
        record.response.short_leg.exit_fill_price = short_exit
        record.response.short_leg.raw_exit_response = {
            "mode": "paper",
            "closed_at": _utcnow().isoformat(),
            "simulated": True,
            "reference_price": record.plan.short_leg.reference_price,
            "fill_price": short_exit,
        }
        self._apply_realized_paper_results(record)
        await self._append_event(
            session_id,
            "exit",
            f"Paper exit filled. Simulated net result: {record.response.realized_net_pnl_usd:.2f} USD.",
        )

    async def _execute_live_entry(self, session_id: str) -> None:
        record = await self._get_record(session_id)

        try:
            long_response = await self._submit_live_order(
                snapshot=record.long_snapshot,
                credential=record.credentials[record.long_snapshot.exchange],
                leg=record.plan.long_leg,
                leverage=record.plan.long_leg.leverage,
                is_exit=False,
            )
            await self._apply_order_response(session_id, "long", long_response, status="filled")

            short_response = await self._submit_live_order(
                snapshot=record.short_snapshot,
                credential=record.credentials[record.short_snapshot.exchange],
                leg=record.plan.short_leg,
                leverage=record.plan.short_leg.leverage,
                is_exit=False,
            )
            await self._apply_order_response(session_id, "short", short_response, status="filled")
            await self._append_event(session_id, "entry", "Live entry orders were accepted on both exchanges.")
        except Exception:
            await self._attempt_emergency_close(record, "long")
            raise

    async def _execute_live_exit(self, session_id: str) -> None:
        record = await self._get_record(session_id)
        long_response = await self._submit_live_order(
            snapshot=record.long_snapshot,
            credential=record.credentials[record.long_snapshot.exchange],
            leg=record.plan.long_leg,
            leverage=record.plan.long_leg.leverage,
            is_exit=True,
        )
        await self._apply_order_response(session_id, "long", long_response, status="closed", exit_order=True)

        short_response = await self._submit_live_order(
            snapshot=record.short_snapshot,
            credential=record.credentials[record.short_snapshot.exchange],
            leg=record.plan.short_leg,
            leverage=record.plan.short_leg.leverage,
            is_exit=True,
        )
        await self._apply_order_response(session_id, "short", short_response, status="closed", exit_order=True)
        await self._append_event(session_id, "exit", "Live exit orders were accepted on both exchanges.")

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

    @staticmethod
    def _paper_fill_price(session_id: str, leg: ExecutionLegPlan, *, stage: str) -> float:
        ratio = _stable_ratio(session_id, leg.exchange, leg.exchange_symbol, leg.side, stage)
        slippage_bps = (ratio - 0.5) * 10.0
        if stage == "entry":
            directional_bps = slippage_bps if leg.side == "buy" else -slippage_bps
        else:
            directional_bps = -slippage_bps if leg.side == "buy" else slippage_bps
        return max(0.0000001, leg.reference_price * (1 + directional_bps / 10_000))

    @staticmethod
    def _leg_price_pnl(leg: TradeLegExecution) -> float:
        if leg.entry_fill_price is None or leg.exit_fill_price is None:
            return 0.0
        if leg.side == "buy":
            return (leg.exit_fill_price - leg.entry_fill_price) * leg.estimated_quantity
        return (leg.entry_fill_price - leg.exit_fill_price) * leg.estimated_quantity

    def _apply_realized_paper_results(self, record: _TradeSessionRecord) -> None:
        price_pnl = self._leg_price_pnl(record.response.long_leg) + self._leg_price_pnl(record.response.short_leg)
        funding_ratio = 0.985 + (_stable_ratio(record.response.id, "funding") * 0.02)
        realized_funding = record.plan.estimated_funding_pnl_usd * funding_ratio
        realized_fees = record.plan.estimated_total_fees_usd
        record.response.realized_price_pnl_usd = price_pnl
        record.response.realized_funding_pnl_usd = realized_funding
        record.response.realized_total_fees_usd = realized_fees
        record.response.realized_net_pnl_usd = price_pnl + realized_funding - realized_fees

    async def _get_record(self, session_id: str) -> _TradeSessionRecord:
        async with self._lock:
            record = self._sessions.get(session_id)
        if record is None:
            raise HTTPException(status_code=404, detail="Trade session not found.")
        return record

    async def _sleep_until(self, target: datetime | None) -> None:
        if target is None:
            return
        delay = (target - _utcnow()).total_seconds()
        if delay > 0:
            await asyncio.sleep(delay)

    @staticmethod
    def _resolve_snapshot(snapshots: list[FundingSnapshot], canonical_symbol: str, exchange: ExchangeName) -> FundingSnapshot:
        for snapshot in snapshots:
            if snapshot.canonical_symbol.upper() == canonical_symbol.upper() and snapshot.exchange == exchange:
                return snapshot
        raise HTTPException(status_code=404, detail=f"Live snapshot missing for {canonical_symbol} on {exchange}.")

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
