from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, Field


ExchangeName = Literal["binance", "delta", "coindcx", "coinswitch"]


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class FundingSnapshot(BaseModel):
    exchange: ExchangeName
    exchange_symbol: str
    canonical_symbol: str
    base_asset: str
    quote_asset: str = "USDT"
    instrument_type: Literal["perpetual"] = "perpetual"
    funding_rate: float
    funding_interval_hours: int = 8
    mark_price: float | None = None
    index_price: float | None = None
    open_interest: float | None = None
    open_interest_usd: float | None = None
    volume_24h: float | None = None
    next_funding_time: datetime | None = None
    maker_fee_bps: float
    taker_fee_bps: float
    fetched_at: datetime = Field(default_factory=utc_now)
    metadata: dict[str, Any] = Field(default_factory=dict)


class ExchangeStatus(BaseModel):
    exchange: ExchangeName
    display_name: str
    enabled: bool = True
    configured: bool = True
    healthy: bool = False
    last_success_at: datetime | None = None
    last_error: str | None = None
    snapshot_count: int = 0


class OpportunityLeg(BaseModel):
    exchange: ExchangeName
    display_name: str
    exchange_symbol: str
    funding_rate: float
    mark_price: float | None = None
    open_interest_usd: float | None = None
    volume_24h: float | None = None
    taker_fee_bps: float
    next_funding_time: datetime | None = None
    trade_url: str
    best_bid_size: float | None = None
    best_ask_size: float | None = None


class ArbitrageOpportunity(BaseModel):
    canonical_symbol: str
    base_asset: str
    quote_asset: str
    long_leg: OpportunityLeg
    short_leg: OpportunityLeg
    spread_rate: float
    funding_interval_hours: int
    gross_apr_percent: float
    net_apr_percent: float
    estimated_round_trip_fee_percent: float
    estimated_slippage_percent: float
    combined_open_interest_usd: float | None = None
    price_dislocation_percent: float | None = None
    confidence_score: float
    warnings: list[str] = Field(default_factory=list)
    updated_at: datetime = Field(default_factory=utc_now)


class OpportunitiesResponse(BaseModel):
    phase: Literal["monitor-only"] = "monitor-only"
    total: int
    exchanges_in_backend: list[ExchangeName]
    frontend_optional_exchanges: list[ExchangeName]
    opportunities: list[ArbitrageOpportunity]


class OpportunityHistoryPoint(BaseModel):
    recorded_at: datetime
    net_apr_percent: float
    gross_apr_percent: float
    spread_rate: float
    confidence_score: float


class OpportunityHistoryResponse(BaseModel):
    canonical_symbol: str
    total: int
    points: list[OpportunityHistoryPoint]
