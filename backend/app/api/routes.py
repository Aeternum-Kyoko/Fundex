from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.models.execution import ExecutionPlanResponse
from app.models.market import (
    FundingLeadersResponse,
    FundingSettlementItem,
    FundingSettlementResponse,
    FundingTrendsResponse,
    OpportunitiesResponse,
    OpportunityHistoryResponse,
    SymbolComparisonExchangeSnapshot,
    SymbolComparisonResponse,
)
from app.models.trade import (
    TradeCreateRequest,
    TradeCredentialVerificationRequest,
    TradeCredentialVerificationResponse,
    TradeSessionResponse,
)
from app.services.arbitrage import build_opportunities
from app.services.backtest import BacktestParams
from app.services.strategy import StrategyParams, run_lab
from app.services.execution import build_execution_plan, reverse_opportunity
from app.services.funding_leaders import build_funding_leaders
from app.services.liquidity import depth_profile
from app.services.links import exchange_display_name, exchange_trade_url
from app.services.opportunity_ranker import capture_opportunity, is_snapshot_usable

router = APIRouter()


def _enabled_exchanges(request: Request) -> list[str]:
    return request.app.state.market_engine.enabled_exchange_names()


def _resolved_exchanges(request: Request, exchanges: str | None = None) -> list[str]:
    enabled = _enabled_exchanges(request)
    if not exchanges:
        return enabled

    requested = [item.strip().lower() for item in exchanges.split(",") if item.strip()]
    resolved = [exchange for exchange in enabled if exchange in requested]
    return resolved or enabled


async def _snapshots_for_exchanges(request: Request, exchanges: list[str]) -> list:
    snapshots = await request.app.state.market_store.get_snapshots()
    return [snapshot for snapshot in snapshots if snapshot.exchange in exchanges]


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "phase": "phase-4-monitor"}


@router.get("/system/metrics")
async def system_metrics(request: Request) -> dict:
    return request.app.state.market_engine.metrics()


@router.get("/exchanges/status")
async def exchange_status(request: Request) -> list[dict]:
    statuses = await request.app.state.market_store.get_statuses()
    return [status.model_dump(mode="json") for status in statuses]


@router.get("/arbitrage-opportunities", response_model=OpportunitiesResponse)
async def arbitrage_opportunities(request: Request, exchanges: str | None = None) -> OpportunitiesResponse:
    selected_exchanges = _resolved_exchanges(request, exchanges)
    snapshots = await _snapshots_for_exchanges(request, selected_exchanges)
    opportunities = build_opportunities(snapshots, request.app.state.settings, request.app.state.market_engine.ranking_context)

    return OpportunitiesResponse(
        total=len(opportunities),
        exchanges_in_backend=selected_exchanges,
        frontend_optional_exchanges=[],
        opportunities=opportunities,
    )


@router.get("/exchanges/funding-leaders", response_model=FundingLeadersResponse)
async def exchange_funding_leaders(request: Request, limit: int = 5, exchanges: str | None = None) -> FundingLeadersResponse:
    selected_exchanges = _resolved_exchanges(request, exchanges)
    snapshots = await _snapshots_for_exchanges(request, selected_exchanges)
    resolved_limit = max(1, min(limit, 20))
    return build_funding_leaders(
        snapshots,
        limit=resolved_limit,
        exchanges_to_include=tuple(selected_exchanges),
    )


@router.get("/exchanges/funding-settlements", response_model=FundingSettlementResponse)
async def exchange_funding_settlements(request: Request, limit: int = 12, exchanges: str | None = None) -> FundingSettlementResponse:
    selected_exchanges = _resolved_exchanges(request, exchanges)
    snapshots = await _snapshots_for_exchanges(request, selected_exchanges)
    items = _settlement_items(snapshots, max(1, min(limit, 40)))
    return FundingSettlementResponse(total=len(items), items=items)


@router.get("/exchanges/funding-trends", response_model=FundingTrendsResponse)
async def exchange_funding_trends(
    request: Request,
    symbols: str,
    exchanges: str | None = None,
    limit: int = 16,
) -> FundingTrendsResponse:
    symbol_list = [item.strip().upper() for item in symbols.split(",") if item.strip()]
    exchange_list = _resolved_exchanges(request, exchanges)
    resolved_limit = max(2, min(limit, 32))
    series = await request.app.state.history_store.get_funding_trends(symbol_list, exchange_list, resolved_limit)
    return FundingTrendsResponse(total_series=len(series), series=series)


