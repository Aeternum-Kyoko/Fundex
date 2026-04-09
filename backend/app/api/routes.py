from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

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
from app.services.arbitrage import build_opportunities
from app.services.execution import build_execution_plan
from app.services.funding_leaders import build_funding_leaders
from app.services.links import exchange_display_name, exchange_trade_url
from app.services.opportunity_ranker import is_snapshot_usable

router = APIRouter()


def _enabled_exchanges(request: Request) -> list[str]:
    return request.app.state.settings.enabled_exchange_names


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
    opportunities = build_opportunities(snapshots, request.app.state.settings)

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
    now = datetime.now(timezone.utc)
    resolved_limit = max(1, min(limit, 40))
    items = [
        FundingSettlementItem(
            exchange=snapshot.exchange,
            display_name=exchange_display_name(snapshot.exchange),
            canonical_symbol=snapshot.canonical_symbol,
            exchange_symbol=snapshot.exchange_symbol,
            funding_rate=snapshot.funding_rate,
            funding_interval_hours=snapshot.funding_interval_hours,
            next_funding_time=snapshot.next_funding_time,
            mark_price=snapshot.mark_price,
            open_interest_usd=snapshot.open_interest_usd,
            trade_url=exchange_trade_url(snapshot.exchange, snapshot.exchange_symbol),
        )
        for snapshot in sorted(
            [item for item in snapshots if item.next_funding_time is not None and item.next_funding_time >= now],
            key=lambda item: (item.next_funding_time or datetime.max.replace(tzinfo=timezone.utc), -abs(item.funding_rate), item.canonical_symbol, item.exchange),
        )[:resolved_limit]
    ]
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


@router.get("/stream")
async def stream_opportunities(request: Request) -> StreamingResponse:
    async def event_generator():
        while True:
            if await request.is_disconnected():
                break

            selected_exchanges = _resolved_exchanges(request, request.query_params.get("exchanges"))
            snapshots = await _snapshots_for_exchanges(request, selected_exchanges)
            opportunities = build_opportunities(snapshots, request.app.state.settings)
            payload = OpportunitiesResponse(
                total=len(opportunities),
                exchanges_in_backend=selected_exchanges,
                frontend_optional_exchanges=[],
                opportunities=opportunities,
            )

            yield f"data: {json.dumps(payload.model_dump(mode='json'))}\n\n"
            await asyncio.sleep(5)

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@router.get("/opportunities/{canonical_symbol}/history", response_model=OpportunityHistoryResponse)
async def opportunity_history(request: Request, canonical_symbol: str, limit: int | None = None) -> OpportunityHistoryResponse:
    resolved_limit = limit or request.app.state.settings.default_history_limit
    points = await request.app.state.history_store.get_opportunity_history(canonical_symbol, resolved_limit)
    return OpportunityHistoryResponse(canonical_symbol=canonical_symbol, total=len(points), points=points)


@router.get("/symbols/{canonical_symbol}/comparison", response_model=SymbolComparisonResponse)
async def symbol_comparison(request: Request, canonical_symbol: str, exchanges: str | None = None) -> SymbolComparisonResponse:
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

    opportunities = build_opportunities(snapshots, request.app.state.settings)
    best_opportunity = next((item for item in opportunities if item.canonical_symbol.upper() == normalized_symbol), None)
    now = datetime.now(timezone.utc)

    comparison_rows = [
        SymbolComparisonExchangeSnapshot(
            exchange=snapshot.exchange,
            display_name=exchange_display_name(snapshot.exchange),
            exchange_symbol=snapshot.exchange_symbol,
            funding_rate=snapshot.funding_rate,
            estimated_funding_rate=snapshot.metadata.get("estimated_funding_rate"),
            funding_interval_hours=snapshot.funding_interval_hours,
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
    opportunities = build_opportunities(snapshots, request.app.state.settings)
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
    opportunities = build_opportunities(snapshots, request.app.state.settings)
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
    opportunities = build_opportunities(snapshots, request.app.state.settings)
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
    notional_usd: float = 1000,
    leverage: float = 2,
    holding_periods: int = 3,
    basis_risk_buffer_percent: float = 0.35,
) -> ExecutionPlanResponse:
    selected_exchanges = _resolved_exchanges(request, exchanges)
    snapshots = await _snapshots_for_exchanges(request, selected_exchanges)
    opportunities = build_opportunities(snapshots, request.app.state.settings)
    opportunity = next((item for item in opportunities if item.canonical_symbol == canonical_symbol), None)
    if opportunity is None:
        raise HTTPException(status_code=404, detail="Opportunity not found in the current filtered set.")

    return build_execution_plan(
        opportunity,
        notional_usd=notional_usd,
        leverage=leverage,
        holding_periods=holding_periods,
        basis_risk_buffer_percent=basis_risk_buffer_percent,
    )
