from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta, timezone

from app.core.config import Settings
from app.models.market import ArbitrageOpportunity, CaptureLeg, CaptureSetup, FundingSnapshot, OpportunityLeg, TrustCheck
from app.services.liquidity import DepthQuote, RankingContext
from app.services.links import exchange_display_name, exchange_trade_url


def is_snapshot_usable(snapshot: FundingSnapshot) -> bool:
    if abs(snapshot.funding_rate) < 0.0000005 and snapshot.open_interest_usd is None and snapshot.volume_24h is None:
        return False
    return True


HOURS_PER_YEAR = 24 * 365
BREAK_EVEN_SEARCH_HOURS = 24 * 30
# Hourly spreads closer than this are float noise, not an edge (1e-12/h is ~0.0000009% a year).
SPREAD_EPSILON = 1e-12
# Venues that publish predicted funding this rarely get an explicit warning on every pair they are in.
SLOW_RATE_REFRESH_SECONDS = 30


def hourly_funding_rate(snapshot: FundingSnapshot | OpportunityLeg) -> float:
    interval = snapshot.funding_interval_hours or 8
    return snapshot.funding_rate / max(interval, 1)


def build_opportunities(
    snapshots: list[FundingSnapshot],
    settings: Settings,
    context: RankingContext | None = None,
) -> list[ArbitrageOpportunity]:
    opportunities: list[ArbitrageOpportunity] = []
    now = datetime.now(timezone.utc)

    for entries in group_snapshots_by_symbol(snapshots).values():
        pair = select_rankable_pair(entries, settings)
        if pair is None:
            continue
        opportunity = build_opportunity(pair[0], pair[1], settings, now=now, context=context)
        opportunity.capture = best_capture(entries, settings, context or RankingContext(), now, opportunity.trust_checks)
        opportunities.append(opportunity)

    return sorted(
        opportunities,
        key=lambda item: (item.spread_rate, item.confidence_score, item.net_apr_percent),
        reverse=True,
    )


def build_opportunity(
    long_leg: FundingSnapshot,
    short_leg: FundingSnapshot,
    settings: Settings,
    *,
    now: datetime | None = None,
    context: RankingContext | None = None,
) -> ArbitrageOpportunity:
    now = now or datetime.now(timezone.utc)
    context = context or RankingContext()
    spread_rate_hourly = hourly_funding_rate(short_leg) - hourly_funding_rate(long_leg)
    interval_hours = min(long_leg.funding_interval_hours, short_leg.funding_interval_hours)
    price_dislocation_percent = estimate_price_dislocation_percent(long_leg, short_leg)
    notional = settings.liquidity_reference_notional_usd

    long_quote = context.liquidity.quote(long_leg.exchange, long_leg.exchange_symbol, now) if context.liquidity else None
    short_quote = context.liquidity.quote(short_leg.exchange, short_leg.exchange_symbol, now) if context.liquidity else None
    estimated_leg_slippage = estimate_leg_slippage_percent(long_leg, short_leg, settings, price_dislocation_percent)
    long_slippage = long_quote.round_trip_percent if long_quote and long_quote.fillable else None
    short_slippage = short_quote.round_trip_percent if short_quote and short_quote.fillable else None
    measured = sum(value is not None for value in (long_slippage, short_slippage))
    slippage_source = "orderbook" if measured == 2 else "mixed" if measured == 1 else "estimate"
    total_slippage = (long_slippage if long_slippage is not None else estimated_leg_slippage) + (
        short_slippage if short_slippage is not None else estimated_leg_slippage
    )

    long_taker = context.taker_fee_overrides_bps.get(long_leg.exchange, long_leg.taker_fee_bps)
    short_taker = context.taker_fee_overrides_bps.get(short_leg.exchange, short_leg.taker_fee_bps)
    round_trip_fee_percent = ((long_taker + short_taker) * 2) / 100
    total_cost_percent = round_trip_fee_percent + total_slippage
    horizon_hours = max(1, settings.holding_horizon_hours)
    long_opp_leg = build_opportunity_leg(long_leg, quote=long_quote, taker_fee_bps=long_taker)
    short_opp_leg = build_opportunity_leg(short_leg, quote=short_quote, taker_fee_bps=short_taker)
    expected_funding_percent = expected_funding_over_hours(long_opp_leg, short_opp_leg, horizon_hours, now=now) * 100
    net_return_percent = expected_funding_percent - total_cost_percent
    break_even = break_even_hours(long_opp_leg, short_opp_leg, total_cost_percent / 100, now=now)

    checks = assess_trust(
        long_leg,
        short_leg,
        long_opp_leg,
        short_opp_leg,
        settings,
        now=now,
        context=context,
        price_dislocation_percent=price_dislocation_percent,
        spread_rate_hourly=spread_rate_hourly,
        slippage_source=slippage_source,
        total_slippage_percent=total_slippage,
        expected_funding_percent=expected_funding_percent,
        net_return_percent=net_return_percent,
        break_even=break_even,
        horizon_hours=horizon_hours,
    )
    trust_level, confidence_score = summarise_trust(checks)

    return ArbitrageOpportunity(
        canonical_symbol=long_leg.canonical_symbol,
        base_asset=long_leg.base_asset,
        quote_asset=long_leg.quote_asset,
        long_leg=long_opp_leg,
        short_leg=short_opp_leg,
        spread_rate=spread_rate_hourly * 8,
        spread_rate_hourly=spread_rate_hourly,
        funding_interval_hours=interval_hours,
        gross_apr_percent=spread_rate_hourly * HOURS_PER_YEAR * 100,
        net_apr_percent=net_return_percent * HOURS_PER_YEAR / horizon_hours,
        estimated_round_trip_fee_percent=round_trip_fee_percent,
        estimated_slippage_percent=total_slippage / 2,
        estimated_total_cost_percent=total_cost_percent,
        holding_horizon_hours=horizon_hours,
        expected_funding_percent=expected_funding_percent,
        net_return_percent=net_return_percent,
        break_even_hours=break_even,
        slippage_source=slippage_source,
        reference_notional_usd=notional,
        combined_open_interest_usd=combined_open_interest_usd(long_leg, short_leg),
        price_dislocation_percent=price_dislocation_percent,
        max_leg_age_seconds=estimate_max_leg_age_seconds(long_leg, short_leg),
        confidence_score=confidence_score,
        trust_level=trust_level,
        trust_checks=checks,
        warnings=[check.detail for check in checks if check.status != "pass"],
    )