def _rate_matrix(snapshots: list) -> dict[str, list[dict]]:
    """Every exchange's rate for each coin listed on two or more exchanges (heatmap and settlement calendar)."""
    by_symbol: dict[str, list[dict]] = {}
    for snapshot in snapshots:
        if not is_snapshot_usable(snapshot):
            continue
        by_symbol.setdefault(snapshot.canonical_symbol, []).append(
            {
                "exchange": snapshot.exchange,
                "rate": snapshot.funding_rate,
                "interval_hours": snapshot.funding_interval_hours,
                "next_funding_time": snapshot.next_funding_time.isoformat() if snapshot.next_funding_time else None,
            }
        )
    return {symbol: rows for symbol, rows in by_symbol.items() if len(rows) >= 2}


def _settlement_items(snapshots: list, limit: int) -> list[FundingSettlementItem]:
    now = datetime.now(timezone.utc)
    upcoming = sorted(
        [item for item in snapshots if item.next_funding_time is not None and item.next_funding_time >= now],
        key=lambda item: (item.next_funding_time, -abs(item.funding_rate), item.canonical_symbol, item.exchange),
    )[:limit]
    return [
        FundingSettlementItem(
            exchange=snapshot.exchange,
            display_name=exchange_display_name(snapshot.exchange),
            canonical_symbol=snapshot.canonical_symbol,
            exchange_symbol=snapshot.exchange_symbol,
            funding_rate=snapshot.funding_rate,
            funding_interval_hours=snapshot.funding_interval_hours,
            max_leverage=snapshot.max_leverage,
            next_funding_time=snapshot.next_funding_time,
            mark_price=snapshot.mark_price,
            open_interest_usd=snapshot.open_interest_usd,
            trade_url=exchange_trade_url(snapshot.exchange, snapshot.exchange_symbol),
        )
        for snapshot in upcoming
    ]


@router.get("/symbols")
async def list_symbols(request: Request) -> list[str]:
    """Canonical symbols that currently have usable data, for the Compare picker on any page."""
    snapshots = await _snapshots_for_exchanges(request, _enabled_exchanges(request))
    return sorted({snapshot.canonical_symbol for snapshot in snapshots if is_snapshot_usable(snapshot)})


@router.get("/dashboard")
async def dashboard(request: Request, exchanges: str | None = None) -> dict:
    """Everything the main screen needs in one (gzipped) response."""
    engine = request.app.state.market_engine
    settings = request.app.state.settings
    selected_exchanges = _resolved_exchanges(request, exchanges)
    snapshots = await _snapshots_for_exchanges(request, selected_exchanges)
    opportunities = build_opportunities(snapshots, settings, engine.ranking_context)
    statuses = await request.app.state.market_store.get_statuses()
    leaders = build_funding_leaders(snapshots, limit=8, exchanges_to_include=tuple(selected_exchanges))
    return {
        "version": engine.data_version,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "selected_exchanges": selected_exchanges,
        "available_exchanges": engine.enabled_exchange_names(),
        "holding_horizon_hours": settings.holding_horizon_hours,
        "reference_notional_usd": settings.liquidity_reference_notional_usd,
        "statuses": [status.model_dump(mode="json") for status in statuses],
        "opportunities": [opportunity.model_dump(mode="json") for opportunity in opportunities],
        "leaders": leaders.model_dump(mode="json")["exchanges"],
        "settlements": [item.model_dump(mode="json") for item in _settlement_items(snapshots, 40)],
        "rates": _rate_matrix(snapshots),
    }


@router.get("/stream")
async def stream_changes(request: Request) -> StreamingResponse:
    """Tiny change notifications; clients refetch /dashboard when the version moves."""
    engine = request.app.state.market_engine

    async def event_generator():
        version = -1
        opened = asyncio.get_running_loop().time()
        yield "retry: 3000\n\n"
        # Each connection lives at most 5 minutes; EventSource reconnects on its own. Keeps shutdowns prompt.
        while not await request.is_disconnected() and asyncio.get_running_loop().time() - opened < 300:
            new_version = await engine.wait_for_change(version, timeout=15.0)
            if new_version != version:
                version = new_version
                yield f"event: version\ndata: {json.dumps({'version': version})}\n\n"
            else:
                yield ": keep-alive\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/opportunities/{canonical_symbol}/history", response_model=OpportunityHistoryResponse)
