"""Shared Telegram message pieces so commands, alerts and trade results read the same way."""

from __future__ import annotations

from datetime import datetime, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.models.market import ArbitrageOpportunity, CaptureSetup, OpportunityLeg

SHORT_NAMES = {"binance": "Binance", "delta": "Delta", "coindcx": "CoinDCX", "wazirx": "WazirX", "coinswitch": "CoinSwitch"}


def zone(name: str | None):
    try:
        return ZoneInfo(name or "UTC")
    except ZoneInfoNotFoundError:
        return timezone.utc


def local_time(moment: datetime | None, tz_name: str | None) -> str:
    if moment is None:
        return "n/a"
    return moment.astimezone(zone(tz_name)).strftime("%H:%M")


def countdown(moment: datetime | None, now: datetime | None = None) -> str:
    if moment is None:
        return "n/a"
    seconds = int((moment - (now or datetime.now(timezone.utc))).total_seconds())
    if seconds <= 0:
        return "now"
    hours, rest = divmod(seconds, 3600)
    minutes, secs = divmod(rest, 60)
    if hours:
        return f"{hours}h {minutes:02d}m"
    return f"{minutes}m {secs:02d}s"


def signed_pct(value: float, digits: int = 4) -> str:
    return f"{'+' if value > 0 else '−' if value < 0 else ''}{abs(value):.{digits}f}%"


def usd(value: float | None) -> str:
    if value is None:
        return "n/a"
    return f"{'+' if value > 0 else '−' if value < 0 else ''}${abs(value):,.2f}"


def rate_with_interval(rate: float, interval_hours: int | None) -> str:
    if abs(rate) < 0.0000005:
        return f"flat / {interval_hours or 8}h"
    return f"{signed_pct(rate * 100)} / {interval_hours or 8}h"


def leg_line(side: str, leg: OpportunityLeg) -> str:
    return f"{side} {SHORT_NAMES.get(leg.exchange, leg.display_name)} {leg.exchange_symbol}: {rate_with_interval(leg.funding_rate, leg.funding_interval_hours)}"


def who_pays(capture: CaptureSetup) -> str:
    if capture.settling == "both":
        return "both legs settle"
    leg = capture.long_leg if capture.settling == "long" else capture.short_leg
    return f"only {SHORT_NAMES.get(leg.exchange, leg.display_name)} settles"


def capture_lines(capture: CaptureSetup, notional: float, tz_name: str | None, now: datetime | None = None) -> list[str]:
    net_usd = capture.net_percent / 100 * notional
    return [
        f"<b>Next settlement {local_time(capture.settles_at, tz_name)}</b> (in {countdown(capture.settles_at, now)}), {who_pays(capture)}",
        f"Sell {SHORT_NAMES.get(capture.short_leg.exchange)} {rate_with_interval(capture.short_leg.funding_rate, capture.short_leg.funding_interval_hours)}, "
        f"buy {SHORT_NAMES.get(capture.long_leg.exchange)} {rate_with_interval(capture.long_leg.funding_rate, capture.long_leg.funding_interval_hours)}",
        f"Collect {signed_pct(capture.capture_percent)}, costs {capture.cost_percent:.3f}% → net {signed_pct(capture.net_percent, 3)} ({usd(net_usd)} per ${notional:,.0f} leg)",
    ]


def hold_lines(opportunity: ArbitrageOpportunity, notional: float) -> list[str]:
    days = opportunity.holding_horizon_hours / 24
    break_even = opportunity.break_even_hours
    break_even_text = "never within 30d" if break_even is None else f"{break_even:.0f}h" if break_even < 48 else f"{break_even / 24:.1f}d"
    return [
        f"<b>Hold {days:g} days</b>: buy {SHORT_NAMES.get(opportunity.long_leg.exchange)}, sell {SHORT_NAMES.get(opportunity.short_leg.exchange)}",
        f"Spread {signed_pct(opportunity.spread_rate * 100)} per 8h, net {signed_pct(opportunity.net_return_percent, 3)} "
        f"({usd(opportunity.net_return_percent / 100 * notional)} per ${notional:,.0f} leg), break-even {break_even_text}",
    ]


def alert_lines(opportunity: ArbitrageOpportunity, notional: float) -> list[str]:
    """Compact, consistent live-funding alert details."""
    break_even = opportunity.break_even_hours
    break_even_text = "—" if break_even is None else f"{break_even:.0f}h" if break_even < 48 else f"{break_even / 24:.1f}d"
    days = opportunity.holding_horizon_hours / 24
    return [
        f"<b>Long</b> {SHORT_NAMES.get(opportunity.long_leg.exchange)}  ·  <b>Short</b> {SHORT_NAMES.get(opportunity.short_leg.exchange)}",
        f"Live spread <b>{signed_pct(opportunity.spread_rate * 100)}</b> / 8h",
        f"Est. {days:g}d net <b>{signed_pct(opportunity.net_return_percent, 3)}</b>  ·  {usd(opportunity.net_return_percent / 100 * notional)} per ${notional:,.0f} leg",
        f"Break-even {break_even_text}  ·  Slippage {opportunity.slippage_source}",
        f"↳ Long {rate_with_interval(opportunity.long_leg.funding_rate, opportunity.long_leg.funding_interval_hours)}  ·  "
        f"Short {rate_with_interval(opportunity.short_leg.funding_rate, opportunity.short_leg.funding_interval_hours)}",
    ]


def trust_line(opportunity: ArbitrageOpportunity, capture: bool = False) -> str:
    level = opportunity.capture.data_trust_level if capture and opportunity.capture else opportunity.trust_level
    hold_only = {"profit", "persistence", "first_payment"}
    worst = next(
        (
            check
            for status in ("fail", "warn")
            for check in opportunity.trust_checks
            if check.status == status and not (capture and check.key in hold_only)
        ),
        None,
    )
    return f"Trust: {level}" + (f". {worst.detail}" if worst else "")