CAPTURE_WINDOW_SECONDS = 120
# Checks about holding for days do not apply to a single-settlement capture.
_HOLD_ONLY_CHECKS = {"profit", "persistence", "first_payment"}


def _next_settlement(snapshot: FundingSnapshot, now: datetime) -> datetime | None:
    if snapshot.next_funding_time is None:
        return None
    interval = timedelta(hours=max(snapshot.funding_interval_hours, 1))
    at = snapshot.next_funding_time
    while at <= now:
        at += interval
    return at


def best_capture(
    entries: list[FundingSnapshot],
    settings: Settings,
    context: RankingContext,
    now: datetime,
    hold_checks: list[TrustCheck],
) -> CaptureSetup | None:
    """Best pair to enter just before the next settlement and exit right after it.

    Only legs that settle inside that moment pay or charge funding; the other leg is a pure hedge.
    Costs are entry + exit taker fees and slippage on both legs, paid for this one capture.
    """
    data_checks = [check for check in hold_checks if check.key not in _HOLD_ONLY_CHECKS]
    data_trust, _ = summarise_trust(data_checks) if data_checks else ("medium", 0.0)
    best: tuple[tuple[float, float], CaptureSetup] | None = None
    max_dislocation = settings.max_pair_price_dislocation_percent

    for long_leg in entries:
        for short_leg in entries:
            if long_leg.exchange == short_leg.exchange:
                continue
            dislocation = estimate_price_dislocation_percent(long_leg, short_leg)
            if dislocation is not None and dislocation > max_dislocation:
                continue
            long_at = _next_settlement(long_leg, now)
            short_at = _next_settlement(short_leg, now)
            candidates = [at for at in (long_at, short_at) if at is not None]
            if not candidates:
                continue
            settles_at = min(candidates)
            long_in = long_at is not None and abs((long_at - settles_at).total_seconds()) <= CAPTURE_WINDOW_SECONDS
            short_in = short_at is not None and abs((short_at - settles_at).total_seconds()) <= CAPTURE_WINDOW_SECONDS
            long_payment = -long_leg.funding_rate if long_in else 0.0
            short_payment = short_leg.funding_rate if short_in else 0.0
            capture_percent = (long_payment + short_payment) * 100

            legs = []
            fee_percent = 0.0
            slippage_percent = 0.0
            estimate = estimate_leg_slippage_percent(long_leg, short_leg, settings, dislocation)
            for snapshot, settles, payment in ((long_leg, long_in, long_payment), (short_leg, short_in, short_payment)):
                taker = context.taker_fee_overrides_bps.get(snapshot.exchange, snapshot.taker_fee_bps)
                quote = context.liquidity.quote(snapshot.exchange, snapshot.exchange_symbol, now) if context.liquidity else None
                measured = quote is not None and quote.fillable
                slip = quote.round_trip_percent if measured else estimate  # type: ignore[union-attr]
                fee_percent += taker * 2 / 100
                slippage_percent += slip or 0.0
                legs.append(
                    CaptureLeg(
                        exchange=snapshot.exchange,
                        display_name=exchange_display_name(snapshot.exchange),
                        exchange_symbol=snapshot.exchange_symbol,
                        funding_rate=snapshot.funding_rate,
                        funding_interval_hours=snapshot.funding_interval_hours,
                        next_funding_time=_next_settlement(snapshot, now),
                        settles_in_window=settles,
                        payment=payment,
                        taker_fee_bps=taker,
                        slippage_round_trip_percent=slip or 0.0,
                        slippage_measured=measured,
                        trade_url=exchange_trade_url(snapshot.exchange, snapshot.exchange_symbol),
                    )
                )
            cost_percent = fee_percent + slippage_percent
            setup = CaptureSetup(
                settles_at=settles_at,
                long_leg=legs[0],
                short_leg=legs[1],
                settling="both" if long_in and short_in else "long" if long_in else "short",
                capture_percent=capture_percent,
                fee_percent=fee_percent,
                slippage_percent=slippage_percent,
                cost_percent=cost_percent,
                net_percent=capture_percent - cost_percent,
                data_trust_level=data_trust,  # type: ignore[arg-type]
            )
            # Best net first; on a tie, the sooner settlement.
            key = (round(setup.net_percent, 9), -settles_at.timestamp())
            if best is None or key > best[0]:
                best = (key, setup)
    return best[1] if best else None