async def opportunity_history(request: Request, canonical_symbol: str, limit: int | None = None) -> OpportunityHistoryResponse:
    resolved_limit = limit or request.app.state.settings.default_history_limit
    points = await request.app.state.history_store.get_opportunity_history(canonical_symbol, resolved_limit)
    return OpportunityHistoryResponse(canonical_symbol=canonical_symbol, total=len(points), points=points)


@router.get("/symbols/{canonical_symbol}/depth")
async def symbol_depth(request: Request, canonical_symbol: str, exchanges: str | None = None) -> dict:
    """Live order-book slippage by trade size on each exchange, and the largest size under 0.1% impact."""
    context = request.app.state.market_engine.ranking_context
    if context.liquidity is None:
        raise HTTPException(status_code=503, detail="Order-book depth is not available.")
    selected = _resolved_exchanges(request, exchanges)
    snapshots = [s for s in await _snapshots_for_exchanges(request, selected) if s.canonical_symbol == canonical_symbol]
    fetcher = context.liquidity._fetcher  # noqa: SLF001

    async def one(snapshot) -> dict | None:
        try:
            book = await asyncio.wait_for(fetcher.fetch(snapshot.exchange, snapshot.exchange_symbol), timeout=12)
        except Exception:
            return None
        profile = depth_profile(book[0], book[1]) if book else None
        if profile is None:
            return None
        return {"exchange": snapshot.exchange, "display_name": exchange_display_name(snapshot.exchange), **profile}

    results = await asyncio.gather(*(one(snapshot) for snapshot in snapshots))
    return {"canonical_symbol": canonical_symbol, "exchanges": [row for row in results if row]}


@router.get("/symbols/{canonical_symbol}/settled")
async def symbol_settled(request: Request, canonical_symbol: str, count: int = 6) -> dict:
    """Predicted rate next to the rates that really settled, per exchange that publishes history."""
    resolver = request.app.state.trade_manager._funding_resolver  # noqa: SLF001
    snapshots = [s for s in await _snapshots_for_exchanges(request, _enabled_exchanges(request)) if s.canonical_symbol == canonical_symbol]
    resolved_count = max(2, min(count, 12))

    async def one(snapshot) -> dict:
        history = await asyncio.wait_for(
            resolver.recent(snapshot.exchange, snapshot.exchange_symbol, snapshot.funding_interval_hours, snapshot.next_funding_time, resolved_count),
            timeout=20,
        )
        return {
            "exchange": snapshot.exchange,
            "display_name": exchange_display_name(snapshot.exchange),
            "predicted_rate": snapshot.funding_rate,
            "interval_hours": snapshot.funding_interval_hours,
            "settled": [{"at": moment.isoformat(), "rate": rate} for moment, rate in history],
        }

    results = await asyncio.gather(*(one(snapshot) for snapshot in snapshots), return_exceptions=True)
    return {"canonical_symbol": canonical_symbol, "exchanges": [row for row in results if isinstance(row, dict)]}


