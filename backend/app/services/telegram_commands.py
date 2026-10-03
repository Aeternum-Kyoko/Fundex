from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.core.config import Settings
from app.models.market import ArbitrageOpportunity, FundingSnapshot
from app.services.funding_leaders import build_funding_leaders
from app.services.history_store import HistoryStore
from app.services.liquidity import enabled_exchange_names
from app.services.telegram_format import (
    SHORT_NAMES,
    capture_lines,
    countdown,
    hold_lines,
    leg_line,
    local_time,
    rate_with_interval,
    signed_pct,
    trust_line,
    usd,
    who_pays,
)
from app.services.opportunity_ranker import is_snapshot_usable
from app.services.symbol_registry import build_symbol_aliases, normalize_symbol_query


DISPLAY_NAMES = {
    "binance": "Binance",
    "delta": "Delta Exchange India",
    "coindcx": "CoinDCX",
    "coinswitch": "CoinSwitch",
    "wazirx": "WazirX",
}


def earliest_funding_time(opportunity: ArbitrageOpportunity) -> datetime | None:
    timestamps = [opportunity.long_leg.next_funding_time, opportunity.short_leg.next_funding_time]
    resolved = [timestamp for timestamp in timestamps if timestamp is not None]
    if not resolved:
        return None
    return min(resolved)


