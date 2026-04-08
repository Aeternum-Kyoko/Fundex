from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from httpx import AsyncClient

from app.core.config import Settings
from app.models.market import ArbitrageOpportunity


def _earliest_funding_time(opportunity: ArbitrageOpportunity) -> datetime | None:
    timestamps = [opportunity.long_leg.next_funding_time, opportunity.short_leg.next_funding_time]
    resolved = [timestamp for timestamp in timestamps if timestamp is not None]
    if not resolved:
        return None
    return min(resolved)


def _format_countdown(timestamp: datetime | None, now: datetime) -> str:
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


def _exchange_rate_lines(opportunity: ArbitrageOpportunity) -> list[str]:
    ordered_legs = sorted(
        [opportunity.long_leg, opportunity.short_leg],
        key=lambda leg: leg.display_name,
    )
    return [
        f"{leg.display_name} rate - {leg.funding_rate * 100:.3f}%"
        for leg in ordered_legs
    ]


def _exchange_symbol_lines(opportunity: ArbitrageOpportunity) -> list[str]:
    ordered_legs = sorted(
        [opportunity.long_leg, opportunity.short_leg],
        key=lambda leg: leg.display_name,
    )
    return [
        f"{leg.display_name} symbol - {leg.exchange_symbol}"
        for leg in ordered_legs
    ]


@dataclass
class TelegramAlertBatch:
    opportunities: list[ArbitrageOpportunity]
    message: str
    signature: str