def capture_opportunity(
    opportunity: ArbitrageOpportunity,
    snapshots: list[FundingSnapshot],
    settings: Settings,
    context: RankingContext | None = None,
) -> ArbitrageOpportunity | None:
    """The coin's next-settlement setup as a full opportunity, so plans and trades use exactly that pair."""
    capture = opportunity.capture
    if capture is None:
        return None

    def find(exchange: str, symbol: str) -> FundingSnapshot | None:
        return next((item for item in snapshots if item.exchange == exchange and item.exchange_symbol == symbol), None)

    long_snapshot = find(capture.long_leg.exchange, capture.long_leg.exchange_symbol)
    short_snapshot = find(capture.short_leg.exchange, capture.short_leg.exchange_symbol)
    if long_snapshot is None or short_snapshot is None:
        return None
    built = build_opportunity(long_snapshot, short_snapshot, settings, context=context)
    built.capture = capture
    return built


def summarise_trust(checks: list[TrustCheck]) -> tuple[str, float]:
    fails = sum(check.status == "fail" for check in checks)
    warns = sum(check.status == "warn" for check in checks)
    # An edge we have not watched for long enough to rule out a spike can be at most "medium".
    unproven = any(check.key == "persistence" and check.status == "info" for check in checks)
    score = max(0.0, 1.0 - 0.35 * fails - 0.12 * warns - (0.1 if unproven else 0.0))
    if fails:
        return "low", score
    if warns >= 2 or unproven:
        return "medium", score
    return "high", score