@router.get("/symbols/{canonical_symbol}/comparison", response_model=SymbolComparisonResponse)
async def symbol_comparison(
    request: Request, canonical_symbol: str, exchanges: str | None = None, strategy: str = "hold"
) -> SymbolComparisonResponse:
    selected_exchanges = _resolved_exchanges(request, exchanges)
    snapshots = await _snapshots_for_exchanges(request, selected_exchanges)
    normalized_symbol = canonical_symbol.upper()
    symbol_snapshots = [
        snapshot
        for snapshot in snapshots
        if snapshot.canonical_symbol.upper() == normalized_symbol and is_snapshot_usable(snapshot)
    ]

    if not symbol_snapshots:
        raise HTTPException(status_code=404, detail="Symbol not found in the current live comparison set.")

    opportunities = build_opportunities(snapshots, request.app.state.settings, request.app.state.market_engine.ranking_context)
    best_opportunity = next((item for item in opportunities if item.canonical_symbol.upper() == normalized_symbol), None)
    if strategy == "capture" and best_opportunity is not None:
        best_opportunity = capture_opportunity(
            best_opportunity, snapshots, request.app.state.settings, request.app.state.market_engine.ranking_context
        ) or best_opportunity
    now = datetime.now(timezone.utc)

    comparison_rows = [
        SymbolComparisonExchangeSnapshot(
            exchange=snapshot.exchange,
            display_name=exchange_display_name(snapshot.exchange),
            exchange_symbol=snapshot.exchange_symbol,
            funding_rate=snapshot.funding_rate,
            estimated_funding_rate=snapshot.metadata.get("estimated_funding_rate"),
            funding_interval_hours=snapshot.funding_interval_hours,
            max_leverage=snapshot.max_leverage,
            mark_price=snapshot.mark_price,
            open_interest_usd=snapshot.open_interest_usd,
            volume_24h=snapshot.volume_24h,
            next_funding_time=snapshot.next_funding_time,
            maker_fee_bps=snapshot.maker_fee_bps,
            taker_fee_bps=snapshot.taker_fee_bps,
            trade_url=exchange_trade_url(snapshot.exchange, snapshot.exchange_symbol),
            data_age_seconds=max((now - snapshot.fetched_at).total_seconds(), 0.0),
        )
        for snapshot in sorted(symbol_snapshots, key=lambda item: (item.funding_rate, item.exchange))
    ]

    first = symbol_snapshots[0]
    return SymbolComparisonResponse(
        canonical_symbol=first.canonical_symbol,
        base_asset=first.base_asset,
        quote_asset=first.quote_asset,
        total_exchanges=len(comparison_rows),
        requested_exchanges=selected_exchanges,
        exchanges=comparison_rows,
        best_opportunity=best_opportunity,
    )


@router.get("/telegram/status")
async def telegram_status(request: Request) -> dict:
    return request.app.state.telegram_notifier.status()


@router.get("/telegram/preview")
async def telegram_preview(request: Request) -> dict:
    snapshots = await request.app.state.market_store.get_snapshots()
    opportunities = build_opportunities(snapshots, request.app.state.settings, request.app.state.market_engine.ranking_context)
    batch = request.app.state.telegram_notifier.preview(opportunities)

    if batch is None:
        return {
            "total": 0,
            "message": None,
            "symbols": [],
        }

    return {
        "total": len(batch.opportunities),
        "message": batch.message,
        "symbols": [opportunity.canonical_symbol for opportunity in batch.opportunities],
    }


@router.get("/telegram/daily-summary-preview")
async def telegram_daily_summary_preview(request: Request, summary_key: str | None = None) -> dict:
    snapshots = await request.app.state.market_store.get_snapshots()
    opportunities = build_opportunities(snapshots, request.app.state.settings, request.app.state.market_engine.ranking_context)
    batch = await request.app.state.telegram_notifier.preview_daily_summary(snapshots, opportunities, summary_key=summary_key)

    if batch is None:
        return {
            "ready": False,
            "message": None,
            "local_date": None,
        }

    return {
        "ready": True,
        "message": batch.message,
        "local_date": batch.local_date,
        "summary_key": batch.summary_key,
        "summary_label": batch.summary_label,
        "signature": batch.signature,
    }


@router.get("/telegram/discover-chats")
async def telegram_discover_chats(request: Request) -> dict:
    chats = await request.app.state.telegram_notifier.discover_chats()
    return {
        "total": len(chats),
        "chats": chats,
    }


@router.post("/telegram/test-send")
async def telegram_test_send(request: Request) -> dict:
    return await request.app.state.telegram_notifier.send_test_message()


@router.post("/telegram/demo-alert")
async def telegram_demo_alert(request: Request) -> dict:
    return await request.app.state.telegram_notifier.send_demo_alert()


@router.post("/telegram/send-daily-summary")
async def telegram_send_daily_summary(request: Request, summary_key: str | None = None) -> dict:
    snapshots = await request.app.state.market_store.get_snapshots()
    opportunities = build_opportunities(snapshots, request.app.state.settings, request.app.state.market_engine.ranking_context)
    return await request.app.state.telegram_notifier.send_daily_summary_now(
        snapshots,
        opportunities,
        summary_key=summary_key,
    )


