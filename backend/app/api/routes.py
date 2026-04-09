from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from app.models.execution import ExecutionPlanResponse
from app.models.market import (
    FundingLeadersResponse,
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

router = APIRouter()


def _enabled_exchanges(request: Request) -> list[str]:
    return request.app.state.settings.enabled_exchange_names


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
async def arbitrage_opportunities(request: Request) -> OpportunitiesResponse:
    snapshots = await request.app.state.market_store.get_snapshots()
    opportunities = build_opportunities(snapshots, request.app.state.settings)
    enabled_exchanges = _enabled_exchanges(request)

    return OpportunitiesResponse(
        total=len(opportunities),
        exchanges_in_backend=enabled_exchanges,
        frontend_optional_exchanges=[],
        opportunities=opportunities,
    )


@router.get("/exchanges/funding-leaders", response_model=FundingLeadersResponse)
async def exchange_funding_leaders(request: Request, limit: int = 5) -> FundingLeadersResponse:
    snapshots = await request.app.state.market_store.get_snapshots()
    resolved_limit = max(1, min(limit, 20))
    return build_funding_leaders(
        snapshots,
        limit=resolved_limit,
        exchanges_to_include=tuple(_enabled_exchanges(request)),
    )


@router.get("/exchanges/funding-trends", response_model=FundingTrendsResponse)
async def exchange_funding_trends(
    request: Request,
    symbols: str,
    exchanges: str | None = None,
    limit: int = 16,
) -> FundingTrendsResponse:
    symbol_list = [item.strip().upper() for item in symbols.split(",") if item.strip()]
    raw_exchanges = exchanges or ",".join(_enabled_exchanges(request))
    exchange_list = [item.strip().lower() for item in raw_exchanges.split(",") if item.strip()]
    resolved_limit = max(2, min(limit, 32))
    series = await request.app.state.history_store.get_funding_trends(symbol_list, exchange_list, resolved_limit)
    return FundingTrendsResponse(total_series=len(series), series=series)


@router.get("/stream")
async def stream_opportunities(request: Request) -> StreamingResponse:
    async def event_generator():
        while True:
            if await request.is_disconnected():
                break

            snapshots = await request.app.state.market_store.get_snapshots()
            opportunities = build_opportunities(snapshots, request.app.state.settings)
            enabled_exchanges = _enabled_exchanges(request)
            payload = OpportunitiesResponse(
                total=len(opportunities),
                exchanges_in_backend=enabled_exchanges,
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
async def symbol_comparison(request: Request, canonical_symbol: str) -> SymbolComparisonResponse:
    snapshots = await request.app.state.market_store.get_snapshots()
    normalized_symbol = canonical_symbol.upper()
    symbol_snapshots = [snapshot for snapshot in snapshots if snapshot.canonical_symbol.upper() == normalized_symbol]

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


@router.get("/opportunities/{canonical_symbol}/execution-plan", response_model=ExecutionPlanResponse)
async def execution_plan(
    request: Request,
    canonical_symbol: str,
    notional_usd: float = 1000,
    leverage: float = 2,
    holding_periods: int = 3,
    basis_risk_buffer_percent: float = 0.35,
) -> ExecutionPlanResponse:
    snapshots = await request.app.state.market_store.get_snapshots()
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
