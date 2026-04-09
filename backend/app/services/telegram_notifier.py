from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from httpx import AsyncClient

from app.core.config import Settings
from app.models.market import ArbitrageOpportunity, FundingSnapshot
from app.services.history_store import HistoryStore
from app.services.telegram_commands import (
    TelegramCommandService,
    earliest_funding_time,
    exchange_rate_lines,
    exchange_symbol_lines,
    format_countdown,
)


logger = logging.getLogger(__name__)


@dataclass
class TelegramAlertBatch:
    opportunities: list[ArbitrageOpportunity]
    message: str
    signature: str


@dataclass
class AlertCandidate:
    opportunity: ArbitrageOpportunity
    reasons: list[str]


@dataclass
class AlertTransitionBatch:
    entered: list[AlertCandidate]
    exited: list[tuple[str, str]]
    message: str
    signature: str


class TelegramNotifier:
    def __init__(self, client: AsyncClient, settings: Settings, history_store: HistoryStore) -> None:
        self.client = client
        self.settings = settings
        self.history_store = history_store
        self.command_service = TelegramCommandService(history_store)
        self._last_sent_signature: str | None = None
        self._last_sent_at: datetime | None = None
        self._last_error: str | None = None
        self._update_offset: int | None = None
        self._metrics: dict[str, int] = {
            "notifications_sent": 0,
            "entered_symbols_sent": 0,
            "exited_symbols_sent": 0,
            "command_replies_sent": 0,
            "update_polls": 0,
            "update_errors": 0,
        }

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
            "min_confidence_score": self.settings.telegram_min_confidence_score,
            "min_combined_oi_usd": self.settings.telegram_min_combined_oi_usd,
            "max_staleness_seconds": self.settings.telegram_max_staleness_seconds,
            "top_n": self.settings.telegram_top_n,
            "cooldown_minutes": self.settings.telegram_cooldown_minutes,
            "poll_interval_seconds": self.settings.telegram_poll_interval_seconds,
            "last_sent_at": self._last_sent_at.isoformat() if self._last_sent_at else None,
            "last_error": self._last_error,
            "last_signature": self._last_sent_signature,
            "update_offset": self._update_offset,
            "metrics": dict(self._metrics),
        }

    def preview(self, opportunities: list[ArbitrageOpportunity]) -> TelegramAlertBatch | None:
        return self._build_preview_batch(opportunities)

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

        transition_batch = await self._build_transition_batch(opportunities)
        if transition_batch is None:
            return

        try:
            chat_ids = await self.history_store.get_alert_enabled_chat_ids(self.settings.resolved_telegram_chat_ids)
            if chat_ids:
                await self._send_text(transition_batch.message, chat_ids=chat_ids)
                self._metrics["notifications_sent"] += 1
                self._metrics["entered_symbols_sent"] += len(transition_batch.entered)
                self._metrics["exited_symbols_sent"] += len(transition_batch.exited)
                logger.info(
                    "Sent Telegram alert update to %s chats (%s entered, %s exited)",
                    len(chat_ids),
                    len(transition_batch.entered),
                    len(transition_batch.exited),
                )

            for candidate in transition_batch.entered:
                await self.history_store.mark_symbol_alert_entered(candidate.opportunity)
            for canonical_symbol, reason in transition_batch.exited:
                await self.history_store.mark_symbol_alert_exited(canonical_symbol, reason)

            self._last_sent_signature = transition_batch.signature
            self._last_sent_at = datetime.now(timezone.utc)
            self._last_error = None
        except Exception as exc:  # pragma: no cover
            self._last_error = str(exc)
            logger.exception("Telegram notification send failed")

    async def send_test_message(self, text: str | None = None) -> dict[str, Any]:
        if not self.enabled or not self.configured:
            return {"sent": False, "reason": "Telegram is not configured."}

        message = text or (
            "<b>ArbRadar Telegram bot is connected.</b>\n\n"
            "You will receive alerts here when spread, confidence, liquidity, "
            "and freshness all meet the configured thresholds."
        )
        await self._send_text(message)
        return {
            "sent": True,
            "chat_ids": self.settings.resolved_telegram_chat_ids,
            "message": message,
        }

    async def send_demo_alert(self) -> dict[str, Any]:
        message = (
            "<b>Alert Update</b>\n\n"
            "<b>Entered alerts</b>\n\n"
            "<b>1. SOL-USDT-PERP</b>\n"
            "Symbol - SOL-USDT-PERP\n"
            "Spread - 1.000%\n"
            "Binance symbol - SOLUSDT\n"
            "Delta Exchange India symbol - SOLUSD\n"
            "Binance rate - 0.350%\n"
            "Delta Exchange India rate - -0.650%\n"
            "Buy / Long - Delta Exchange India\n"
            "Sell / Short - Binance\n"
            "Confidence - 91/100\n"
            "Combined OI - $12,400,000\n"
            "Data age - 11s\n"
            "Funding expiry - 1h 30m\n\n"
            "<b>Exited alerts</b>\n\n"
            "<b>1. XRP-USDT-PERP</b>\n"
            "Exit reason - spread below 0.50%"
        )
        await self._send_text(message)
        return {
            "sent": True,
            "chat_ids": self.settings.resolved_telegram_chat_ids,
            "message": message,
        }

    async def process_updates(self, snapshots: list[FundingSnapshot], opportunities: list[ArbitrageOpportunity]) -> dict[str, Any]:
        if not self.enabled or not self.settings.telegram_bot_token:
            return {"processed": 0}

        payload = await self._get_updates(offset=self._update_offset)
        if payload is None:
            return {"processed": 0}
        self._metrics["update_polls"] += 1

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

            reply = await self.command_service.build_reply(str(chat_id), text, snapshots, opportunities)
            try:
                await self._send_text_to_chat(str(chat_id), reply)
                processed += 1
                self._metrics["command_replies_sent"] += 1
                self._last_error = None
            except Exception as exc:  # pragma: no cover
                self._last_error = str(exc)
                logger.exception("Telegram command reply send failed")

        return {"processed": processed, "offset": self._update_offset}

    def _build_preview_batch(self, opportunities: list[ArbitrageOpportunity]) -> TelegramAlertBatch | None:
        ranked_candidates = self._rank_alert_candidates(opportunities)
        ranked = [candidate.opportunity for candidate in ranked_candidates]
        if not ranked_candidates:
            return None

        now = datetime.now(timezone.utc)
        parts = [
            "<b>Alert Preview</b>",
            "",
            (
                f"Qualified symbols meeting spread >= {self.settings.telegram_min_spread_percent:.2f}%, "
                f"confidence >= {self.settings.telegram_min_confidence_score:.2f}, "
                f"combined OI >= ${self.settings.telegram_min_combined_oi_usd:,.0f}, "
                f"and age <= {self.settings.telegram_max_staleness_seconds}s"
            ),
        ]
        signature_parts: list[str] = []

        for index, candidate in enumerate(ranked_candidates, start=1):
            opportunity = candidate.opportunity
            next_funding_time = earliest_funding_time(opportunity)
            signature_parts.append(
                f"{opportunity.canonical_symbol}:{next_funding_time.isoformat() if next_funding_time else 'n/a'}"
            )
            parts.extend(
                [
                    "",
                    f"<b>{index}. {opportunity.canonical_symbol}</b>",
                    f"Spread - {opportunity.spread_rate * 100:.3f}%",
                    *exchange_symbol_lines(opportunity),
                    *exchange_rate_lines(opportunity),
                    f"Confidence - {opportunity.confidence_score * 100:.0f}/100",
                    f"Combined OI - ${opportunity.combined_open_interest_usd or 0:,.0f}",
                    f"Data age - {self._format_age(opportunity.max_leg_age_seconds)}",
                    f"Funding expiry - {format_countdown(next_funding_time, now)}",
                ]
            )

        return TelegramAlertBatch(
            opportunities=ranked,
            message="\n".join(parts),
            signature="|".join(signature_parts),
        )

    async def _build_transition_batch(self, opportunities: list[ArbitrageOpportunity]) -> AlertTransitionBatch | None:
        ranked_candidates = self._rank_alert_candidates(opportunities)
        ranked_by_symbol = {candidate.opportunity.canonical_symbol: candidate for candidate in ranked_candidates}
        current_symbols = set(ranked_by_symbol)

        states = await self.history_store.get_symbol_alert_states()
        active_symbols = {
            canonical_symbol
            for canonical_symbol, state in states.items()
            if state.get("state") == "active"
        }

        entered = sorted(
            [ranked_by_symbol[canonical_symbol] for canonical_symbol in current_symbols - active_symbols],
            key=lambda candidate: self._sort_key(candidate.opportunity),
        )

        current_opportunities = {opportunity.canonical_symbol: opportunity for opportunity in opportunities}
        exited = [
            (canonical_symbol, self._exit_reason_for_symbol(canonical_symbol, current_opportunities, ranked_by_symbol))
            for canonical_symbol in sorted(active_symbols - current_symbols)
        ]

        if not entered and not exited:
            return None

        return AlertTransitionBatch(
            entered=entered,
            exited=exited,
            message=self._format_transition_message(entered, exited),
            signature=self._build_transition_signature(entered, exited),
        )

    def _rank_alert_candidates(self, opportunities: list[ArbitrageOpportunity]) -> list[AlertCandidate]:
        ranked = [
            AlertCandidate(opportunity=opportunity, reasons=[])
            for opportunity in opportunities
            if not self._alert_quality_failures(opportunity)
        ]
        return sorted(ranked, key=lambda candidate: self._sort_key(candidate.opportunity))[: self.settings.telegram_top_n]

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

    def _exit_reason_for_symbol(
        self,
        canonical_symbol: str,
        current_opportunities: dict[str, ArbitrageOpportunity],
        ranked_by_symbol: dict[str, AlertCandidate],
    ) -> str:
        if canonical_symbol in ranked_by_symbol:
            return "still active"

        opportunity = current_opportunities.get(canonical_symbol)
        if opportunity is None:
            return "No longer in the live comparison set."

        failures = self._alert_quality_failures(opportunity)
        if failures:
            return "; ".join(failures)

        return f"Dropped out of the top {self.settings.telegram_top_n} nearest funding alerts."

    def _format_transition_message(
        self,
        entered: list[AlertCandidate],
        exited: list[tuple[str, str]],
    ) -> str:
        now = datetime.now(timezone.utc)
        parts = ["<b>Alert Update</b>"]

        if entered:
            parts.extend(["", "<b>Entered alerts</b>"])
            for index, candidate in enumerate(entered, start=1):
                opportunity = candidate.opportunity
                next_funding_time = earliest_funding_time(opportunity)
                parts.extend(
                    [
                        "",
                        f"<b>{index}. {opportunity.canonical_symbol}</b>",
                        f"Symbol - {opportunity.canonical_symbol}",
                        f"Spread - {opportunity.spread_rate * 100:.3f}%",
                        *exchange_symbol_lines(opportunity),
                        *exchange_rate_lines(opportunity),
                        f"Buy / Long - {opportunity.long_leg.display_name}",
                        f"Sell / Short - {opportunity.short_leg.display_name}",
                        f"Confidence - {opportunity.confidence_score * 100:.0f}/100",
                        f"Combined OI - ${opportunity.combined_open_interest_usd or 0:,.0f}",
                        f"Data age - {self._format_age(opportunity.max_leg_age_seconds)}",
                        f"Funding expiry - {format_countdown(next_funding_time, now)}",
                    ]
                )

        if exited:
            parts.extend(["", "<b>Exited alerts</b>"])
            for index, (canonical_symbol, reason) in enumerate(exited, start=1):
                parts.extend(
                    [
                        "",
                        f"<b>{index}. {canonical_symbol}</b>",
                        f"Exit reason - {reason}",
                    ]
                )

        return "\n".join(parts)

    def _build_transition_signature(
        self,
        entered: list[AlertCandidate],
        exited: list[tuple[str, str]],
    ) -> str:
        entered_signature = "|".join(
            sorted(
                f"enter:{candidate.opportunity.canonical_symbol}:{candidate.opportunity.updated_at.isoformat()}"
                for candidate in entered
            )
        )
        exited_signature = "|".join(sorted(f"exit:{canonical_symbol}:{reason}" for canonical_symbol, reason in exited))
        return f"{entered_signature}::{exited_signature}"

    def _sort_key(self, opportunity: ArbitrageOpportunity) -> tuple[datetime, float, str]:
        return (
            earliest_funding_time(opportunity) or datetime.max.replace(tzinfo=timezone.utc),
            -opportunity.spread_rate,
            opportunity.base_asset,
        )

    def _format_age(self, age_seconds: float | None) -> str:
        if age_seconds is None:
            return "n/a"
        if age_seconds < 1:
            return "<1s"
        if age_seconds < 60:
            return f"{int(age_seconds)}s"
        minutes = int(age_seconds // 60)
        seconds = int(age_seconds % 60)
        return f"{minutes}m {seconds}s"

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
            self._metrics["update_errors"] += 1
            logger.exception("Telegram getUpdates failed")
            return None

    async def _send_text(self, text: str, chat_ids: list[str] | None = None) -> None:
        if not self.settings.telegram_bot_token:
            raise RuntimeError("Telegram bot token is missing.")

        target_chat_ids = chat_ids or self.settings.resolved_telegram_chat_ids
        errors: list[str] = []
        for chat_id in target_chat_ids:
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
