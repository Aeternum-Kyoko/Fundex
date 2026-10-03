from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, Field


ExchangeName = Literal["binance", "delta", "coindcx", "coinswitch", "wazirx"]


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
    max_leverage: float | None = None
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


class TrustCheck(BaseModel):
    key: str
    label: str
    status: Literal["pass", "warn", "fail", "info"]
    detail: str


class CaptureLeg(BaseModel):
    exchange: ExchangeName
    display_name: str
    exchange_symbol: str
    funding_rate: float
    funding_interval_hours: int
    next_funding_time: datetime | None = None
    settles_in_window: bool
    # Funding this leg pays you at the captured settlement, as a fraction of notional (negative = you pay).
    payment: float
    taker_fee_bps: float
    slippage_round_trip_percent: float
    slippage_measured: bool
    trade_url: str


class CaptureSetup(BaseModel):
    """Enter just before the next settlement, collect it, exit right after."""

    settles_at: datetime
    long_leg: CaptureLeg
    short_leg: CaptureLeg
    settling: Literal["both", "long", "short"]
    capture_percent: float
    fee_percent: float
    slippage_percent: float
    cost_percent: float
    net_percent: float
    data_trust_level: Literal["high", "medium", "low"]


class OpportunityLeg(BaseModel):
    exchange: ExchangeName
    display_name: str
    exchange_symbol: str
    funding_rate: float
    max_leverage: float | None = None
    mark_price: float | None = None
    open_interest_usd: float | None = None
    volume_24h: float | None = None
    taker_fee_bps: float
    next_funding_time: datetime | None = None
    funding_interval_hours: int | None = None
    funding_rate_hourly: float | None = None
    interval_source: str | None = None
    # Order-book cost to enter and exit `reference_notional_usd` on this leg, % of notional (None = not measured).
    slippage_round_trip_percent: float | None = None
    depth_fillable: bool | None = None
    depth_measured_at: datetime | None = None
    top_of_book_spread_percent: float | None = None
    trade_url: str
    best_bid_size: float | None = None
    best_ask_size: float | None = None


class ArbitrageOpportunity(BaseModel):
    canonical_symbol: str
    base_asset: str
    quote_asset: str
    long_leg: OpportunityLeg
    short_leg: OpportunityLeg
    # Spread expressed per 8 hours after normalising each leg to an hourly rate, so legs on
    # different funding intervals are comparable. Raw per-settlement rates live on the legs.
    spread_rate: float
    spread_rate_hourly: float = 0.0
    # Shortest settlement interval of the two legs (kept for display/back-compat).
    funding_interval_hours: int
    # Steady-state annualised funding edge before any costs.
    gross_apr_percent: float
    # Annualised net return when holding for `holding_horizon_hours`, paying entry+exit costs once.
    net_apr_percent: float
    # Taker fees for entry and exit on both legs, as % of one leg's notional.
    estimated_round_trip_fee_percent: float
    # Estimated slippage per leg (entry + exit), as % of that leg's notional.
    estimated_slippage_percent: float
    # Fees + slippage on both legs, as % of one leg's notional. Paid once per trade.
    estimated_total_cost_percent: float = 0.0
    holding_horizon_hours: int = 168
    # Funding collected over the horizon from the actual settlement schedule of each leg, assuming
    # current predicted rates persist.
    expected_funding_percent: float = 0.0
    net_return_percent: float = 0.0
    # Hours until cumulative funding covers total costs (None when it never does within 30 days).
    break_even_hours: float | None = None
    # "orderbook" when both legs were measured on live books, "mixed" for one, "estimate" otherwise.
    slippage_source: Literal["orderbook", "mixed", "estimate"] = "estimate"
    reference_notional_usd: float = 0.0
    trust_level: Literal["high", "medium", "low"] = "medium"
    trust_checks: list[TrustCheck] = Field(default_factory=list)
    # Best single-settlement capture for this coin (may use a different pair than the hold setup above).
    capture: CaptureSetup | None = None
    combined_open_interest_usd: float | None = None
    price_dislocation_percent: float | None = None
    max_leg_age_seconds: float | None = None
    confidence_score: float
    warnings: list[str] = Field(default_factory=list)
    updated_at: datetime = Field(default_factory=utc_now)


class OpportunitiesResponse(BaseModel):
    phase: Literal["monitor-only"] = "monitor-only"
    total: int
    exchanges_in_backend: list[ExchangeName]
    frontend_optional_exchanges: list[ExchangeName]
    opportunities: list[ArbitrageOpportunity]


class FundingLeader(BaseModel):
    exchange: ExchangeName
    display_name: str
    canonical_symbol: str
    exchange_symbol: str
    base_asset: str
    funding_rate: float
    funding_interval_hours: int = 8
    max_leverage: float | None = None
    next_funding_time: datetime | None = None
    mark_price: float | None = None
    open_interest_usd: float | None = None
    trade_url: str


class ExchangeFundingLeaders(BaseModel):
    exchange: ExchangeName
    display_name: str
    top_positive: list[FundingLeader]
    top_negative: list[FundingLeader]


class FundingLeadersResponse(BaseModel):
    total_exchanges: int
    exchanges: list[ExchangeFundingLeaders]


class FundingSettlementItem(BaseModel):
    exchange: ExchangeName
    display_name: str
    canonical_symbol: str
    exchange_symbol: str
    funding_rate: float
    funding_interval_hours: int
    max_leverage: float | None = None
    next_funding_time: datetime | None = None
    mark_price: float | None = None
    open_interest_usd: float | None = None
    trade_url: str


class FundingSettlementResponse(BaseModel):
    total: int
    items: list[FundingSettlementItem]


class FundingTrendPoint(BaseModel):
    recorded_at: datetime
    funding_rate: float


class FundingTrendSeries(BaseModel):
    canonical_symbol: str
    exchange: ExchangeName
    points: list[FundingTrendPoint]


class FundingTrendsResponse(BaseModel):
    total_series: int
    series: list[FundingTrendSeries]


class SymbolComparisonExchangeSnapshot(BaseModel):
    exchange: ExchangeName
    display_name: str
    exchange_symbol: str
    funding_rate: float
    estimated_funding_rate: float | None = None
    funding_interval_hours: int
    max_leverage: float | None = None
    mark_price: float | None = None
    open_interest_usd: float | None = None
    volume_24h: float | None = None
    next_funding_time: datetime | None = None
    maker_fee_bps: float
    taker_fee_bps: float
    trade_url: str
    data_age_seconds: float | None = None


class SymbolComparisonResponse(BaseModel):
    canonical_symbol: str
    base_asset: str
    quote_asset: str
    total_exchanges: int
    requested_exchanges: list[ExchangeName] = Field(default_factory=list)
    exchanges: list[SymbolComparisonExchangeSnapshot]
    best_opportunity: ArbitrageOpportunity | None = None


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
