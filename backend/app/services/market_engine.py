from __future__ import annotations

import asyncio
import contextlib
import logging

from httpx import AsyncClient

from app.adapters.base import ExchangeAdapter
from app.adapters.binance import BinanceAdapter
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
        self.telegram_notifier = TelegramNotifier(self.client, settings)
        self.adapters: list[ExchangeAdapter] = []
        self.tasks: list[asyncio.Task[None]] = []

        if settings.binance_enabled:
            self.adapters.append(BinanceAdapter(self.client, settings))
        if settings.delta_enabled:
            self.adapters.append(DeltaAdapter(self.client, settings))

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

    async def _run_adapter(self, adapter: ExchangeAdapter) -> None:
        while True:
            try:
                snapshots = await adapter.fetch_snapshots()
                await self.store.update_exchange(adapter.exchange, adapter.display_name, snapshots)
                await self.history_store.save_snapshots(snapshots)
                all_snapshots = await self.store.get_snapshots()
                opportunities = build_opportunities(all_snapshots, self.settings)
                await self.history_store.save_opportunities(opportunities)
                await self.telegram_notifier.notify(opportunities)
            except Exception as exc:  # pragma: no cover
                logger.exception("Polling failed for %s", adapter.exchange)
                await self.store.mark_error(adapter.exchange, adapter.display_name, str(exc))
            await asyncio.sleep(self.settings.default_poll_interval_seconds)

    async def _run_telegram_bot(self) -> None:
        while True:
            try:
                snapshots = await self.store.get_snapshots(include_exchanges={"binance", "delta"})
                opportunities = build_opportunities(snapshots, self.settings)
                await self.telegram_notifier.process_updates(opportunities)
            except Exception as exc:  # pragma: no cover
                logger.exception("Telegram bot polling failed")
                self.telegram_notifier._last_error = str(exc)  # noqa: SLF001
            await asyncio.sleep(self.settings.telegram_poll_interval_seconds)

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
