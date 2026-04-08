from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from app.services.history_store import HistoryStore
from app.services.telegram_commands import TelegramCommandService
from tests.test_helpers import make_opportunity


class TelegramCommandTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.store = HistoryStore(Path(self.temp_dir.name) / "test.db")
        self.service = TelegramCommandService(self.store)
        self.opportunities = [
            make_opportunity(canonical_symbol="SOL-USDT-PERP", long_symbol="SOLUSD", short_symbol="SOLUSDT"),
            make_opportunity(canonical_symbol="SOLV-USDT-PERP", long_symbol="SOLVUSD", short_symbol="SOLVUSDT"),
        ]

    async def asyncTearDown(self) -> None:
        self.temp_dir.cleanup()

    async def test_watch_command_uses_exact_match(self) -> None:
        reply = await self.service.build_reply("chat-1", "/watch SOL", [], self.opportunities)
        watchlist = await self.store.get_watch_symbols("chat-1")

        self.assertIn("SOL-USDT-PERP", reply)
        self.assertEqual(watchlist, ["SOL-USDT-PERP"])

    async def test_coin_query_does_not_fall_through_to_solv(self) -> None:
        reply = await self.service.build_reply("chat-1", "SOL", [], self.opportunities)

        self.assertIn("SOL-USDT-PERP", reply)
        self.assertNotIn("SOLV-USDT-PERP", reply)

    async def test_ambiguous_query_requests_full_symbol(self) -> None:
        match, error = self.service.find_opportunity("SOLU", self.opportunities)

        self.assertIsNone(match)
        self.assertIsNotNone(error)
        self.assertIn("full symbol", error or "")
