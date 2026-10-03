from __future__ import annotations

from fastapi import HTTPException

from app.models.execution import ExecutionLegPlan, ExecutionPlanResponse
from app.models.market import ArbitrageOpportunity
from app.services.opportunity_ranker import HOURS_PER_YEAR, expected_funding_over_hours


def reverse_opportunity(opportunity: ArbitrageOpportunity) -> ArbitrageOpportunity:
    warnings = list(opportunity.warnings)
    reverse_warning = "Reverse setup inverts the funding edge and is shown for comparison only."
    if reverse_warning not in warnings:
        warnings.append(reverse_warning)

    reversed_net_return = -opportunity.expected_funding_percent - opportunity.estimated_total_cost_percent
    return opportunity.model_copy(
        update={
            "long_leg": opportunity.short_leg,
            "short_leg": opportunity.long_leg,
            "spread_rate": -opportunity.spread_rate,
            "spread_rate_hourly": -opportunity.spread_rate_hourly,
            "gross_apr_percent": -opportunity.gross_apr_percent,
            "expected_funding_percent": -opportunity.expected_funding_percent,
            "net_return_percent": reversed_net_return,
            "net_apr_percent": reversed_net_return * HOURS_PER_YEAR / max(opportunity.holding_horizon_hours, 1),
            "break_even_hours": None,
            "warnings": warnings,
        }
    )


def _resolve_notional_usd(
    opportunity: ArbitrageOpportunity,
    *,
    long_leverage: float,
    short_leverage: float,
    notional_usd: float | None,
    capital_usd: float | None,
) -> tuple[float, float | None]:
    if capital_usd is not None:
        if capital_usd <= 0:
            raise HTTPException(status_code=400, detail="capital_usd must be positive.")

        fee_factor = ((opportunity.long_leg.taker_fee_bps + opportunity.short_leg.taker_fee_bps) * 2) / 10_000
        capital_factor = (1 / long_leverage) + (1 / short_leverage) + fee_factor
        if capital_factor <= 0:
            raise HTTPException(status_code=400, detail="Unable to derive notional from capital.")
        return capital_usd / capital_factor, capital_usd

    if notional_usd is None or notional_usd <= 0:
        raise HTTPException(status_code=400, detail="notional_usd must be positive.")

    return notional_usd, None


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


def _resolve_leg_leverage(
    *,
    exchange: str,
    display_name: str,
    default_leverage: float,
    leverage_overrides: dict[str, float],
    max_leverage: float | None,
    warnings: list[str],
) -> float:
    override = leverage_overrides.get(exchange)
    leverage = override if override is not None else default_leverage
    if leverage < 1:
        raise HTTPException(status_code=400, detail=f"Leverage for {display_name} must be at least 1.")

    if max_leverage is not None and max_leverage >= 1 and leverage > max_leverage:
        warnings.append(
            f"{display_name} leverage {leverage:.2f}x exceeds the exchange max {max_leverage:.2f}x, so the plan uses {max_leverage:.2f}x."
        )
        return max_leverage

    return leverage


def build_execution_plan(
    opportunity: ArbitrageOpportunity,
    *,
    notional_usd: float | None,
    capital_usd: float | None,
    leverage: float,
    leverage_overrides: dict[str, float] | None,
    holding_periods: int,
    basis_risk_buffer_percent: float,
    scenario: str = "best",
    funding_fraction_override: float | None = None,
) -> ExecutionPlanResponse:
    if leverage < 1:
        raise HTTPException(status_code=400, detail="leverage must be at least 1.")
    if holding_periods < 1:
        raise HTTPException(status_code=400, detail="holding_periods must be at least 1.")

    warnings = list(opportunity.warnings)
    normalized_overrides = {key.lower(): value for key, value in (leverage_overrides or {}).items() if isinstance(value, (int, float))}
    long_leverage = _resolve_leg_leverage(
        exchange=opportunity.long_leg.exchange,
        display_name=opportunity.long_leg.display_name,
        default_leverage=leverage,
        leverage_overrides=normalized_overrides,
        max_leverage=opportunity.long_leg.max_leverage,
        warnings=warnings,
    )
    short_leverage = _resolve_leg_leverage(
        exchange=opportunity.short_leg.exchange,
        display_name=opportunity.short_leg.display_name,
        default_leverage=leverage,
        leverage_overrides=normalized_overrides,
        max_leverage=opportunity.short_leg.max_leverage,
        warnings=warnings,
    )

    notional_usd, capital_input_usd = _resolve_notional_usd(
        opportunity,
        long_leverage=long_leverage,
        short_leverage=short_leverage,
        notional_usd=notional_usd,
        capital_usd=capital_usd,
    )

    long_leg = _build_leg_plan(
        side="buy",
        display_name=opportunity.long_leg.display_name,
        exchange=opportunity.long_leg.exchange,
        exchange_symbol=opportunity.long_leg.exchange_symbol,
        reference_price=opportunity.long_leg.mark_price,
        notional_usd=notional_usd,
        leverage=long_leverage,
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
        leverage=short_leverage,
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
    # A "period" is the faster leg's settlement interval; funding comes from each leg's real schedule.
    holding_hours = holding_periods * max(opportunity.funding_interval_hours, 1)
    estimated_funding_pnl_usd = (
        funding_fraction_override * notional_usd
        if funding_fraction_override is not None
        # Capture plans pass the single-settlement payment; hold plans walk each leg's schedule.
        else expected_funding_over_hours(opportunity.long_leg, opportunity.short_leg, holding_hours) * notional_usd
    )
    estimated_basis_risk_reserve_usd = (basis_risk_buffer_percent / 100) * (notional_usd * 2)
    capital_required_usd = long_leg.initial_margin_usd + short_leg.initial_margin_usd + estimated_total_fees_usd
    # The basis reserve is cash to keep aside for price gaps between the legs, not a cost, so it is
    # reported separately and left out of the net (realised results never subtract it either).
    expected_net_pnl_usd = estimated_funding_pnl_usd - estimated_total_fees_usd - estimated_total_slippage_usd
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

    if expected_net_pnl_usd <= 0:
        warnings.append("Not profitable after fees and slippage at this size.")
    if long_leverage > 5 or short_leverage > 5:
        warnings.append("Leverage above 5x increases liquidation and execution risk materially.")

    return ExecutionPlanResponse(
        scenario=scenario,  # type: ignore[arg-type]
        canonical_symbol=opportunity.canonical_symbol,
        capital_input_usd=capital_input_usd,
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
