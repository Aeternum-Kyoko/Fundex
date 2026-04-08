from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.models.market import ArbitrageOpportunity, FundingSnapshot
from app.services.funding_leaders import build_funding_leaders
from app.services.history_store import HistoryStore
from app.services.symbol_registry import build_symbol_aliases, normalize_symbol_query


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


class TelegramCommandService:
    def __init__(self, history_store: HistoryStore) -> None:
        self.history_store = history_store

    async def build_reply(
        self,
        chat_id: str,
        raw_text: str,
        snapshots: list[FundingSnapshot],
        opportunities: list[ArbitrageOpportunity],
    ) -> str:
        normalized = raw_text.strip()
        upper = normalized.upper()

        if upper in {"/START", "/HELP"}:
            return self.help_text()

        if upper == "/TOPPOSITIVE":
            return self._format_multi_exchange_funding(snapshots, positive=True)

        if upper == "/TOPNEGATIVE":
            return self._format_multi_exchange_funding(snapshots, positive=False)

        if upper == "/BINANCE":
            return self._format_single_exchange_funding(snapshots, "binance")

        if upper == "/DELTA":
            return self._format_single_exchange_funding(snapshots, "delta")

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
            state = "on" if enabled else "off"
            return f"Automatic alerts are now <b>{state}</b> for this chat."

        if upper == "/ALERTS":
            enabled = await self.history_store.get_alerts_enabled(chat_id)
            state = "on" if enabled else "off"
            return f"Automatic alerts are currently <b>{state}</b> for this chat."

        if upper.startswith("/COIN"):
            parts = normalized.split(maxsplit=1)
            normalized = parts[1].strip() if len(parts) > 1 else ""

        if not normalized:
            return "Send a coin symbol like BTC, ETH, SOL or use /coin BTC."

        match, error = self.find_opportunity(normalized, opportunities)
        if match is None:
            return error or (
                f"I could not find <b>{normalized.upper()}</b> in the current Binance vs Delta monitor.\n"
                "Use an exact coin like BTC or ETH, or the full symbol like BTC-USDT-PERP."
            )

        return self._format_coin_reply(match)

    def help_text(self) -> str:
        return (
            "<b>ArbRadar bot commands</b>\n\n"
            "/coin BTC - live Binance vs Delta view\n"
            "/toppositive - top positive funding on both exchanges\n"
            "/topnegative - top negative funding on both exchanges\n"
            "/binance - Binance positive and negative leaders\n"
            "/delta - Delta positive and negative leaders\n"
            "/watch BTC - add a symbol to your watchlist\n"
            "/unwatch BTC - remove a symbol from your watchlist\n"
            "/watchlist - show your watchlist\n"
            "/alerts on - enable automatic alerts for this chat\n"
            "/alerts off - disable automatic alerts for this chat"
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
            f"I could not find <b>{normalized_query.uppercase}</b> in the current Binance vs Delta monitor.\n"
            "Use an exact coin like BTC or ETH, or the full symbol like BTC-USDT-PERP."
        )

    def _format_coin_reply(self, match: ArbitrageOpportunity) -> str:
        next_funding_time = earliest_funding_time(match)
        now = datetime.now(timezone.utc)
        return (
            f"<b>{match.canonical_symbol}</b>\n\n"
            f"Symbol - {match.canonical_symbol}\n"
            f"Spread - {match.spread_rate * 100:.3f}%\n"
            f"{exchange_symbol_lines(match)[0]}\n"
            f"{exchange_symbol_lines(match)[1]}\n"
            f"{exchange_rate_lines(match)[0]}\n"
            f"{exchange_rate_lines(match)[1]}\n"
            f"Buy / Long - {match.long_leg.display_name}\n"
            f"Sell / Short - {match.short_leg.display_name}\n"
            f"Exchanges - {match.long_leg.display_name}, {match.short_leg.display_name}\n"
            f"Net APR - {match.net_apr_percent:.2f}%\n"
            f"Confidence - {match.confidence_score * 100:.0f}/100\n"
            f"Funding expiry - {format_countdown(next_funding_time, now)}"
        )

    def _format_multi_exchange_funding(self, snapshots: list[FundingSnapshot], *, positive: bool) -> str:
        leaders = build_funding_leaders(snapshots, limit=5)
        title = "Top Positive Funding" if positive else "Top Negative Funding"
        parts = [f"<b>{title}</b>"]
        for exchange in leaders.exchanges:
            selected = exchange.top_positive if positive else exchange.top_negative
            parts.extend(["", f"<b>{exchange.display_name}</b>"])
            if not selected:
                parts.append("No symbols right now.")
                continue
            for item in selected:
                parts.append(f"{item.canonical_symbol} - {item.funding_rate * 100:.3f}%")
        return "\n".join(parts)

    def _format_single_exchange_funding(self, snapshots: list[FundingSnapshot], exchange_name: str) -> str:
        leaders = build_funding_leaders(snapshots, limit=5, exchanges_to_include=(exchange_name,))
        exchange = leaders.exchanges[0]
        parts = [f"<b>{exchange.display_name}</b>", "", "<b>Top Positive</b>"]
        parts.extend(
            [f"{item.canonical_symbol} - {item.funding_rate * 100:.3f}%" for item in exchange.top_positive]
            or ["No positive symbols right now."]
        )
        parts.extend(["", "<b>Top Negative</b>"])
        parts.extend(
            [f"{item.canonical_symbol} - {item.funding_rate * 100:.3f}%" for item in exchange.top_negative]
            or ["No negative symbols right now."]
        )
        return "\n".join(parts)