def assess_trust(
    long_leg: FundingSnapshot,
    short_leg: FundingSnapshot,
    long_opp_leg: OpportunityLeg,
    short_opp_leg: OpportunityLeg,
    settings: Settings,
    *,
    now: datetime,
    context: RankingContext,
    price_dislocation_percent: float | None,
    spread_rate_hourly: float,
    slippage_source: str,
    total_slippage_percent: float,
    expected_funding_percent: float,
    net_return_percent: float,
    break_even: float | None,
    horizon_hours: int,
) -> list[TrustCheck]:
    checks: list[TrustCheck] = []
    name = exchange_display_name
    legs = (long_leg, short_leg)

    # 1. Feed freshness (time since our last successful poll of each leg).
    age = estimate_max_leg_age_seconds(long_leg, short_leg)
    if age > 60:
        checks.append(TrustCheck(key="freshness", label="Data freshness", status="fail", detail=f"One or both legs are stale ({age:.0f}s since last update)."))
    elif age > 25:
        checks.append(TrustCheck(key="freshness", label="Data freshness", status="warn", detail=f"Data is slightly stale ({age:.0f}s since last update)."))
    else:
        checks.append(TrustCheck(key="freshness", label="Data freshness", status="pass", detail=f"Both feeds updated within {max(age, 0):.0f}s."))

    # 2. How often each venue republishes its predicted rate.
    slow = []
    for leg in legs:
        refresh_seconds = leg.metadata.get("rate_refresh_seconds") or 0
        if refresh_seconds >= SLOW_RATE_REFRESH_SECONDS:
            unchanged = _rate_unchanged_minutes(leg, now)
            slow.append((leg, unchanged))
    if slow:
        for leg, unchanged in slow:
            cadence_minutes = int(leg.metadata["rate_refresh_seconds"] // 60)
            detail = f" (unchanged for at least {unchanged}m)" if unchanged is not None and unchanged >= 1 else ""
            # Unchanged for longer than one cadence plus slack means a refresh was missed.
            status = "fail" if unchanged is not None and unchanged > cadence_minutes + 5 else "warn"
            checks.append(
                TrustCheck(
                    key="rate_refresh",
                    label="Rate refresh",
                    status=status,
                    detail=f"{name(leg.exchange)} republishes its predicted rate only about every {cadence_minutes} minutes{detail}, so this spread can jump when it updates.",
                )
            )
    else:
        checks.append(TrustCheck(key="rate_refresh", label="Rate refresh", status="pass", detail="Both venues publish predicted rates continuously."))

    # 3. Settlement intervals.
    assumed = [leg for leg in legs if leg.metadata.get("interval_source") == "assumed"]
    for leg in assumed:
        checks.append(
            TrustCheck(
                key="interval",
                label="Funding interval",
                status="warn",
                detail=f"{name(leg.exchange)} does not publish this contract's funding interval; {leg.funding_interval_hours}h is assumed until a settlement is observed.",
            )
        )
    if long_leg.funding_interval_hours != short_leg.funding_interval_hours:
        checks.append(
            TrustCheck(
                key="schedule",
                label="Settlement schedule",
                status="info",
                detail=f"Legs settle on different schedules ({long_leg.funding_interval_hours}h vs {short_leg.funding_interval_hours}h); realised funding depends on when you enter and exit.",
            )
        )
    elif not assumed:
        checks.append(TrustCheck(key="interval", label="Funding interval", status="pass", detail=f"Both legs settle every {long_leg.funding_interval_hours}h."))

    # 4. Liquidity at the reference size.
    notional = settings.liquidity_reference_notional_usd
    unfillable = [leg for leg in (long_opp_leg, short_opp_leg) if leg.depth_fillable is False]
    if unfillable:
        for leg in unfillable:
            checks.append(
                TrustCheck(key="liquidity", label="Order book", status="fail", detail=f"{leg.display_name} book cannot fill ${notional:,.0f} within the visible depth.")
            )
    elif slippage_source == "orderbook":
        share = total_slippage_percent / expected_funding_percent * 100 if expected_funding_percent > 0 else None
        detail = (
            f"Live books fill ${notional:,.0f} per leg for {long_opp_leg.slippage_round_trip_percent:.3f}% + "
            f"{short_opp_leg.slippage_round_trip_percent:.3f}% round-trip slippage"
        )
        if share is not None and share > 50:
            checks.append(TrustCheck(key="liquidity", label="Order book", status="warn", detail=f"{detail}, which eats {share:.0f}% of the funding over the hold."))
        else:
            checks.append(TrustCheck(key="liquidity", label="Order book", status="pass", detail=f"{detail}."))
    else:
        combined_oi = combined_open_interest_usd(long_leg, short_leg)
        oi_note = (
            "open interest is missing for one or both legs"
            if not combined_oi
            else f"combined open interest ${combined_oi:,.0f}"
        )
        checks.append(
            TrustCheck(
                key="liquidity",
                label="Order book",
                status="warn",
                detail=f"Slippage is estimated, not measured ({oi_note}); order books not sampled for this pair yet.",
            )
        )

    # 5. Are both legs the same instrument at the same price?
    if price_dislocation_percent is None:
        checks.append(TrustCheck(key="price_gap", label="Price match", status="warn", detail="Mark price missing on one leg, so the instruments cannot be cross-checked."))
    elif price_dislocation_percent > settings.max_price_dislocation_percent:
        checks.append(TrustCheck(key="price_gap", label="Price match", status="fail", detail=f"Mark prices are materially different across exchanges ({price_dislocation_percent:.2f}%)."))
    elif price_dislocation_percent > 0.3:
        checks.append(TrustCheck(key="price_gap", label="Price match", status="warn", detail=f"Mark prices differ by {price_dislocation_percent:.2f}%; entry basis will move your PnL."))
    else:
        checks.append(TrustCheck(key="price_gap", label="Price match", status="pass", detail=f"Mark prices agree within {price_dislocation_percent:.2f}%."))
    if long_leg.quote_asset != short_leg.quote_asset:
        checks.append(TrustCheck(key="quote", label="Quote asset", status="warn", detail="Quote assets differ across the legs."))

    # 6. Does it pay after costs?
    if net_return_percent <= 0:
        checks.append(TrustCheck(key="profit", label="After costs", status="fail", detail=f"Not profitable over a {horizon_hours}h hold after fees and slippage."))
    elif break_even is not None and break_even > 48:
        checks.append(TrustCheck(key="profit", label="After costs", status="warn", detail=f"Needs {break_even:.0f}h of funding just to cover fees and slippage."))
    else:
        checks.append(
            TrustCheck(key="profit", label="After costs", status="pass", detail=f"Covers fees and slippage after {break_even:.1f}h." if break_even is not None else "Covers costs.")
        )

    # 7. Has this edge lasted, or is it a spike?
    persistence = (
        context.spreads.persistence(long_leg.canonical_symbol, long_leg.exchange, short_leg.exchange, spread_rate_hourly, now)
        if context.spreads
        else None
    )
    if persistence is None or persistence[0] < 20:
        minutes = 0 if persistence is None else persistence[0]
        checks.append(TrustCheck(key="persistence", label="Persistence", status="info", detail=f"New: this edge has only been tracked for {minutes:.0f}m."))
    else:
        minutes, share, _ = persistence
        if share >= 0.8:
            checks.append(TrustCheck(key="persistence", label="Persistence", status="pass", detail=f"Held at least half this edge for {share * 100:.0f}% of the last {minutes:.0f}m."))
        elif share >= 0.5:
            checks.append(TrustCheck(key="persistence", label="Persistence", status="warn", detail=f"Edge held for only {share * 100:.0f}% of the last {minutes:.0f}m."))
        else:
            checks.append(TrustCheck(key="persistence", label="Persistence", status="fail", detail=f"Likely a spike: this pair held its edge for only {share * 100:.0f}% of the last {minutes:.0f}m."))

    # 8. Is the first payment income or a cost?
    first = []
    for leg, sign in ((long_opp_leg, -1.0), (short_opp_leg, 1.0)):
        offsets = _settlement_offsets_hours(leg, horizon_hours, now)
        if offsets:
            first.append((offsets[0], leg, sign * leg.funding_rate))
    if first:
        first_at = min(offset for offset, _, _ in first)
        settling = [(leg, amount) for offset, leg, amount in first if abs(offset - first_at) < 1e-6]
        first_total = sum(amount for _, amount in settling)
        who = " and ".join(leg.display_name for leg, _ in settling)
        if first_total < 0:
            checks.append(
                TrustCheck(
                    key="first_payment",
                    label="First settlement",
                    status="warn",
                    detail=f"The first settlement in {first_at:.1f}h ({who}) costs {abs(first_total) * 100:.4f}%; income arrives later.",
                )
            )
        else:
            checks.append(
                TrustCheck(key="first_payment", label="First settlement", status="pass", detail=f"First settlement in {first_at:.1f}h ({who}) pays {first_total * 100:.4f}%.")
            )
    return checks


def estimate_leg_slippage_percent(
    long_leg: FundingSnapshot,
    short_leg: FundingSnapshot,
    settings: Settings,
    price_dislocation_percent: float | None,
) -> float:
    """Heuristic per-leg round-trip slippage, used only when the order book has not been measured."""
    combined_oi = combined_open_interest_usd(long_leg, short_leg) or 0.0
    estimate = 0.04
    if combined_oi <= 0:
        estimate += 0.18
    elif combined_oi < 2_000_000:
        estimate += 0.08
    if price_dislocation_percent is not None and price_dislocation_percent > 0.2:
        estimate += min(price_dislocation_percent * 0.25, 0.2)
    return estimate


def _rate_unchanged_minutes(snapshot: FundingSnapshot, now: datetime) -> int | None:
    changed_at = snapshot.metadata.get("rate_changed_at")
    if not changed_at:
        return None
    try:
        return int((now - datetime.fromisoformat(changed_at)).total_seconds() // 60)
    except (TypeError, ValueError):
        return None


def _settlement_offsets_hours(leg: OpportunityLeg, horizon_hours: float, now: datetime) -> list[float] | None:
    """Hours from `now` of each settlement for this leg inside (0, horizon]. None if timing is unknown."""
    interval = float(leg.funding_interval_hours or 0)
    if interval <= 0 or leg.next_funding_time is None:
        return None
    first = (leg.next_funding_time - now).total_seconds() / 3600
    while first <= 0:
        # A next-funding time in the past means the feed has not rolled yet; the next one is an interval later.
        first += interval
    offsets: list[float] = []
    current = first
    while current <= horizon_hours + 1e-9:
        offsets.append(current)
        current += interval
    return offsets


def funding_events(
    long_leg: OpportunityLeg,
    short_leg: OpportunityLeg,
    horizon_hours: float,
    *,
    now: datetime,
) -> list[tuple[float, float]] | None:
    """(hours from now, funding earned as a fraction of one leg's notional) for every settlement in the horizon.

    Long the low-funding leg: it receives -rate each settlement. Short the high-funding leg: it receives +rate.
    """
    long_offsets = _settlement_offsets_hours(long_leg, horizon_hours, now)
    short_offsets = _settlement_offsets_hours(short_leg, horizon_hours, now)
    if long_offsets is None or short_offsets is None:
        return None
    events = [(offset, -long_leg.funding_rate) for offset in long_offsets]
    events += [(offset, short_leg.funding_rate) for offset in short_offsets]
    return sorted(events)


def expected_funding_over_hours(
    long_leg: OpportunityLeg,
    short_leg: OpportunityLeg,
    horizon_hours: float,
    *,
    now: datetime | None = None,
) -> float:
    """Funding earned over the horizon as a fraction of one leg's notional, assuming current rates persist."""
    events = funding_events(long_leg, short_leg, horizon_hours, now=now or datetime.now(timezone.utc))
    if events is None:
        # Timing unknown: fall back to the continuous hourly approximation.
        return (hourly_funding_rate(short_leg) - hourly_funding_rate(long_leg)) * horizon_hours
    return sum(amount for _, amount in events)


def break_even_hours(
    long_leg: OpportunityLeg,
    short_leg: OpportunityLeg,
    total_cost_fraction: float,
    *,
    now: datetime | None = None,
) -> float | None:
    """Hours until cumulative funding first covers the one-off costs, using the real settlement schedule."""
    if total_cost_fraction <= 0:
        return 0.0
    events = funding_events(long_leg, short_leg, BREAK_EVEN_SEARCH_HOURS, now=now or datetime.now(timezone.utc))
    if events is None:
        hourly = hourly_funding_rate(short_leg) - hourly_funding_rate(long_leg)
        if hourly <= 0:
            return None
        hours = total_cost_fraction / hourly
        return hours if hours <= BREAK_EVEN_SEARCH_HOURS else None
    cumulative = 0.0
    for offset, amount in events:
        cumulative += amount
        if cumulative >= total_cost_fraction - 1e-12:
            return offset
    return None


def group_snapshots_by_symbol(snapshots: list[FundingSnapshot]) -> dict[str, list[FundingSnapshot]]:
    grouped: dict[str, list[FundingSnapshot]] = defaultdict(list)
    for snapshot in snapshots:
        if not is_snapshot_usable(snapshot):
            continue
        grouped[snapshot.canonical_symbol].append(snapshot)
    return grouped


def select_rankable_pair(
    entries: list[FundingSnapshot],
    settings: Settings | None = None,
) -> tuple[FundingSnapshot, FundingSnapshot] | None:
    """Best (long, short) pair across different exchanges by hourly-normalised funding spread."""
    max_dislocation = settings.max_pair_price_dislocation_percent if settings else None
    best: tuple[tuple[float, float, str, str], FundingSnapshot, FundingSnapshot] | None = None
    for long_leg in entries:
        for short_leg in entries:
            if long_leg.exchange == short_leg.exchange:
                continue
            spread = hourly_funding_rate(short_leg) - hourly_funding_rate(long_leg)
            if spread <= SPREAD_EPSILON:
                continue
            if max_dislocation is not None:
                dislocation = estimate_price_dislocation_percent(long_leg, short_leg)
                if dislocation is not None and dislocation > max_dislocation:
                    continue
            # Equal spreads (common when venues share a baseline rate) resolve to the pair with more visible
            # open interest, then deterministically by exchange name, so the pick does not flicker between polls.
            key = (
                round(spread / SPREAD_EPSILON) * SPREAD_EPSILON,
                combined_open_interest_usd(long_leg, short_leg) or 0.0,
                long_leg.exchange,
                short_leg.exchange,
            )
            if best is None or key > best[0]:
                best = (key, long_leg, short_leg)
    if best is None:
        return None
    return best[1], best[2]


def build_opportunity_leg(
    snapshot: FundingSnapshot,
    *,
    quote: DepthQuote | None = None,
    taker_fee_bps: float | None = None,
) -> OpportunityLeg:
    return OpportunityLeg(
        exchange=snapshot.exchange,
        display_name=exchange_display_name(snapshot.exchange),
        exchange_symbol=snapshot.exchange_symbol,
        funding_rate=snapshot.funding_rate,
        max_leverage=snapshot.max_leverage,
        mark_price=snapshot.mark_price,
        open_interest_usd=snapshot.open_interest_usd,
        volume_24h=snapshot.volume_24h,
        taker_fee_bps=snapshot.taker_fee_bps if taker_fee_bps is None else taker_fee_bps,
        next_funding_time=snapshot.next_funding_time,
        funding_interval_hours=snapshot.funding_interval_hours,
        funding_rate_hourly=hourly_funding_rate(snapshot),
        interval_source=snapshot.metadata.get("interval_source"),
        slippage_round_trip_percent=quote.round_trip_percent if quote else None,
        depth_fillable=quote.fillable if quote else None,
        depth_measured_at=quote.measured_at if quote else None,
        top_of_book_spread_percent=quote.top_of_book_spread_percent if quote else None,
        trade_url=exchange_trade_url(snapshot.exchange, snapshot.exchange_symbol),
        best_bid_size=snapshot.metadata.get("best_bid_size"),
        best_ask_size=snapshot.metadata.get("best_ask_size"),
    )


def estimate_price_dislocation_percent(
    long_leg: FundingSnapshot,
    short_leg: FundingSnapshot,
) -> float | None:
    if not long_leg.mark_price or not short_leg.mark_price:
        return None

    midpoint = (long_leg.mark_price + short_leg.mark_price) / 2
    if not midpoint:
        return None

    return abs(long_leg.mark_price - short_leg.mark_price) / midpoint * 100


def combined_open_interest_usd(long_leg: FundingSnapshot, short_leg: FundingSnapshot) -> float | None:
    combined = (long_leg.open_interest_usd or 0.0) + (short_leg.open_interest_usd or 0.0)
    return combined or None


def estimate_max_leg_age_seconds(long_leg: FundingSnapshot, short_leg: FundingSnapshot) -> float:
    now = datetime.now(timezone.utc)
    return max(
        (now - long_leg.fetched_at).total_seconds(),
        (now - short_leg.fetched_at).total_seconds(),
    )
