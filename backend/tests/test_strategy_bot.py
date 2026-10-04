from __future__ import annotations

import asyncio
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from app.core.config import Settings
from app.services.backtest import CoinSeries
from app.services.market_store import MarketStore
from app.services.strategy import StrategyParams
from app.services.strategy_runner import BOT_ID, StrategyRunner, next_tick_after
from app.services.trade_manager import TradeManager
from tests.test_helpers import make_snapshot

H = 3600
T0 = datetime(2026, 10, 1, 0, 2, tzinfo=timezone.utc)  # two minutes after a settlement hour


class Clock:
    def __init__(self) -> None:
        self.now = T0

    def __call__(self) -> datetime:
        return self.now


class FakeBacktest:
    """Stands in for the exchange history: the test decides which settlements exist."""

    def __init__(self) -> None:
        self.series: list[CoinSeries] = []

    async def load_series(self, snapshots, start, end, on_progress=None):
        return [
            CoinSeries(c.canonical_symbol, c.base_asset, {t: r for t, r in c.binance.items() if t <= end}, {t: r for t, r in c.delta.items() if t <= end})
            for c in self.series
        ]


def history(symbol: str, binance_rate: float, delta_rate: float, until: datetime) -> CoinSeries:
    end = int(until.timestamp())
    start = end - 3 * 86400
    hours = range(start - start % (8 * H), end + 1, 8 * H)
    return CoinSeries(symbol, symbol.split("-")[0], {t: binance_rate for t in hours}, {t: delta_rate for t in hours})


class StrategyBotTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.settings = Settings(database_path=str(Path(self.tmp.name) / "bot.sqlite"))
        self.clock = Clock()
        self.patches = [patch("app.services.strategy_runner._utcnow", self.clock), patch("app.services.trade_manager._utcnow", self.clock)]
        for item in self.patches:
            item.start()

    def tearDown(self) -> None:
        for item in self.patches:
            item.stop()
        self.tmp.cleanup()

    async def build(self):
        store = MarketStore()
        snapshots = []
        for base in ("AAA", "BBB"):
            symbol = f"{base}-USDT-PERP"
            snapshots.append(make_snapshot(exchange="binance", canonical_symbol=symbol, mark_price=100.0))
            snapshots.append(make_snapshot(exchange="delta", canonical_symbol=symbol, mark_price=100.0))
        await store.update_exchange("binance", "Binance", [s for s in snapshots if s.exchange == "binance"])
        await store.update_exchange("delta", "Delta", [s for s in snapshots if s.exchange == "delta"])
        manager = TradeManager(self.settings, store)

        async def fill(leg, action):
            return 100.0, 100.0, "test book"

        manager._book_fill = fill  # type: ignore[method-assign]
        backtest = FakeBacktest()
        runner = StrategyRunner(backtest, manager, store, self.settings.database_file)
        return manager, backtest, runner

    def test_opens_credits_settled_funding_and_closes_when_the_spread_fades(self) -> None:
        async def scenario():
            manager, backtest, runner = await self.build()
            settle = T0.replace(minute=0)
            # AAA: Binance +0.05% / Delta 0 every 8h = 54.75% a year for short Binance. BBB is flat.
            backtest.series = [history("AAA-USDT-PERP", 0.0005, 0.0, settle), history("BBB-USDT-PERP", 0.0, 0.0, settle)]
            params = StrategyParams(entry_apr_percent=40, exit_apr_percent=10, max_positions=3, lookback=1, notional_usd=1000)
            await runner.configure(enabled=True, mode="paper", leverage=2, params=params)

            first = await runner.tick()
            self.assertEqual(first["opened"], 1)
            [position] = await manager.open_carry_positions(BOT_ID)
            self.assertEqual(position.canonical_symbol, "AAA-USDT-PERP")
            self.assertEqual((position.long_leg.exchange, position.short_leg.exchange), ("delta", "binance"))
            self.assertAlmostEqual(position.realized_total_fees_usd, 1.0)  # 5 bp on $1,000, both legs

            # Next settlement lands: the short Binance leg receives 0.05% of $1,000.
            nxt = settle + timedelta(hours=8)
            for coin in backtest.series:
                coin.binance[int(nxt.timestamp())] = 0.0005 if coin.base_asset == "AAA" else 0.0
                coin.delta[int(nxt.timestamp())] = 0.0
            self.clock.now = nxt + timedelta(minutes=2)
            second = await runner.tick()
            self.assertAlmostEqual(second["credited_usd"], 0.5)
            self.assertEqual(second["opened"], 0)  # already holding AAA, BBB never qualifies
            again = await runner.tick()
            self.assertAlmostEqual(again["credited_usd"], 0.0)  # each settlement is credited once

            # The spread collapses: closed on the exit rule, result = funding - fees.
            fade = nxt + timedelta(hours=8)
            backtest.series[0].binance[int(fade.timestamp())] = 0.0
            backtest.series[0].delta[int(fade.timestamp())] = 0.0
            self.clock.now = fade + timedelta(minutes=2)
            third = await runner.tick()
            self.assertEqual(third["closed"], 1)
            self.assertEqual(await manager.open_carry_positions(BOT_ID), [])
            stored = await manager.journal.get(position.id)
            self.assertEqual(stored.status, "completed")
            self.assertIn("below the exit level", stored.exit_reason)
            self.assertEqual(len(stored.funding_legs), 4)  # both legs at two settlements
            self.assertAlmostEqual(stored.realized_net_pnl_usd, 0.5 - 2.0)  # funding - 4 fills at 5 bp
            state = await runner.state()
            self.assertEqual(state["totals"]["closed_count"], 1)
            self.assertEqual(state["log"][0]["kind"], "check")

        asyncio.run(scenario())

    def test_stopping_blocks_new_entries_but_still_manages_open_positions(self) -> None:
        async def scenario():
            manager, backtest, runner = await self.build()
            settle = T0.replace(minute=0)
            backtest.series = [history("AAA-USDT-PERP", 0.0005, 0.0, settle), history("BBB-USDT-PERP", -0.0006, 0.0, settle)]
            params = StrategyParams(entry_apr_percent=40, exit_apr_percent=10, max_positions=1, lookback=1)
            await runner.configure(enabled=True, mode="paper", leverage=2, params=params)
            await runner.tick()
            [position] = await manager.open_carry_positions(BOT_ID)
            self.assertEqual(position.canonical_symbol, "BBB-USDT-PERP")  # strongest takes the single slot
            self.assertEqual(position.long_leg.exchange, "binance")  # negative Binance rate: long Binance

            await runner.configure(enabled=False, mode="paper", leverage=2, params=params)
            nxt = settle + timedelta(hours=8)
            backtest.series[1].binance[int(nxt.timestamp())] = 0.0
            backtest.series[1].delta[int(nxt.timestamp())] = 0.0
            self.clock.now = nxt + timedelta(minutes=2)
            result = await runner.tick()
            self.assertEqual((result["closed"], result["opened"]), (1, 0))  # AAA still qualifies but the bot is off

        asyncio.run(scenario())

    def test_live_mode_is_refused_for_now(self) -> None:
        async def scenario():
            _, _, runner = await self.build()
            with self.assertRaises(ValueError):
                await runner.configure(enabled=True, mode="live", leverage=2, params=StrategyParams())

        asyncio.run(scenario())

    def test_open_paper_positions_survive_a_restart(self) -> None:
        async def scenario():
            manager, backtest, runner = await self.build()
            backtest.series = [history("AAA-USDT-PERP", 0.0005, 0.0, T0.replace(minute=0)), history("BBB-USDT-PERP", 0.0, 0.0, T0.replace(minute=0))]
            await runner.configure(enabled=True, mode="paper", leverage=2, params=StrategyParams(entry_apr_percent=40, exit_apr_percent=10, lookback=1))
            await runner.tick()
            restarted = TradeManager(self.settings, MarketStore())
            await restarted.start()
            [position] = await restarted.open_carry_positions(BOT_ID)
            self.assertEqual(position.status, "entered")
            config = StrategyRunner(backtest, restarted, MarketStore(), self.settings.database_file)._load_config()
            self.assertTrue(config.enabled)
            self.assertEqual(config.params.entry_apr_percent, 40)

        asyncio.run(scenario())

    def test_checks_run_just_after_each_hour(self) -> None:
        self.assertEqual(next_tick_after(datetime(2026, 10, 1, 5, 30, tzinfo=timezone.utc)), datetime(2026, 10, 1, 6, 2, tzinfo=timezone.utc))
        self.assertEqual(next_tick_after(datetime(2026, 10, 1, 5, 1, tzinfo=timezone.utc)), datetime(2026, 10, 1, 5, 2, tzinfo=timezone.utc))


if __name__ == "__main__":
    unittest.main()
