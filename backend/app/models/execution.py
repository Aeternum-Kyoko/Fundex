from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class ExecutionLegPlan(BaseModel):
    exchange: str
    display_name: str
    exchange_symbol: str
    side: Literal["buy", "sell"]
    reference_price: float
    notional_usd: float
    estimated_quantity: float
    leverage: float
    initial_margin_usd: float
    taker_fee_percent: float
    estimated_entry_fee_usd: float
    estimated_exit_fee_usd: float
    trade_url: str


class ExecutionPlanResponse(BaseModel):
    phase: Literal["phase-2-dry-run"] = "phase-2-dry-run"
    canonical_symbol: str
    notional_usd: float
    leverage: float
    holding_periods: int
    capital_required_usd: float
    estimated_total_fees_usd: float
    estimated_total_slippage_usd: float
    estimated_funding_pnl_usd: float
    estimated_basis_risk_reserve_usd: float
    expected_net_pnl_usd: float
    expected_net_return_on_capital_percent: float
    confidence_score: float
    warnings: list[str] = Field(default_factory=list)
    entry_steps: list[str] = Field(default_factory=list)
    exit_rules: list[str] = Field(default_factory=list)
    long_leg: ExecutionLegPlan
    short_leg: ExecutionLegPlan
