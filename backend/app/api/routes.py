from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from app.models.execution import ExecutionPlanResponse
from app.models.market import OpportunitiesResponse, OpportunityHistoryResponse
from app.services.arbitrage import build_opportunities
from app.services.execution import build_execution_plan

router = APIRouter()


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "phase": "phase-4-monitor"}


@router.get("/exchanges/status")
async def exchange_status(request: Request) -> list[dict]:
    statuses = await request.app.state.market_store.get_statuses()
    return [status.model_dump(mode="json") for status in statuses]


@router.get("/arbitrage-opportunities", response_model=OpportunitiesResponse)
async def arbitrage_opportunities(request: Request) -> OpportunitiesResponse:
    snapshots = await request.app.state.market_store.get_snapshots(include_exchanges={"binance", "delta"})
    opportunities = build_opportunities(snapshots, request.app.state.settings)

    return OpportunitiesResponse(
        total=len(opportunities),
        exchanges_in_backend=["binance", "delta"],
        frontend_optional_exchanges=[],
        opportunities=opportunities,
    )


@router.get("/stream")
async def stream_opportunities(request: Request) -> StreamingResponse:
    async def event_generator():
        while True:
            if await request.is_disconnected():
                break

            snapshots = await request.app.state.market_store.get_snapshots(include_exchanges={"binance", "delta"})
            opportunities = build_opportunities(snapshots, request.app.state.settings)
            payload = OpportunitiesResponse(
                total=len(opportunities),
                exchanges_in_backend=["binance", "delta"],
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


@router.get("/telegram/status")
async def telegram_status(request: Request) -> dict:
    return request.app.state.telegram_notifier.status()


@router.get("/telegram/preview")
async def telegram_preview(request: Request) -> dict:
    snapshots = await request.app.state.market_store.get_snapshots(include_exchanges={"binance", "delta"})
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
    snapshots = await request.app.state.market_store.get_snapshots(include_exchanges={"binance", "delta"})
    opportunities = build_opportunities(snapshots, request.app.state.settings)
    opportunity = next((item for item in opportunities if item.canonical_symbol == canonical_symbol), None)
    if opportunity is None:
        from fastapi import HTTPException

        raise HTTPException(status_code=404, detail="Opportunity not found in the current filtered set.")

    return build_execution_plan(
        opportunity,
        notional_usd=notional_usd,
        leverage=leverage,
        holding_periods=holding_periods,
        basis_risk_buffer_percent=basis_risk_buffer_percent,
    )
