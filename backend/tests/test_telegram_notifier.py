from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from httpx import AsyncClient

from app.core.config import Settings
from app.models.market import FundingSnapshot
from app.services.history_store import HistoryStore
from app.services.telegram_notifier import TelegramNotifier
from tests.test_helpers import make_opportunity, make_snapshot


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
            [make_opportunity(canonical_symbol="SOL-USDT-PERP", spread_rate=0.0003)]  # 0.03%/8h, under the 0.05% alert minimum
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

    async def test_daily_summary_preview_includes_expected_sections(self) -> None:
        snapshots: list[FundingSnapshot] = [
            make_snapshot(exchange="binance", canonical_symbol="BTC-USDT-PERP", funding_rate=0.003),
            make_snapshot(exchange="delta", canonical_symbol="ETH-USDT-PERP", funding_rate=-0.002),
            make_snapshot(exchange="coindcx", canonical_symbol="SOL-USDT-PERP", funding_rate=0.0015),
        ]
        opportunities = [
            make_opportunity(canonical_symbol="BTC-USDT-PERP", spread_rate=0.01),
            make_opportunity(canonical_symbol="ETH-USDT-PERP", spread_rate=0.0075),
        ]

        batch = await self.notifier._build_daily_summary_batch(  # noqa: SLF001
            snapshots,
            opportunities,
            ignore_schedule=True,
        )

        self.assertIsNotNone(batch)
        assert batch is not None
        self.assertIn("Top Positive Funding", batch.message)
        self.assertIn("Top Negative Funding", batch.message)
        self.assertIn("Best Spreads", batch.message)
        self.assertIn("Upcoming Funding Expiries", batch.message)
        self.assertIn("BTC-USDT-PERP", batch.message)

    async def test_daily_summary_preview_uses_requested_schedule_label(self) -> None:
        snapshots: list[FundingSnapshot] = [
            make_snapshot(exchange="binance", canonical_symbol="BTC-USDT-PERP", funding_rate=0.003),
        ]
        opportunities = [
            make_opportunity(canonical_symbol="BTC-USDT-PERP", spread_rate=0.01),
        ]

        batch = await self.notifier.preview_daily_summary(
            snapshots,
            opportunities,
            summary_key="night",
        )

        self.assertIsNotNone(batch)
        assert batch is not None
        self.assertEqual(batch.summary_key, "night")
        self.assertEqual(batch.summary_label, "Night Summary")
        self.assertIn("Night Summary", batch.message)
