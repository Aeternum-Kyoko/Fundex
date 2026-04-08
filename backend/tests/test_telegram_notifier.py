from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from httpx import AsyncClient

from app.core.config import Settings
from app.services.history_store import HistoryStore
from app.services.telegram_notifier import TelegramNotifier
from tests.test_helpers import make_opportunity


class TelegramNotifierTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.store = HistoryStore(Path(self.temp_dir.name) / "alerts.db")
        self.settings = Settings(
            telegram_enabled=True,
            telegram_bot_token="test-token",
            telegram_chat_ids=["123"],
        )
        self.client = AsyncClient()
        self.notifier = TelegramNotifier(self.client, self.settings, self.store)

    async def asyncTearDown(self) -> None:
        await self.client.aclose()
        self.temp_dir.cleanup()

    async def test_transition_batch_enters_then_exits(self) -> None:
        entered = await self.notifier._build_transition_batch(  # noqa: SLF001
            [make_opportunity(canonical_symbol="SOL-USDT-PERP", spread_rate=0.01)]
        )
        self.assertIsNotNone(entered)
        self.assertEqual([item.opportunity.canonical_symbol for item in entered.entered], ["SOL-USDT-PERP"])
        self.assertEqual(entered.exited, [])

        await self.store.mark_symbol_alert_entered(entered.entered[0].opportunity)

        exited = await self.notifier._build_transition_batch(  # noqa: SLF001
            [make_opportunity(canonical_symbol="SOL-USDT-PERP", spread_rate=0.002)]
        )
        self.assertIsNotNone(exited)
        self.assertEqual(exited.entered, [])
        self.assertEqual(exited.exited[0][0], "SOL-USDT-PERP")
        self.assertIn("spread below", exited.exited[0][1])

    async def test_duplicate_active_symbol_does_not_reenter(self) -> None:
        opportunity = make_opportunity(canonical_symbol="BTC-USDT-PERP", spread_rate=0.01)
        await self.store.mark_symbol_alert_entered(opportunity)

        batch = await self.notifier._build_transition_batch([opportunity])  # noqa: SLF001

        self.assertIsNone(batch)
