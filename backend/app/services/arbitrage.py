from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timezone

from app.core.config import Settings
from app.models.market import ArbitrageOpportunity, FundingSnapshot, OpportunityLeg
from app.services.links import exchange_display_name, exchange_trade_url


def _build_leg(snapshot: FundingSnapshot) -> OpportunityLeg:
    return OpportunityLeg(
        exchange=snapshot.exchange,
        display_name=exchange_display_name(snapshot.exchange),
        exchange_symbol=snapshot.exchange_symbol,
        funding_rate=snapshot.funding_rate,
        mark_price=snapshot.mark_price,
        open_interest_usd=snapshot.open_interest_usd,
        volume_24h=snapshot.volume_24h,
        taker_fee_bps=snapshot.taker_fee_bps,
        next_funding_time=snapshot.next_funding_time,
        trade_url=exchange_trade_url(snapshot.exchange, snapshot.exchange_symbol),
        best_bid_size=snapshot.metadata.get("best_bid_size"),
        best_ask_size=snapshot.metadata.get("best_ask_size"),
    )


def _confidence_for_pair(
    long_leg: FundingSnapshot,
    short_leg: FundingSnapshot,
    settings: Settings,
    price_dislocation_percent: float | None,
) -> tuple[float, list[str], float]:
    score = 1.0
    warnings: list[str] = []
    now = datetime.now(timezone.utc)

    max_age = max(
        (now - long_leg.fetched_at).total_seconds(),
        (now - short_leg.fetched_at).total_seconds(),
    )
    if max_age > 60:
        score -= 0.35
        warnings.append("One or both legs are stale.")
    elif max_age > 25:
        score -= 0.15
        warnings.append("Data is slightly stale.")

    combined_oi = (long_leg.open_interest_usd or 0.0) + (short_leg.open_interest_usd or 0.0)
    if combined_oi <= 0:
        score -= 0.25
        warnings.append("Open interest is missing for one or both legs.")
    elif combined_oi < settings.min_combined_oi_usd:
        score -= 0.15
        warnings.append("Combined open interest is low.")

    if long_leg.quote_asset != short_leg.quote_asset:
        score -= 0.1
        warnings.append("Quote assets differ across the legs.")

    if price_dislocation_percent is not None and price_dislocation_percent > settings.max_price_dislocation_percent:
        score -= 0.2
        warnings.append("Mark prices are materially different across exchanges.")

    estimated_slippage_percent = 0.04
    if combined_oi <= 0:
        estimated_slippage_percent += 0.18
    elif combined_oi < 2_000_000:
        estimated_slippage_percent += 0.08

    if price_dislocation_percent is not None and price_dislocation_percent > 0.2:
        estimated_slippage_percent += min(price_dislocation_percent * 0.25, 0.2)

    return max(score, 0.0), warnings, estimated_slippage_percent


def build_opportunities(snapshots: list[FundingSnapshot], settings: Settings) -> list[ArbitrageOpportunity]:
    grouped: dict[str, list[FundingSnapshot]] = defaultdict(list)
    for snapshot in snapshots:
        grouped[snapshot.canonical_symbol].append(snapshot)

    opportunities: list[ArbitrageOpportunity] = []
    for entries in grouped.values():
        if len(entries) < 2:
            continue

        sorted_by_rate = sorted(entries, key=lambda item: item.funding_rate)
        long_leg = sorted_by_rate[0]
        short_leg = sorted_by_rate[-1]
        if long_leg.exchange == short_leg.exchange:
            continue

        spread_rate = short_leg.funding_rate - long_leg.funding_rate
        if spread_rate <= 0:
            continue

        interval_hours = min(long_leg.funding_interval_hours, short_leg.funding_interval_hours)
        periods_per_year = (24 / interval_hours) * 365

        price_dislocation_percent = None
        if long_leg.mark_price and short_leg.mark_price:
            midpoint = (long_leg.mark_price + short_leg.mark_price) / 2
            if midpoint:
                price_dislocation_percent = abs(long_leg.mark_price - short_leg.mark_price) / midpoint * 100

        gross_apr_percent = spread_rate * periods_per_year * 100
        round_trip_fee_percent = ((long_leg.taker_fee_bps + short_leg.taker_fee_bps) * 2) / 100
        confidence_score, warnings, estimated_slippage_percent = _confidence_for_pair(
            long_leg,
            short_leg,
            settings,
            price_dislocation_percent,
        )
        net_apr_percent = (spread_rate - (round_trip_fee_percent / 100) - (estimated_slippage_percent / 100)) * periods_per_year * 100

        opportunities.append(
            ArbitrageOpportunity(
                canonical_symbol=long_leg.canonical_symbol,
                base_asset=long_leg.base_asset,
                quote_asset=long_leg.quote_asset,
                long_leg=_build_leg(long_leg),
                short_leg=_build_leg(short_leg),
                spread_rate=spread_rate,
                funding_interval_hours=interval_hours,
                gross_apr_percent=gross_apr_percent,
                net_apr_percent=net_apr_percent,
                estimated_round_trip_fee_percent=round_trip_fee_percent,
                estimated_slippage_percent=estimated_slippage_percent,
                combined_open_interest_usd=(long_leg.open_interest_usd or 0.0) + (short_leg.open_interest_usd or 0.0) or None,
                price_dislocation_percent=price_dislocation_percent,
                confidence_score=confidence_score,
                warnings=warnings,
            )
        )

    return sorted(
        opportunities,
        key=lambda item: (abs(item.spread_rate), item.confidence_score, item.net_apr_percent),
        reverse=True,
    )