def format_countdown(timestamp: datetime | None, now: datetime) -> str:
    if timestamp is None:
        return "n/a"

    remaining = timestamp - now
    if remaining <= timedelta(minutes=1):
        return "due now"

    total_minutes = int(remaining.total_seconds() // 60)
    days, rem_minutes = divmod(total_minutes, 24 * 60)
    hours, minutes = divmod(rem_minutes, 60)

    if days > 0:
        return f"{days}d {hours}h"
    if hours > 0:
        return f"{hours}h {minutes}m"
    return f"{minutes}m"


def exchange_rate_lines(opportunity: ArbitrageOpportunity) -> list[str]:
    ordered_legs = sorted([opportunity.long_leg, opportunity.short_leg], key=lambda leg: leg.display_name)
    return [f"{leg.display_name} rate - {leg.funding_rate * 100:.3f}%" for leg in ordered_legs]


def exchange_symbol_lines(opportunity: ArbitrageOpportunity) -> list[str]:
    ordered_legs = sorted([opportunity.long_leg, opportunity.short_leg], key=lambda leg: leg.display_name)
    return [f"{leg.display_name} symbol - {leg.exchange_symbol}" for leg in ordered_legs]


def format_funding_rate(rate: float | None) -> str:
    if rate is None:
        return "n/a"
    if abs(rate) < 0.000005:
        return "flat"
    return f"{rate * 100:.3f}%"


class TelegramCommandService:
    def __init__(self, history_store: HistoryStore, settings: Settings, ranking_context=None, journal=None) -> None:
        self.history_store = history_store
        self.settings = settings
        self.ranking_context = ranking_context
        # Trade journal (set by the app) so /trades and /pnl can report paper and live results.
        self.journal = journal

    @property
    def _tz(self) -> str:
        return self.settings.telegram_daily_summary_timezone

    @property
    def _notional(self) -> float:
        return self.settings.liquidity_reference_notional_usd

    async def build_reply(
        self,
        chat_id: str,
        raw_text: str,
        snapshots: list[FundingSnapshot],
        opportunities: list[ArbitrageOpportunity],
    ) -> str:
        normalized = raw_text.strip()
        upper = normalized.upper()

        if upper in {"/START", "/HELP", "/COMMANDS"}:
            return self.help_text()

        if upper == "/EXCHANGES":
            return self._format_exchanges(snapshots)

        if upper == "/STATUS":
            return await self._format_status(chat_id)

        if upper == "/TOPPOSITIVE":
            return self._format_multi_exchange_funding(snapshots, positive=True)

        if upper == "/TOPNEGATIVE":
            return self._format_multi_exchange_funding(snapshots, positive=False)

        if upper == "/BINANCE":
            return self._format_single_exchange_funding(snapshots, "binance")

        if upper == "/DELTA":
            return self._format_single_exchange_funding(snapshots, "delta")

        if upper == "/COINDCX":
            return self._format_single_exchange_funding(snapshots, "coindcx")

        if upper == "/COINSWITCH":
            return self._format_single_exchange_funding(snapshots, "coinswitch")

        if upper == "/WAZIRX":
            return self._format_single_exchange_funding(snapshots, "wazirx")

        if upper in {"/NEXT", "/SOON"}:
            return self._format_next_settlements(opportunities)

        if upper in {"/TRADES", "/RESULTS", "/PNL"}:
            # Anyone can message a public bot, but trade results belong to the owner chats only.
            if chat_id not in self.settings.resolved_telegram_chat_ids:
                return "Trade results are only available in the chats this bot is set up for."
            return await (self._format_pnl() if upper == "/PNL" else self._format_trades())

        if upper.startswith("/WATCH "):
            symbol_query = normalized.split(maxsplit=1)[1].strip()
            match, error = self.find_opportunity(symbol_query, opportunities)
            if match is None:
                return error or f"I could not add <b>{symbol_query.upper()}</b>."
            await self.history_store.add_watch_symbol(chat_id, match.canonical_symbol)
            watchlist = await self.history_store.get_watch_symbols(chat_id)
            return (
                f"Watching <b>{match.canonical_symbol}</b>.\n"
                f"Your watchlist now has {len(watchlist)} symbol(s)."
            )

        if upper.startswith("/UNWATCH "):
            symbol_query = normalized.split(maxsplit=1)[1].strip()
            match, _ = self.find_opportunity(symbol_query, opportunities)
            canonical_symbol = match.canonical_symbol if match is not None else symbol_query.upper()
            await self.history_store.remove_watch_symbol(chat_id, canonical_symbol)
            watchlist = await self.history_store.get_watch_symbols(chat_id)
            return (
                f"Removed <b>{canonical_symbol}</b> from your watchlist.\n"
                f"Your watchlist now has {len(watchlist)} symbol(s)."
            )

        if upper == "/WATCHLIST":
            watchlist = await self.history_store.get_watch_symbols(chat_id)
            if not watchlist:
                return "Your watchlist is empty. Use /watch BTC or /watch SOL-USDT-PERP."
            return "<b>Your watchlist</b>\n\n" + "\n".join(f"- {symbol}" for symbol in watchlist)

        if upper in {"/ALERTS ON", "/ALERTS OFF"}:
            enabled = upper.endswith("ON")
            await self.history_store.set_alerts_enabled(chat_id, enabled)
            return self._format_alerts_status(enabled, opportunities)

        if upper == "/ALERTS":
            enabled = await self.history_store.get_alerts_enabled(chat_id)
            return self._format_alerts_status(enabled, opportunities)

        if upper.startswith("/COMPARE"):
            parts = normalized.split(maxsplit=1)
            symbol_query = parts[1].strip() if len(parts) > 1 else ""
            if not symbol_query:
                return "Use /compare BTC or /compare SOL-USDT-PERP."
            return self._format_compare_reply(symbol_query, snapshots, opportunities)

        if upper.startswith("/COIN"):
            parts = normalized.split(maxsplit=1)
            normalized = parts[1].strip() if len(parts) > 1 else ""

        if not normalized:
            return "Send a coin symbol like BTC, ETH, SOL or use /coin BTC or /compare BTC."

        match, error = self.find_opportunity(normalized, opportunities)
        if match is None:
            return error or (
                f"I could not find <b>{normalized.upper()}</b> in the current monitor.\n"
                "Use an exact coin like BTC or ETH, or the full symbol like BTC-USDT-PERP."
            )

        return self._format_coin_reply(match)

    def help_text(self) -> str:
        return (
            "<b>Fundex bot</b>\n\n"
            "<b>Find a trade</b>\n"
            "/next - settlements coming up that pay the most\n"
            "/coin BTC - next settlement and hold setup for a coin\n"
            "/compare BTC - every exchange's rate, interval and timing\n"
            "/toppositive, /topnegative - funding leaders\n"
            "/binance /delta /coindcx /wazirx /coinswitch - one exchange's leaders\n\n"
            "<b>Your results</b>\n"
            "/trades - recent paper and live trades\n"
            "/pnl - last 7 days, paper and live\n\n"
            "<b>Alerts</b>\n"
            "/alerts on, /alerts off - automatic alerts for this chat\n"
            "/watch BTC, /unwatch BTC, /watchlist\n"
            "/status, /exchanges, /commands"
        )

    def find_opportunity(
        self,
        query: str,
        opportunities: list[ArbitrageOpportunity],
    ) -> tuple[ArbitrageOpportunity | None, str | None]:
        normalized_query = normalize_symbol_query(query)
        if not normalized_query.compact:
            return None, "Send a coin symbol like BTC, ETH, SOL or use /coin BTC."

        exact_canonical = next(
            (item for item in opportunities if item.canonical_symbol.upper() == normalized_query.uppercase),
            None,
        )
        if exact_canonical is not None:
            return exact_canonical, None

        exact_exchange = next(
            (
                item
                for item in opportunities
                if item.long_leg.exchange_symbol.upper() == normalized_query.uppercase
                or item.short_leg.exchange_symbol.upper() == normalized_query.uppercase
            ),
            None,
        )
        if exact_exchange is not None:
            return exact_exchange, None

        matches = [
            item
            for item in opportunities
            if normalized_query.compact
            in build_symbol_aliases(
                item.canonical_symbol,
                item.base_asset,
                [item.long_leg.exchange_symbol, item.short_leg.exchange_symbol],
            )
        ]

        if len(matches) == 1:
            return matches[0], None

        if len(matches) > 1:
            candidates = ", ".join(sorted({item.canonical_symbol for item in matches})[:5])
            return None, (
                f"I found multiple matches for <b>{normalized_query.uppercase}</b>.\n"
                f"Please use the full symbol: {candidates}"
            )

        return None, (
            f"I could not find <b>{normalized_query.uppercase}</b> in the current monitor.\n"
            "Use an exact coin like BTC or ETH, or the full symbol like BTC-USDT-PERP."
        )

    def find_canonical_symbol(
        self,
        query: str,
        snapshots: list[FundingSnapshot],
        opportunities: list[ArbitrageOpportunity],
    ) -> tuple[str | None, str | None]:
        match, error = self.find_opportunity(query, opportunities)
        if match is not None:
            return match.canonical_symbol, None

        normalized_query = normalize_symbol_query(query)
        if not normalized_query.compact:
            return None, "Send a coin symbol like BTC, ETH, SOL or use /compare BTC."

        exact_canonical = next(
            (snapshot.canonical_symbol for snapshot in snapshots if snapshot.canonical_symbol.upper() == normalized_query.uppercase),
            None,
        )
        if exact_canonical is not None:
            return exact_canonical, None

        exact_exchange = next(
            (snapshot.canonical_symbol for snapshot in snapshots if snapshot.exchange_symbol.upper() == normalized_query.uppercase),
            None,
        )
        if exact_exchange is not None:
            return exact_exchange, None

        matches = sorted(
            {
                snapshot.canonical_symbol
                for snapshot in snapshots
                if normalized_query.compact
                in build_symbol_aliases(
                    snapshot.canonical_symbol,
                    snapshot.base_asset,
                    [snapshot.exchange_symbol],
                )
            }
        )

        if len(matches) == 1:
            return matches[0], None

        if len(matches) > 1:
            candidates = ", ".join(matches[:5])
            return None, (
                f"I found multiple matches for <b>{normalized_query.uppercase}</b>.\n"
                f"Please use the full symbol: {candidates}"
            )

        return None, error

    def _format_coin_reply(self, match: ArbitrageOpportunity) -> str:
        now = datetime.now(timezone.utc)
        parts = [f"<b>{match.base_asset}</b>", ""]
        if match.capture is not None and match.capture.capture_percent > 0:
            parts.extend(capture_lines(match.capture, self._notional, self._tz, now))
            parts.append(trust_line(match, capture=True))
            parts.append("")
        parts.extend(hold_lines(match, self._notional))
        parts.append(leg_line("Long", match.long_leg))
        parts.append(leg_line("Short", match.short_leg))
        parts.append(trust_line(match))
        return "\n".join(parts)

    def _format_compare_reply(
        self,
        query: str,
        snapshots: list[FundingSnapshot],
        opportunities: list[ArbitrageOpportunity],
    ) -> str:
        canonical_symbol, error = self.find_canonical_symbol(query, snapshots, opportunities)
        if canonical_symbol is None:
            return error or f"I could not find <b>{query.upper()}</b>."

        matching_snapshots = [
            snapshot
            for snapshot in snapshots
            if snapshot.canonical_symbol == canonical_symbol and is_snapshot_usable(snapshot)
        ]
        if not matching_snapshots:
            return f"No live exchange snapshots are available for <b>{canonical_symbol}</b> right now."

        now = datetime.now(timezone.utc)
        opportunity = next((item for item in opportunities if item.canonical_symbol == canonical_symbol), None)

        parts = [f"<b>{canonical_symbol.split('-')[0]} across exchanges</b>"]
        snapshot_map = {snapshot.exchange: snapshot for snapshot in matching_snapshots}
        for exchange in enabled_exchange_names(self.settings, self.ranking_context):
            snapshot = snapshot_map.get(exchange)
            if snapshot is None:
                parts.append(f"<b>{self._display_name(exchange)}</b>: not listed")
                continue
            parts.append(f"<b>{self._display_name(exchange)}</b>")

            parts.append(
                f"{snapshot.exchange_symbol}: {rate_with_interval(snapshot.funding_rate, snapshot.funding_interval_hours)}, "
                f"settles {local_time(snapshot.next_funding_time, self._tz)} (in {countdown(snapshot.next_funding_time, now)}), "
                f"mark {self._format_number(snapshot.mark_price)}, OI {self._format_usd(snapshot.open_interest_usd)}"
            )

        if opportunity is not None:
            parts.append("")
            if opportunity.capture is not None and opportunity.capture.capture_percent > 0:
                parts.extend(capture_lines(opportunity.capture, self._notional, self._tz, now))
                parts.append("")
            parts.extend(hold_lines(opportunity, self._notional))
            parts.append(trust_line(opportunity))

        return "\n".join(parts)

    def _format_multi_exchange_funding(self, snapshots: list[FundingSnapshot], *, positive: bool) -> str:
        leaders = build_funding_leaders(snapshots, limit=5)
        title = "Highest funding (shorts get paid)" if positive else "Lowest funding (longs get paid)"
        parts = [f"<b>{title}</b>"]
        for exchange in leaders.exchanges:
            selected = exchange.top_positive if positive else exchange.top_negative
            parts.extend(["", f"<b>{exchange.display_name}</b>"])
            if not selected:
                parts.append("No symbols right now.")
                continue
            for item in selected:
                parts.append(f"{item.base_asset} {rate_with_interval(item.funding_rate, item.funding_interval_hours)}")
        return "\n".join(parts)

    def _format_single_exchange_funding(self, snapshots: list[FundingSnapshot], exchange_name: str) -> str:
        leaders = build_funding_leaders(snapshots, limit=5, exchanges_to_include=(exchange_name,))
        exchange = leaders.exchanges[0]
        parts = [f"<b>{exchange.display_name}</b>", "", "<b>Shorts get paid most</b>"]
        parts.extend(
            [f"{item.base_asset} {rate_with_interval(item.funding_rate, item.funding_interval_hours)}" for item in exchange.top_positive]
            or ["No positive symbols right now."]
        )
        parts.extend(["", "<b>Longs get paid most</b>"])
        parts.extend(
            [f"{item.base_asset} {rate_with_interval(item.funding_rate, item.funding_interval_hours)}" for item in exchange.top_negative]
            or ["No negative symbols right now."]
        )
        return "\n".join(parts)

    def _format_next_settlements(self, opportunities: list[ArbitrageOpportunity]) -> str:
        now = datetime.now(timezone.utc)
        rows = sorted(
            (item for item in opportunities if item.capture is not None and item.capture.capture_percent >= 0.01),
            key=lambda item: (item.capture.settles_at, -item.capture.net_percent),  # type: ignore[union-attr]
        )[:8]
        if not rows:
            return "No settlement is paying a meaningful amount right now."
        parts = [f"<b>Next settlements worth a trade</b> (costs at ${self._notional:,.0f} per leg)", ""]
        for item in rows:
            capture = item.capture
            parts.append(
                f"<b>{item.base_asset}</b> {local_time(capture.settles_at, self._tz)} (in {countdown(capture.settles_at, now)}): "
                f"sell {SHORT_NAMES.get(capture.short_leg.exchange)}, buy {SHORT_NAMES.get(capture.long_leg.exchange)}, {who_pays(capture)}. "
                f"Collect {signed_pct(capture.capture_percent)}, net {usd(capture.net_percent / 100 * self._notional)}"
            )
        return "\n".join(parts)

    async def _format_trades(self) -> str:
        if self.journal is None:
            return "Trade results are not available on this server."
        trades = await self.journal.list(limit=6)
        if not trades:
            return "No paper or live trades yet. Arm one from the trade desk."
        parts = ["<b>Recent trades</b>", ""]
        for trade in trades:
            result = trade.realized_net_pnl_usd
            parts.append(
                f"<b>{trade.canonical_symbol.split('-')[0]}</b> {trade.mode}, {trade.status}: "
                f"{usd(result) if result is not None else 'planned ' + usd(trade.expected_net_pnl_usd)}"
                f" ({local_time(trade.created_at, self._tz)})"
            )
        return "\n".join(parts)

    async def _format_pnl(self) -> str:
        if self.journal is None:
            return "Trade results are not available on this server."
        since = datetime.now(timezone.utc) - timedelta(days=7)
        trades = [trade for trade in await self.journal.list(limit=500) if trade.created_at >= since and trade.realized_net_pnl_usd is not None]
        if not trades:
            return "No finished trades in the last 7 days."
        lines = ["<b>Last 7 days</b>", ""]
        for mode in ("paper", "live"):
            subset = [trade for trade in trades if trade.mode == mode]
            if not subset:
                continue
            net = sum(trade.realized_net_pnl_usd or 0 for trade in subset)
            wins = sum(1 for trade in subset if (trade.realized_net_pnl_usd or 0) > 0)
            funding = sum(trade.realized_funding_pnl_usd or 0 for trade in subset)
            fees = sum(trade.realized_total_fees_usd or 0 for trade in subset)
            lines.append(
                f"<b>{mode.title()}</b>: {len(subset)} trades, {wins} won, net {usd(net)} (funding {usd(funding)}, fees {usd(-fees)})"
            )
        return "\n".join(lines)

    def _format_exchanges(self, snapshots: list[FundingSnapshot]) -> str:
        exchange_names = sorted({snapshot.exchange for snapshot in snapshots})
        if not exchange_names:
            return "No active exchanges are available right now."
        parts = ["<b>Active exchanges</b>", ""]
        parts.extend(f"- {self._display_name(exchange)}" for exchange in exchange_names)
        return "\n".join(parts)

    async def _format_status(self, chat_id: str) -> str:
        alerts_enabled = await self.history_store.get_alerts_enabled(chat_id)
        watchlist = await self.history_store.get_watch_symbols(chat_id)
        return (
            "<b>Your bot status</b>\n\n"
            f"Automatic alerts - <b>{'on' if alerts_enabled else 'off'}</b>\n"
            f"Watchlist size - <b>{len(watchlist)}</b>\n"
            f"Saved symbols - {', '.join(watchlist[:8]) if watchlist else 'none'}"
        )

    def _format_alerts_status(self, enabled: bool, opportunities: list[ArbitrageOpportunity]) -> str:
        state = "on" if enabled else "off"
        ranked = self._rank_live_alerts(opportunities)
        parts = [f"Automatic alerts are currently <b>{state}</b> for this chat."]

        if not ranked:
            parts.extend(
                [
                    "",
                    "No live alerts match the current thresholds right now.",
                ]
            )
            return "\n".join(parts)

        now = datetime.now(timezone.utc)
        parts.extend(["", f"<b>Live alerts right now</b>", f"Showing top {len(ranked)} qualified symbols."])

        for index, opportunity in enumerate(ranked, start=1):
            next_funding_time = earliest_funding_time(opportunity)
            parts.extend(
                [
                    "",
                    f"<b>{index}. {opportunity.canonical_symbol}</b>",
                    f"Spread - {opportunity.spread_rate * 100:.3f}%",
                    f"Buy / Long - {opportunity.long_leg.display_name}",
                    f"Sell / Short - {opportunity.short_leg.display_name}",
                    f"Confidence - {opportunity.confidence_score * 100:.0f}/100",
                    f"Combined OI - {self._format_usd(opportunity.combined_open_interest_usd)}",
                    f"Funding expiry - {format_countdown(next_funding_time, now)}",
                ]
            )

        return "\n".join(parts)

    def _rank_live_alerts(self, opportunities: list[ArbitrageOpportunity]) -> list[ArbitrageOpportunity]:
        qualified = [
            opportunity
            for opportunity in opportunities
            if not self._alert_quality_failures(opportunity)
        ]
        return sorted(qualified, key=self._sort_key)[: self.settings.telegram_top_n]

    def _alert_quality_failures(self, opportunity: ArbitrageOpportunity) -> list[str]:
        reasons: list[str] = []

        if opportunity.spread_rate * 100 < self.settings.telegram_min_spread_percent:
            reasons.append(f"spread below {self.settings.telegram_min_spread_percent:.2f}%")

        if opportunity.confidence_score < self.settings.telegram_min_confidence_score:
            reasons.append(f"confidence below {self.settings.telegram_min_confidence_score:.2f}")

        combined_oi = opportunity.combined_open_interest_usd or 0.0
        if combined_oi < self.settings.telegram_min_combined_oi_usd:
            reasons.append(f"combined OI below ${self.settings.telegram_min_combined_oi_usd:,.0f}")

        max_age = opportunity.max_leg_age_seconds
        if max_age is None or max_age > self.settings.telegram_max_staleness_seconds:
            reasons.append(f"stale data above {self.settings.telegram_max_staleness_seconds}s")

        return reasons

    def _sort_key(self, opportunity: ArbitrageOpportunity) -> tuple[datetime, float, str]:
        return (
            earliest_funding_time(opportunity) or datetime.max.replace(tzinfo=timezone.utc),
            -opportunity.spread_rate,
            opportunity.base_asset,
        )

    def _display_name(self, exchange: str) -> str:
        return DISPLAY_NAMES.get(exchange, exchange.title())

    def _format_usd(self, value: float | None) -> str:
        if value is None:
            return "n/a"
        return f"${value:,.0f}"

    def _format_number(self, value: float | None) -> str:
        if value is None:
            return "n/a"
        return f"{value:,.6f}".rstrip("0").rstrip(".")
