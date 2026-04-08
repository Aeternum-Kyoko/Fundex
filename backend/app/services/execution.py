from __future__ import annotations

from fastapi import HTTPException

from app.models.execution import ExecutionLegPlan, ExecutionPlanResponse
from app.models.market import ArbitrageOpportunity


def _build_leg_plan(
    *,
    side: str,
    display_name: str,
    exchange: str,
    exchange_symbol: str,
    reference_price: float | None,
    notional_usd: float,
    leverage: float,
    taker_fee_bps: float,
    trade_url: str,
) -> ExecutionLegPlan:
    if not reference_price or reference_price <= 0:
        raise HTTPException(status_code=400, detail=f"Missing usable mark price for {display_name}.")

    entry_fee_usd = notional_usd * (taker_fee_bps / 10_000)
    exit_fee_usd = notional_usd * (taker_fee_bps / 10_000)
    return ExecutionLegPlan(
        exchange=exchange,
        display_name=display_name,
        exchange_symbol=exchange_symbol,
        side=side,  # type: ignore[arg-type]
        reference_price=reference_price,
        notional_usd=notional_usd,
        estimated_quantity=notional_usd / reference_price,
        leverage=leverage,
        initial_margin_usd=notional_usd / leverage,
        taker_fee_percent=taker_fee_bps / 100,
        estimated_entry_fee_usd=entry_fee_usd,
        estimated_exit_fee_usd=exit_fee_usd,
        trade_url=trade_url,
    )


def build_execution_plan(
    opportunity: ArbitrageOpportunity,
    *,
    notional_usd: float,
    leverage: float,
    holding_periods: int,
    basis_risk_buffer_percent: float,
) -> ExecutionPlanResponse:
    if notional_usd <= 0:
        raise HTTPException(status_code=400, detail="notional_usd must be positive.")
    if leverage < 1:
        raise HTTPException(status_code=400, detail="leverage must be at least 1.")
    if holding_periods < 1:
        raise HTTPException(status_code=400, detail="holding_periods must be at least 1.")

    long_leg = _build_leg_plan(
        side="buy",
        display_name=opportunity.long_leg.display_name,
        exchange=opportunity.long_leg.exchange,
        exchange_symbol=opportunity.long_leg.exchange_symbol,
        reference_price=opportunity.long_leg.mark_price,
        notional_usd=notional_usd,
        leverage=leverage,
        taker_fee_bps=opportunity.long_leg.taker_fee_bps,
        trade_url=opportunity.long_leg.trade_url,
    )
    short_leg = _build_leg_plan(
        side="sell",
        display_name=opportunity.short_leg.display_name,
        exchange=opportunity.short_leg.exchange,
        exchange_symbol=opportunity.short_leg.exchange_symbol,
        reference_price=opportunity.short_leg.mark_price,
        notional_usd=notional_usd,
        leverage=leverage,
        taker_fee_bps=opportunity.short_leg.taker_fee_bps,
        trade_url=opportunity.short_leg.trade_url,
    )

    estimated_total_fees_usd = (
        long_leg.estimated_entry_fee_usd
        + long_leg.estimated_exit_fee_usd
        + short_leg.estimated_entry_fee_usd
        + short_leg.estimated_exit_fee_usd
    )
    estimated_total_slippage_usd = (opportunity.estimated_slippage_percent / 100) * (notional_usd * 2)
    estimated_funding_pnl_usd = opportunity.spread_rate * notional_usd * holding_periods
    estimated_basis_risk_reserve_usd = (basis_risk_buffer_percent / 100) * (notional_usd * 2)
    capital_required_usd = long_leg.initial_margin_usd + short_leg.initial_margin_usd + estimated_total_fees_usd
    expected_net_pnl_usd = (
        estimated_funding_pnl_usd
        - estimated_total_fees_usd
        - estimated_total_slippage_usd
        - estimated_basis_risk_reserve_usd
    )
    expected_net_return_on_capital_percent = (
        (expected_net_pnl_usd / capital_required_usd) * 100 if capital_required_usd > 0 else 0.0
    )

    entry_steps = [
        f"Open the hedge with matched ${notional_usd:,.2f} notionals on {opportunity.long_leg.display_name} and {opportunity.short_leg.display_name}.",
        f"Use approximately {long_leg.estimated_quantity:.6f} contracts/coins on the long leg and {short_leg.estimated_quantity:.6f} on the short leg, adjusted to exchange lot size.",
        "Enter both legs close together in time to reduce directional exposure during entry.",
        "Confirm both positions remain delta-neutral after fees, rounding, and lot-size constraints.",
    ]
    exit_rules = [
        "Close both legs before the spread collapses below your fee + slippage threshold.",
        "Exit immediately if one venue degrades, rejects orders, or diverges materially from the other mark price.",
        f"Use a basis-risk reserve of {basis_risk_buffer_percent:.2f}% of total gross exposure while the trade is open.",
        f"Re-evaluate after {holding_periods} funding period(s) or sooner if the confidence score drops.",
    ]

    warnings = list(opportunity.warnings)
    if expected_net_pnl_usd <= 0:
        warnings.append("This dry-run plan is not net profitable after fees, slippage, and basis reserve.")
    if leverage > 5:
        warnings.append("Leverage above 5x increases liquidation and execution risk materially.")

    return ExecutionPlanResponse(
        canonical_symbol=opportunity.canonical_symbol,
        notional_usd=notional_usd,
        leverage=leverage,
        holding_periods=holding_periods,
        capital_required_usd=capital_required_usd,
        estimated_total_fees_usd=estimated_total_fees_usd,
        estimated_total_slippage_usd=estimated_total_slippage_usd,
        estimated_funding_pnl_usd=estimated_funding_pnl_usd,
        estimated_basis_risk_reserve_usd=estimated_basis_risk_reserve_usd,
        expected_net_pnl_usd=expected_net_pnl_usd,
        expected_net_return_on_capital_percent=expected_net_return_on_capital_percent,
        confidence_score=opportunity.confidence_score,
        warnings=warnings,
        entry_steps=entry_steps,
        exit_rules=exit_rules,
        long_leg=long_leg,
        short_leg=short_leg,
    )
