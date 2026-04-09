from __future__ import annotations

import asyncio
import contextlib
import logging
from datetime import datetime, timezone

from httpx import AsyncClient

from app.adapters.base import ExchangeAdapter
from app.adapters.binance import BinanceAdapter
from app.adapters.coindcx import CoinDCXAdapter
from app.adapters.delta import DeltaAdapter
from app.core.config import Settings
from app.models.market import ExchangeStatus
from app.services.arbitrage import build_opportunities
from app.services.history_store import HistoryStore
from app.services.links import exchange_display_name
from app.services.market_store import MarketStore
from app.services.telegram_notifier import TelegramNotifier

logger = logging.getLogger(__name__)


class MarketEngine:
    def __init__(self, settings: Settings, store: MarketStore, history_store: HistoryStore) -> None:
        self.settings = settings
        self.store = store
        self.history_store = history_store
        self.client = AsyncClient()
        self.telegram_notifier = TelegramNotifier(self.client, settings, history_store)
        self.adapters: list[ExchangeAdapter] = []
        self.tasks: list[asyncio.Task[None]] = []
        self._metrics: dict[str, dict[str, int | float | str | None]] = {
            "adapters": {},
            "retention": {"runs": 0, "last_run_at": None, "last_deleted_total": 0},
            "telegram": {"bot_polls": 0, "bot_poll_errors": 0, "last_processed_updates": 0},
        }

        if settings.binance_enabled:
            self.adapters.append(BinanceAdapter(self.client, settings))
        if settings.delta_enabled:
            self.adapters.append(DeltaAdapter(self.client, settings))
        if settings.coindcx_enabled:
            self.adapters.append(CoinDCXAdapter(self.client, settings))

    async def start(self) -> None:
        await self._seed_statuses()
        for adapter in self.adapters:
            self.tasks.append(asyncio.create_task(self._run_adapter(adapter), name=f"{adapter.exchange}-poller"))
        if self.settings.telegram_enabled and self.settings.telegram_bot_token:
            self.tasks.append(asyncio.create_task(self._run_telegram_bot(), name="telegram-bot-poller"))

    async def stop(self) -> None:
        for task in self.tasks:
            task.cancel()
        for task in self.tasks:
            with contextlib.suppress(asyncio.CancelledError):
                await task
        await self.client.aclose()

    def metrics(self) -> dict[str, object]:
        return {
            "adapters": self._metrics["adapters"],
            "retention": {
                **self._metrics["retention"],
                "status": self.history_store.retention_status,
            },
            "telegram": {
                **self._metrics["telegram"],
                "notifier": self.telegram_notifier.status().get("metrics", {}),
            },
        }

    async def _run_adapter(self, adapter: ExchangeAdapter) -> None:
        while True:
            started_at = datetime.now(timezone.utc)
            try:
                snapshots = await adapter.fetch_snapshots()
                await self.store.update_exchange(adapter.exchange, adapter.display_name, snapshots)
                await self.history_store.save_snapshots(snapshots)
                all_snapshots = await self.store.get_snapshots()
                opportunities = build_opportunities(all_snapshots, self.settings)
                await self.history_store.save_opportunities(opportunities)
                await self._prune_if_due()
                await self.telegram_notifier.notify(opportunities)
                duration_ms = (datetime.now(timezone.utc) - started_at).total_seconds() * 1000
                self._metrics["adapters"][adapter.exchange] = {
                    "runs": int(self._metrics["adapters"].get(adapter.exchange, {}).get("runs", 0)) + 1,
                    "failures": int(self._metrics["adapters"].get(adapter.exchange, {}).get("failures", 0)),
                    "last_success_at": datetime.now(timezone.utc).isoformat(),
                    "last_error_at": self._metrics["adapters"].get(adapter.exchange, {}).get("last_error_at"),
                    "last_duration_ms": round(duration_ms, 2),
                    "last_snapshot_count": len(snapshots),
                    "last_opportunity_count": len(opportunities),
                }
                logger.info(
                    "Polled %s successfully: %s snapshots, %s opportunities, %.2fms",
                    adapter.exchange,
                    len(snapshots),
                    len(opportunities),
                    duration_ms,
                )
            except Exception as exc:  # pragma: no cover
                logger.exception("Polling failed for %s", adapter.exchange)
                await self.store.mark_error(adapter.exchange, adapter.display_name, str(exc))
                previous = self._metrics["adapters"].get(adapter.exchange, {})
                self._metrics["adapters"][adapter.exchange] = {
                    "runs": int(previous.get("runs", 0)),
                    "failures": int(previous.get("failures", 0)) + 1,
                    "last_success_at": previous.get("last_success_at"),
                    "last_error_at": datetime.now(timezone.utc).isoformat(),
                    "last_duration_ms": previous.get("last_duration_ms"),
                    "last_snapshot_count": previous.get("last_snapshot_count", 0),
                    "last_opportunity_count": previous.get("last_opportunity_count", 0),
                }
            await asyncio.sleep(self.settings.default_poll_interval_seconds)

    async def _run_telegram_bot(self) -> None:
        while True:
            try:
                snapshots = await self.store.get_snapshots()
                opportunities = build_opportunities(snapshots, self.settings)
                result = await self.telegram_notifier.process_updates(snapshots, opportunities)
                self._metrics["telegram"]["bot_polls"] = int(self._metrics["telegram"]["bot_polls"]) + 1
                self._metrics["telegram"]["last_processed_updates"] = int(result.get("processed", 0))
            except Exception as exc:  # pragma: no cover
                logger.exception("Telegram bot polling failed")
                self.telegram_notifier._last_error = str(exc)  # noqa: SLF001
                self._metrics["telegram"]["bot_poll_errors"] = int(self._metrics["telegram"]["bot_poll_errors"]) + 1
            await asyncio.sleep(self.settings.telegram_poll_interval_seconds)

    async def _prune_if_due(self) -> None:
        if not self.history_store.retention_due(self.settings.retention_prune_interval_minutes):
            return

        stats = await self.history_store.prune_old_data(
            funding_snapshot_retention_hours=self.settings.funding_snapshot_retention_hours,
            opportunity_history_retention_days=self.settings.opportunity_history_retention_days,
            telegram_alert_state_retention_days=self.settings.telegram_alert_state_retention_days,
        )
        deleted_total = int(stats["funding_snapshots_deleted"]) + int(stats["opportunity_history_deleted"]) + int(stats["telegram_alert_state_deleted"])
        self._metrics["retention"]["runs"] = int(self._metrics["retention"]["runs"]) + 1
        self._metrics["retention"]["last_run_at"] = stats["ran_at"]
        self._metrics["retention"]["last_deleted_total"] = deleted_total
        logger.info(
            "Retention prune completed: %s snapshot rows, %s opportunity rows, %s alert-state rows deleted",
            stats["funding_snapshots_deleted"],
            stats["opportunity_history_deleted"],
            stats["telegram_alert_state_deleted"],
        )

    async def _seed_statuses(self) -> None:
        status_definitions = [
            (
                "binance",
                self.settings.binance_enabled,
                True,
                None,
            ),
            (
                "delta",
                self.settings.delta_enabled,
                True,
                None,
            ),
            (
                "coindcx",
                self.settings.coindcx_enabled,
                True,
                None,
            ),
        ]

        for exchange, enabled, configured, error_message in status_definitions:
            await self.store.set_status(
                ExchangeStatus(
                    exchange=exchange,
                    display_name=exchange_display_name(exchange),
                    enabled=enabled,
                    configured=configured if enabled else False,
                    healthy=False,
                    last_error=None if enabled and configured else error_message,
                    snapshot_count=0,
                )
            )