@router.get("/opportunities/{canonical_symbol}/execution-plan", response_model=ExecutionPlanResponse)
async def execution_plan(
    request: Request,
    canonical_symbol: str,
    exchanges: str | None = None,
    notional_usd: float | None = 1000,
    capital_usd: float | None = None,
    leverage: float = 2,
    leverage_overrides: str | None = None,
    holding_periods: int = 3,
    basis_risk_buffer_percent: float = 0.35,
    reverse: bool = False,
    strategy: str = "hold",
) -> ExecutionPlanResponse:
    selected_exchanges = _resolved_exchanges(request, exchanges)
    snapshots = await _snapshots_for_exchanges(request, selected_exchanges)
    opportunities = build_opportunities(snapshots, request.app.state.settings, request.app.state.market_engine.ranking_context)
    opportunity = next((item for item in opportunities if item.canonical_symbol == canonical_symbol), None)
    if opportunity is None:
        raise HTTPException(status_code=404, detail="Opportunity not found in the current filtered set.")

    funding_fraction: float | None = None
    if strategy == "capture":
        captured = capture_opportunity(opportunity, snapshots, request.app.state.settings, request.app.state.market_engine.ranking_context)
        if captured is None or captured.capture is None:
            raise HTTPException(status_code=404, detail="No next-settlement setup for this coin right now.")
        opportunity = captured
        # Reversing swaps the legs, which negates every settlement payment.
        funding_fraction = (captured.capture.capture_percent / 100) * (-1 if reverse else 1)
        holding_periods = 1

    execution_target = reverse_opportunity(opportunity) if reverse else opportunity
    parsed_leverage_overrides: dict[str, float] | None = None
    if leverage_overrides:
        try:
            raw_payload = json.loads(leverage_overrides)
            if not isinstance(raw_payload, dict):
                raise ValueError("leverage_overrides must be a JSON object.")
            parsed_leverage_overrides = {}
            for key, value in raw_payload.items():
                if not isinstance(key, str) or not isinstance(value, (int, float)):
                    raise ValueError("leverage_overrides must contain numeric leverage values keyed by exchange.")
                parsed_leverage_overrides[key.lower()] = float(value)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    return build_execution_plan(
        execution_target,
        notional_usd=notional_usd,
        capital_usd=capital_usd,
        leverage=leverage,
        leverage_overrides=parsed_leverage_overrides,
        holding_periods=holding_periods,
        basis_risk_buffer_percent=basis_risk_buffer_percent,
        scenario="reverse" if reverse else "best",
        funding_fraction_override=funding_fraction,
    )


@router.post("/trade/sessions", response_model=TradeSessionResponse)
async def create_trade_session(request: Request, payload: TradeCreateRequest) -> TradeSessionResponse:
    return await request.app.state.trade_manager.create_session(payload)


@router.post("/trade/verify-credentials", response_model=TradeCredentialVerificationResponse)
async def verify_trade_credentials(
    request: Request,
    payload: TradeCredentialVerificationRequest,
) -> TradeCredentialVerificationResponse:
    return await request.app.state.trade_manager.verify_credentials(payload)


class BacktestRequest(BaseModel):
    days: int = Field(30, ge=1, le=90)
    notional_usd: float = Field(1000, gt=0, le=1_000_000)
    binance_taker_bps: float = Field(5, ge=0, le=20)
    delta_taker_bps: float = Field(5, ge=0, le=20)
    slippage_percent_per_leg: float = Field(0.1, ge=0, le=2)
    min_net_percent: float = Field(0, ge=-1, le=5)


@router.get("/backtest")
async def backtest_state(request: Request) -> dict:
    return request.app.state.backtest.state()


@router.post("/backtest/run")
async def backtest_run(request: Request, payload: BacktestRequest) -> dict:
    """Downloads settled funding history (cached) and replays next-settlement captures."""
    snapshots = await request.app.state.market_store.get_snapshots()
    started = request.app.state.backtest.start(BacktestParams(**payload.model_dump()), snapshots)
    if not started:
        raise HTTPException(status_code=409, detail="A backtest is already running.")
    return request.app.state.backtest.state()