class TelegramNotifier:
    def __init__(self, client: AsyncClient, settings: Settings) -> None:
        self.client = client
        self.settings = settings
        self._last_sent_signature: str | None = None
        self._last_sent_at: datetime | None = None
        self._last_error: str | None = None
        self._update_offset: int | None = None

    @property
    def enabled(self) -> bool:
        return self.settings.telegram_enabled

    @property
    def configured(self) -> bool:
        return bool(self.settings.telegram_bot_token and self.settings.resolved_telegram_chat_ids)

    def status(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "configured": self.configured,
            "chat_id": self.settings.telegram_chat_id,
            "chat_ids": self.settings.resolved_telegram_chat_ids,
            "min_spread_percent": self.settings.telegram_min_spread_percent,
            "top_n": self.settings.telegram_top_n,
            "cooldown_minutes": self.settings.telegram_cooldown_minutes,
            "poll_interval_seconds": self.settings.telegram_poll_interval_seconds,
            "last_sent_at": self._last_sent_at.isoformat() if self._last_sent_at else None,
            "last_error": self._last_error,
            "last_signature": self._last_sent_signature,
            "update_offset": self._update_offset,
        }

    def preview(self, opportunities: list[ArbitrageOpportunity]) -> TelegramAlertBatch | None:
        return self._build_batch(opportunities)

    async def discover_chats(self) -> list[dict[str, Any]]:
        payload = await self._get_updates()
        if payload is None:
            return []

        chats: dict[str, dict[str, Any]] = {}
        for update in payload.get("result", []):
            message = update.get("message") or update.get("channel_post") or {}
            chat = message.get("chat") or {}
            chat_id = chat.get("id")
            if chat_id is None:
                continue
            chats[str(chat_id)] = {
                "chat_id": str(chat_id),
                "type": chat.get("type"),
                "title": chat.get("title"),
                "username": chat.get("username"),
                "first_name": chat.get("first_name"),
                "last_message_text": message.get("text"),
            }

        return sorted(chats.values(), key=lambda item: item["chat_id"])

    async def notify(self, opportunities: list[ArbitrageOpportunity]) -> None:
        if not self.enabled or not self.configured:
            return

        batch = self._build_batch(opportunities)
        if batch is None:
            return

        now = datetime.now(timezone.utc)
        if self._last_sent_signature == batch.signature and self._last_sent_at is not None:
            cooldown = timedelta(minutes=self.settings.telegram_cooldown_minutes)
            if now - self._last_sent_at < cooldown:
                return

        try:
            await self._send_text(batch.message)
            self._last_sent_signature = batch.signature
            self._last_sent_at = now
            self._last_error = None
        except Exception as exc:  # pragma: no cover
            self._last_error = str(exc)

    async def send_test_message(self, text: str | None = None) -> dict[str, Any]:
        if not self.enabled or not self.configured:
            return {"sent": False, "reason": "Telegram is not configured."}

        message = text or (
            "<b>ArbRadar Telegram bot is connected.</b>\n\n"
            "You will receive alerts here when Binance vs Delta spread is at or above 0.50% "
            "and the symbol is in the top 5 nearest funding expiries."
        )
        await self._send_text(message)
        return {
            "sent": True,
            "chat_ids": self.settings.resolved_telegram_chat_ids,
            "message": message,
        }

    async def send_demo_alert(self) -> dict[str, Any]:
        message = (
            "<b>Alert!</b>\n\n"
            "Symbol - SOL-USDT-PERP\n"
            "Spread - 1.000%\n"
            "Binance symbol - SOLUSDT\n"
            "Delta Exchange India symbol - SOLUSD\n"
            "Binance rate - 0.350%\n"
            "Delta Exchange India rate - -0.650%\n"
            "Buy / Long - Delta Exchange India\n"
            "Sell / Short - Binance\n"
            "Exchanges - Delta Exchange India, Binance\n"
            "Funding expiry - 1h 30m\n\n"
            "Reply with a coin like <b>SOL</b> or use <b>/coin SOL</b> to get live info."
        )
        await self._send_text(message)
        return {
            "sent": True,
            "chat_ids": self.settings.resolved_telegram_chat_ids,
            "message": message,
        }

    async def process_updates(self, opportunities: list[ArbitrageOpportunity]) -> dict[str, Any]:
        if not self.enabled or not self.settings.telegram_bot_token:
            return {"processed": 0}

        payload = await self._get_updates(offset=self._update_offset)
        if payload is None:
            return {"processed": 0}

        processed = 0
        for update in payload.get("result", []):
            update_id = update.get("update_id")
            if isinstance(update_id, int):
                self._update_offset = update_id + 1

            message = update.get("message") or {}
            chat = message.get("chat") or {}
            chat_id = chat.get("id")
            text = (message.get("text") or "").strip()
            if chat_id is None or not text:
                continue

            reply = self._build_coin_reply(text, opportunities)
            try:
                await self._send_text_to_chat(str(chat_id), reply)
                processed += 1
                self._last_error = None
            except Exception as exc:  # pragma: no cover
                self._last_error = str(exc)

        return {"processed": processed, "offset": self._update_offset}

    def _build_batch(self, opportunities: list[ArbitrageOpportunity]) -> TelegramAlertBatch | None:
        now = datetime.now(timezone.utc)
        eligible = [
            opportunity
            for opportunity in opportunities
            if opportunity.spread_rate * 100 >= self.settings.telegram_min_spread_percent
        ]

        ranked = sorted(
            eligible,
            key=lambda opportunity: (
                _earliest_funding_time(opportunity) or datetime.max.replace(tzinfo=timezone.utc),
                -opportunity.spread_rate,
                opportunity.base_asset,
            ),
        )[: self.settings.telegram_top_n]

        if not ranked:
            return None

        parts = [
            "<b>Alert!</b>",
            "",
            f"Top {len(ranked)} coins with funding expiring soon and spread above {self.settings.telegram_min_spread_percent:.2f}%",
        ]
        signature_parts: list[str] = []

        for index, opportunity in enumerate(ranked, start=1):
            next_funding_time = _earliest_funding_time(opportunity)
            signature_parts.append(
                f"{opportunity.canonical_symbol}:{next_funding_time.isoformat() if next_funding_time else 'n/a'}"
            )
            parts.extend(
                [
                    "",
                    f"<b>{index}. {opportunity.canonical_symbol}</b>",
                    f"Symbol - {opportunity.canonical_symbol}",
                    f"Spread - {opportunity.spread_rate * 100:.3f}%",
                    *_exchange_symbol_lines(opportunity),
                    *_exchange_rate_lines(opportunity),
                    f"Buy / Long - {opportunity.long_leg.display_name}",
                    f"Sell / Short - {opportunity.short_leg.display_name}",
                    f"Exchanges - {opportunity.long_leg.display_name}, {opportunity.short_leg.display_name}",
                    f"Funding expiry - {_format_countdown(next_funding_time, now)}",
                ]
            )

        return TelegramAlertBatch(
            opportunities=ranked,
            message="\n".join(parts),
            signature="|".join(signature_parts),
        )

    def _build_coin_reply(self, raw_text: str, opportunities: list[ArbitrageOpportunity]) -> str:
        query = raw_text.strip().upper()
        if query in {"/START", "/HELP"}:
            return (
                "<b>ArbRadar bot commands</b>\n\n"
                "Send an exact coin like <b>SOL</b>, <b>BTC</b>, or <b>ETH</b>\n"
                "Or use the full symbol like <b>SOL-USDT-PERP</b>\n"
                "Or use <b>/coin SOL</b>\n\n"
                "I will reply with the live Binance vs Delta spread, where to buy / long, and where to sell / short."
            )

        if query.startswith("/COIN"):
            parts = raw_text.split(maxsplit=1)
            query = parts[1].strip().upper() if len(parts) > 1 else ""

        query = query.replace("$", "").replace("-", "").strip()
        if not query:
            return "Send a coin symbol like BTC, ETH, or SOL."

        match = self._find_opportunity(query, opportunities)
        if match is None:
            return (
                f"I could not find <b>{query}</b> in the current Binance vs Delta monitor.\n"
                "Use an exact coin like BTC or ETH, or the full symbol like BTC-USDT-PERP."
            )

        next_funding_time = _earliest_funding_time(match)
        now = datetime.now(timezone.utc)
        return (
            f"<b>{match.canonical_symbol}</b>\n\n"
            f"Symbol - {match.canonical_symbol}\n"
            f"Spread - {match.spread_rate * 100:.3f}%\n"
            f"{_exchange_symbol_lines(match)[0]}\n"
            f"{_exchange_symbol_lines(match)[1]}\n"
            f"{_exchange_rate_lines(match)[0]}\n"
            f"{_exchange_rate_lines(match)[1]}\n"
            f"Buy / Long - {match.long_leg.display_name}\n"
            f"Sell / Short - {match.short_leg.display_name}\n"
            f"Exchanges - {match.long_leg.display_name}, {match.short_leg.display_name}\n"
            f"Net APR - {match.net_apr_percent:.2f}%\n"
            f"Confidence - {match.confidence_score * 100:.0f}/100\n"
            f"Funding expiry - {_format_countdown(next_funding_time, now)}"
        )

    def _find_opportunity(self, query: str, opportunities: list[ArbitrageOpportunity]) -> ArbitrageOpportunity | None:
        compact_query = query.replace("-", "").replace("_", "").replace("/", "").replace(" ", "")

        exact_base = next((item for item in opportunities if item.base_asset.upper() == query), None)
        if exact_base is not None:
            return exact_base

        exact_symbol = next((item for item in opportunities if item.canonical_symbol.upper() == query), None)
        if exact_symbol is not None:
            return exact_symbol

        compact_symbol = next(
            (
                item
                for item in opportunities
                if item.canonical_symbol.upper().replace("-", "") == compact_query
            ),
            None,
        )
        if compact_symbol is not None:
            return compact_symbol

        return next(
            (
                item
                for item in opportunities
                if item.long_leg.exchange_symbol.upper() == compact_query or item.short_leg.exchange_symbol.upper() == compact_query
            ),
            None,
        )

    async def _get_updates(self, offset: int | None = None) -> dict[str, Any] | None:
        if not self.settings.telegram_bot_token:
            return None

        try:
            params: dict[str, Any] = {"timeout": 0}
            if offset is not None:
                params["offset"] = offset
            response = await self.client.get(
                f"https://api.telegram.org/bot{self.settings.telegram_bot_token}/getUpdates",
                params=params,
                timeout=15.0,
            )
            response.raise_for_status()
            payload = response.json()
            if not payload.get("ok", False):
                raise RuntimeError(payload.get("description", "Telegram rejected the request."))
            self._last_error = None
            return payload
        except Exception as exc:  # pragma: no cover
            self._last_error = str(exc)
            return None

    async def _send_text(self, text: str) -> None:
        if not self.settings.telegram_bot_token:
            raise RuntimeError("Telegram bot token is missing.")

        errors: list[str] = []
        for chat_id in self.settings.resolved_telegram_chat_ids:
            try:
                await self._send_text_to_chat(chat_id, text)
            except Exception as exc:  # pragma: no cover
                errors.append(f"{chat_id}: {exc}")

        if errors:
            raise RuntimeError("; ".join(errors))

    async def _send_text_to_chat(self, chat_id: str, text: str) -> None:
        if not self.settings.telegram_bot_token:
            raise RuntimeError("Telegram bot token is missing.")

        response = await self.client.post(
            f"https://api.telegram.org/bot{self.settings.telegram_bot_token}/sendMessage",
            json={
                "chat_id": chat_id,
                "text": text,
                "parse_mode": "HTML",
                "disable_web_page_preview": True,
            },
            timeout=15.0,
        )
        response.raise_for_status()
        payload = response.json()
        if not payload.get("ok", False):
            raise RuntimeError(payload.get("description", "Telegram rejected the message."))
