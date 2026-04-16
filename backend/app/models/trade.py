from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

from app.models.market import ExchangeName


TradeMode = Literal["paper", "live"]
TradeScenario = Literal["best", "reverse"]
TradeSessionStatus = Literal["armed", "entering", "entered", "exiting", "completed", "failed", "cancelled"]
TradeLegStatus = Literal["pending", "submitted", "filled", "closed", "failed", "skipped"]


class TradeScheduleRequest(BaseModel):
    entry_seconds_before_funding: int = 30
    exit_seconds_after_funding: int = 15


class TradeCredentialInput(BaseModel):
    exchange: ExchangeName
    api_key: str
    api_secret: str
    extra: dict[str, str] = Field(default_factory=dict)


class TradeCreateRequest(BaseModel):
    canonical_symbol: str
    selected_exchanges: list[ExchangeName] = Field(default_factory=list)
    mode: TradeMode = "paper"
    scenario: TradeScenario = "best"
    capital_usd: float = 1000
    leverage: float = 2
    leverage_overrides: dict[ExchangeName, float] = Field(default_factory=dict)
    holding_periods: int = 1
    basis_risk_buffer_percent: float = 0.35
    schedule: TradeScheduleRequest = Field(default_factory=TradeScheduleRequest)
    credentials: list[TradeCredentialInput] = Field(default_factory=list)


class TradeEvent(BaseModel):
    at: datetime
    phase: str
    message: str
    level: Literal["info", "warning", "error"] = "info"


class TradeLegExecution(BaseModel):
    exchange: ExchangeName
    display_name: str
    exchange_symbol: str
    side: Literal["buy", "sell"]
    reference_price: float
    estimated_quantity: float
    leverage: float
    max_leverage: float | None = None
    notional_usd: float
    initial_margin_usd: float
    trade_url: str
    live_supported: bool = False
    support_note: str | None = None
    status: TradeLegStatus = "pending"
    entry_order_id: str | None = None
    exit_order_id: str | None = None
    entry_fill_price: float | None = None
    exit_fill_price: float | None = None
    raw_entry_response: dict[str, Any] | None = None
    raw_exit_response: dict[str, Any] | None = None


class TradeSessionResponse(BaseModel):
    id: str
    canonical_symbol: str
    mode: TradeMode
    scenario: TradeScenario
    status: TradeSessionStatus
    current_phase: str
    created_at: datetime
    updated_at: datetime
    pair_funding_time: datetime | None = None
    scheduled_entry_at: datetime | None = None
    scheduled_exit_at: datetime | None = None
    cancellable_until: datetime | None = None
    capital_input_usd: float
    leverage: float
    holding_periods: int
    expected_net_pnl_usd: float
    expected_funding_pnl_usd: float
    estimated_total_fees_usd: float
    expected_net_return_on_capital_percent: float
    realized_price_pnl_usd: float | None = None
    realized_funding_pnl_usd: float | None = None
    realized_total_fees_usd: float | None = None
    realized_net_pnl_usd: float | None = None
    warnings: list[str] = Field(default_factory=list)
    events: list[TradeEvent] = Field(default_factory=list)
    long_leg: TradeLegExecution
    short_leg: TradeLegExecution
