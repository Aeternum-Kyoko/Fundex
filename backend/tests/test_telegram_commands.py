from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from app.core.config import Settings
from app.services.history_store import HistoryStore
from app.services.telegram_commands import TelegramCommandService
from tests.test_helpers import make_opportunity, make_snapshot


class TelegramCommandTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.store = HistoryStore(Path(self.temp_dir.name) / "test.db")
        self.service = TelegramCommandService(self.store, Settings())
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

    async def test_coindcx_command_returns_a_coindcx_section(self) -> None:
        snapshots = [
            make_snapshot(exchange="coindcx", canonical_symbol="BTC-USDT-PERP", funding_rate=0.003, exchange_symbol="B-BTC_USDT"),
            make_snapshot(exchange="coindcx", canonical_symbol="ETH-USDT-PERP", funding_rate=-0.002, exchange_symbol="B-ETH_USDT"),
        ]

        reply = await self.service.build_reply("chat-1", "/coindcx", snapshots, self.opportunities)

        self.assertIn("CoinDCX", reply)
        self.assertIn("BTC-USDT-PERP", reply)

    async def test_coinswitch_command_returns_a_coinswitch_section(self) -> None:
        snapshots = [
            make_snapshot(exchange="coinswitch", canonical_symbol="BTC-USDT-PERP", funding_rate=0.0025, exchange_symbol="BTCUSDT"),
            make_snapshot(exchange="coinswitch", canonical_symbol="ETH-USDT-PERP", funding_rate=-0.0011, exchange_symbol="ETHUSDT"),
        ]

        reply = await self.service.build_reply("chat-1", "/coinswitch", snapshots, self.opportunities)

        self.assertIn("CoinSwitch", reply)
        self.assertIn("BTC-USDT-PERP", reply)

    async def test_compare_command_shows_all_exchange_sections(self) -> None:
        snapshots = [
            make_snapshot(exchange="binance", canonical_symbol="BTC-USDT-PERP", funding_rate=0.001, exchange_symbol="BTCUSDT"),
            make_snapshot(exchange="delta", canonical_symbol="BTC-USDT-PERP", funding_rate=-0.0012, exchange_symbol="BTCUSD"),
            make_snapshot(exchange="coindcx", canonical_symbol="BTC-USDT-PERP", funding_rate=0.0007, exchange_symbol="B-BTC_USDT"),
        ]
        opportunities = [
            make_opportunity(
                canonical_symbol="BTC-USDT-PERP",
                long_exchange="delta",
                short_exchange="binance",
                long_symbol="BTCUSD",
                short_symbol="BTCUSDT",
            )
        ]

        reply = await self.service.build_reply("chat-1", "/compare BTC", snapshots, opportunities)

        self.assertIn("Exchange comparison", reply)
        self.assertIn("Binance", reply)
        self.assertIn("Delta Exchange India", reply)
        self.assertIn("CoinDCX", reply)
        self.assertIn("Best live pair", reply)

    async def test_compare_command_marks_missing_exchange_as_not_listed(self) -> None:
        snapshots = [
            make_snapshot(exchange="binance", canonical_symbol="BTC-USDT-PERP", funding_rate=0.001, exchange_symbol="BTCUSDT"),
            make_snapshot(exchange="delta", canonical_symbol="BTC-USDT-PERP", funding_rate=-0.0012, exchange_symbol="BTCUSD"),
        ]
        opportunities = [
            make_opportunity(
                canonical_symbol="BTC-USDT-PERP",
                long_exchange="delta",
                short_exchange="binance",
                long_symbol="BTCUSD",
                short_symbol="BTCUSDT",
            )
        ]

        reply = await self.service.build_reply("chat-1", "/compare BTC", snapshots, opportunities)

        self.assertIn("CoinDCX", reply)
        self.assertIn("Not listed right now for this symbol.", reply)

    async def test_compare_command_formats_flat_funding_without_zero_percent(self) -> None:
        snapshots = [
            make_snapshot(exchange="binance", canonical_symbol="BTC-USDT-PERP", funding_rate=0.0, exchange_symbol="BTCUSDT"),
            make_snapshot(exchange="delta", canonical_symbol="BTC-USDT-PERP", funding_rate=-0.0012, exchange_symbol="BTCUSD"),
        ]
        opportunities = [
            make_opportunity(
                canonical_symbol="BTC-USDT-PERP",
                long_exchange="delta",
                short_exchange="binance",
                long_symbol="BTCUSD",
                short_symbol="BTCUSDT",
                short_rate=0.0,
            )
        ]

        reply = await self.service.build_reply("chat-1", "/compare BTC", snapshots, opportunities)

        self.assertIn("Funding rate - flat", reply)
        self.assertNotIn("Funding rate - 0.000%", reply)

    async def test_status_command_reports_watchlist_and_alerts(self) -> None:
        await self.store.add_watch_symbol("chat-1", "BTC-USDT-PERP")
        await self.store.set_alerts_enabled("chat-1", False)

        reply = await self.service.build_reply("chat-1", "/status", [], self.opportunities)

        self.assertIn("Your bot status", reply)
        self.assertIn("off", reply)
        self.assertIn("BTC-USDT-PERP", reply)

    async def test_help_lists_compare_and_status_commands(self) -> None:
        reply = await self.service.build_reply("chat-1", "/help", [], self.opportunities)

        self.assertIn("/compare BTC", reply)
        self.assertIn("/status", reply)
        self.assertIn("/exchanges", reply)
        self.assertIn("/coinswitch", reply)

    async def test_alerts_on_reports_state_and_current_live_alerts(self) -> None:
        opportunities = [
            make_opportunity(
                canonical_symbol="BTC-USDT-PERP",
                long_exchange="delta",
                short_exchange="binance",
                spread_rate=0.006,
                confidence_score=0.92,
                combined_open_interest_usd=2_500_000,
            )
        ]

        reply = await self.service.build_reply("chat-1", "/alerts on", [], opportunities)

        self.assertIn("currently <b>on</b>", reply)
        self.assertIn("Live alerts right now", reply)
        self.assertIn("BTC-USDT-PERP", reply)