@router.post("/backtest/resimulate")
async def backtest_resimulate(request: Request, payload: BacktestRequest) -> dict:
    """Instant re-run with different fees or thresholds on the history already downloaded."""
    result = request.app.state.backtest.resimulate(BacktestParams(**payload.model_dump()))
    if result is None:
        raise HTTPException(status_code=409, detail="Run a backtest first to download the history.")
    return {"params": payload.model_dump(), "result": result}


class StrategyRequest(BaseModel):
    days: int = Field(30, ge=1, le=90)
    notional_usd: float = Field(1000, gt=0, le=1_000_000)
    binance_taker_bps: float = Field(5, ge=0, le=20)
    delta_taker_bps: float = Field(5, ge=0, le=20)
    slippage_percent_per_leg: float = Field(0.1, ge=0, le=2)
    lookback: int = Field(3, ge=1, le=24)
    entry_apr_percent: float = Field(20, ge=0, le=1000)
    exit_apr_percent: float = Field(5, ge=-500, le=1000)
    max_positions: int = Field(5, ge=1, le=50)


@router.post("/backtest/strategy")
async def backtest_strategy(request: Request, payload: StrategyRequest) -> dict:
    """Strategy lab: replays the carry rules on the downloaded history, with a walk-forward search and levers."""
    backtest = request.app.state.backtest
    series = backtest.series()
    if not series:
        raise HTTPException(status_code=409, detail="Download the funding history first.")
    if payload.exit_apr_percent >= payload.entry_apr_percent:
        raise HTTPException(status_code=422, detail="The exit level must be below the entry level.")
    days = min(payload.days, backtest.history_days)
    end = int(datetime.now(timezone.utc).timestamp())
    params = StrategyParams(**{**payload.model_dump(), "days": days})
    # The threshold search runs a few hundred replays; keep it off the event loop.
    return await asyncio.to_thread(run_lab, series, params, end - days * 86400, end)


class StrategyBotRequest(BaseModel):
    enabled: bool
    mode: str = "paper"
    leverage: float = Field(2, ge=1, le=10)
    params: StrategyRequest


@router.get("/strategy/bot")
async def strategy_bot_state(request: Request) -> dict:
    """The paper strategy bot: its rules, open positions, settled results and decision log."""
    return await request.app.state.strategy_bot.state()


@router.put("/strategy/bot")
async def strategy_bot_configure(request: Request, payload: StrategyBotRequest) -> dict:
    if payload.params.exit_apr_percent >= payload.params.entry_apr_percent:
        raise HTTPException(status_code=422, detail="The exit level must be below the entry level.")
    try:
        await request.app.state.strategy_bot.configure(
            enabled=payload.enabled, mode=payload.mode, leverage=payload.leverage, params=StrategyParams(**payload.params.model_dump())
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return await request.app.state.strategy_bot.state()


@router.post("/strategy/bot/check")
async def strategy_bot_check(request: Request) -> dict:
    """Run a decision round now instead of waiting for the next hour."""
    bot = request.app.state.strategy_bot
    try:
        summary = await bot.tick()
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"summary": summary, **(await bot.state())}


@router.post("/strategy/bot/positions/{session_id}/close")
async def strategy_bot_close(request: Request, session_id: str) -> dict:
    await request.app.state.trade_manager.close_carry(session_id, "closed by hand")
    return await request.app.state.strategy_bot.state()


@router.get("/trade/journal", response_model=list[TradeSessionResponse])
async def trade_journal(request: Request, mode: str | None = None, limit: int = 500) -> list[TradeSessionResponse]:
    """Every paper and live trade, newest first, with predicted vs actual funding, fees and slippage."""
    resolved_mode = mode if mode in {"paper", "live"} else None
    return await request.app.state.trade_manager.list_journal(limit=max(1, min(limit, 2000)), mode=resolved_mode)


@router.get("/trade/sessions/{session_id}", response_model=TradeSessionResponse)
async def get_trade_session(request: Request, session_id: str) -> TradeSessionResponse:
    return await request.app.state.trade_manager.get_session(session_id)


@router.post("/trade/sessions/{session_id}/cancel", response_model=TradeSessionResponse)
async def cancel_trade_session(request: Request, session_id: str) -> TradeSessionResponse:
    return await request.app.state.trade_manager.cancel_session(session_id)
