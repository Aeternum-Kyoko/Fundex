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
from app.services.strategy_runner import BOT_ID, StrategyRunner, next_tick_after, upcoming_predictions, with_predictions
from app.services.strategy import build_events, latest_signals, predicted_events
from app.services.trade_manager import TradeManager
from tests.test_helpers import make_snapshot

H = 3600


def make_leg():
    from app.models.execution import ExecutionLegPlan

    return ExecutionLegPlan(
        exchange="binance", display_name="Binance", exchange_symbol="AAAUSDT", side="buy", reference_price=100.0, notional_usd=1000,
        estimated_quantity=10, leverage=2, initial_margin_usd=500, taker_fee_percent=0.05, estimated_entry_fee_usd=0.5,
        estimated_exit_fee_usd=0.5, trade_url="#",
    )
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
            await runner.configure(enabled=True, mode="paper", leverage=2, execution="taker", params=params)

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
            await runner.configure(enabled=True, mode="paper", leverage=2, execution="taker", params=params)
            await runner.tick()
            [position] = await manager.open_carry_positions(BOT_ID)
            self.assertEqual(position.canonical_symbol, "BBB-USDT-PERP")  # strongest takes the single slot
            self.assertEqual(position.long_leg.exchange, "binance")  # negative Binance rate: long Binance

            await runner.configure(enabled=False, mode="paper", leverage=2, execution="taker", params=params)
            nxt = settle + timedelta(hours=8)
            backtest.series[1].binance[int(nxt.timestamp())] = 0.0
            backtest.series[1].delta[int(nxt.timestamp())] = 0.0
            self.clock.now = nxt + timedelta(minutes=2)
            result = await runner.tick()
            self.assertEqual((result["closed"], result["opened"]), (1, 0))  # AAA still qualifies but the bot is off

        asyncio.run(scenario())

    def test_waits_for_market_data_and_retries_soon(self) -> None:
        async def scenario():
            manager, backtest, runner = await self.build()
            runner.market_store = MarketStore()  # feeds not loaded yet, as right after a restart
            await runner.configure(enabled=True, mode="paper", leverage=2, execution="taker", params=StrategyParams())
            with self.assertRaisesRegex(RuntimeError, "Waiting for Binance and Delta"):
                await runner.tick()
            runner._wake.clear()
            task = asyncio.create_task(runner._loop())
            for _ in range(50):
                await asyncio.sleep(0)
                if runner.next_tick_at and runner.last_error:
                    break
            task.cancel()
            self.assertIn("Waiting for Binance", runner.last_error)
            self.assertLessEqual((runner.next_tick_at - self.clock.now).total_seconds(), 60)

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
            await runner.configure(enabled=True, mode="paper", leverage=2, execution="taker", params=StrategyParams(entry_apr_percent=40, exit_apr_percent=10, lookback=1))
            await runner.tick()
            restarted = TradeManager(self.settings, MarketStore())
            await restarted.start()
            [position] = await restarted.open_carry_positions(BOT_ID)
            self.assertEqual(position.status, "entered")
            config = StrategyRunner(backtest, restarted, MarketStore(), self.settings.database_file)._load_config()
            self.assertTrue(config.enabled)
            self.assertEqual(config.params.entry_apr_percent, 40)

        asyncio.run(scenario())

    def test_checks_run_just_after_each_hour_or_just_before_on_predictions(self) -> None:
        self.assertEqual(next_tick_after(datetime(2026, 10, 1, 5, 30, tzinfo=timezone.utc)), datetime(2026, 10, 1, 6, 2, tzinfo=timezone.utc))
        self.assertEqual(next_tick_after(datetime(2026, 10, 1, 5, 1, tzinfo=timezone.utc)), datetime(2026, 10, 1, 5, 2, tzinfo=timezone.utc))
        self.assertEqual(next_tick_after(datetime(2026, 10, 1, 5, 30, tzinfo=timezone.utc), True), datetime(2026, 10, 1, 5, 56, tzinfo=timezone.utc))
        self.assertEqual(next_tick_after(datetime(2026, 10, 1, 5, 57, tzinfo=timezone.utc), True), datetime(2026, 10, 1, 6, 56, tzinfo=timezone.utc))

    def test_live_predicted_signal_equals_the_predicted_replay(self) -> None:
        # When the prediction is right, the live signal before a settlement is exactly what the replay assumes.
        settle = T0.replace(minute=0)
        full = history("AAA-USDT-PERP", 0.0005, -0.0001, settle + timedelta(hours=8))
        upcoming = int((settle + timedelta(hours=8)).timestamp())
        known = CoinSeries(full.canonical_symbol, full.base_asset, {t: r for t, r in full.binance.items() if t < upcoming}, {t: r for t, r in full.delta.items() if t < upcoming})
        known.binance[max(known.binance)] = 0.0002  # the latest settled rate differs, so the prediction matters
        full.binance[max(t for t in full.binance if t < upcoming)] = 0.0002
        before = upcoming - 240
        snapshots = [
            make_snapshot(exchange="binance", canonical_symbol="AAA-USDT-PERP", funding_rate=full.binance[upcoming], next_funding_time=datetime.fromtimestamp(upcoming, timezone.utc)),
            make_snapshot(exchange="delta", canonical_symbol="AAA-USDT-PERP", funding_rate=full.delta[upcoming], next_funding_time=datetime.fromtimestamp(upcoming, timezone.utc)),
            make_snapshot(exchange="binance", canonical_symbol="BBB-USDT-PERP", next_funding_time=datetime.fromtimestamp(upcoming + 4 * H, timezone.utc)),
        ]
        predictions = upcoming_predictions(snapshots, before)
        self.assertEqual(set(predictions), {("binance", "AAA-USDT-PERP"), ("delta", "AAA-USDT-PERP")})  # BBB is hours away
        live = with_predictions([known], predictions)
        live_signal = latest_signals(build_events(live, 3), live, upcoming)["AAA-USDT-PERP"]
        replay = predicted_events(build_events([full], 3))
        replay_signal = [event.signal_apr for event in replay if event.moment < upcoming][-1]
        self.assertAlmostEqual(live_signal, replay_signal)

    def test_maker_first_fills_at_the_touch_or_falls_back_to_crossing(self) -> None:
        async def scenario():
            manager, _, _ = await self.build()
            books = iter([([(99.0, 50.0)], [(101.0, 50.0)]), ([(98.0, 50.0)], [(99.0, 50.0)])])  # asks fall to our bid

            class Books:
                async def fetch(self, exchange, symbol):
                    return next(books)

            manager._books = Books()  # type: ignore[assignment]
            with patch("app.services.trade_manager.MAKER_POLL_SECONDS", 0.0):
                price, mid, note, fee = await manager._carry_fill(make_leg(), "buy", "maker_first", 5, 0.02, 0.05)
            self.assertEqual((price, fee), (99.0, 0.02))
            self.assertIn("maker", note)

            class Still:
                async def fetch(self, exchange, symbol):
                    return [(99.0, 50.0)], [(101.0, 50.0)]  # nobody comes to our price

            manager._books = Still()  # type: ignore[assignment]
            with patch("app.services.trade_manager.MAKER_POLL_SECONDS", 0.0):
                price, mid, note, fee = await manager._carry_fill(make_leg(), "buy", "maker_first", 0.01, 0.02, 0.05)
            self.assertEqual((price, fee), (100.0, 0.05))  # the test's crossing fill, charged as taker
            self.assertIn("crossed the book", note)

        asyncio.run(scenario())

    def test_fees_follow_each_fill_maker_in_taker_out(self) -> None:
        async def scenario():
            manager, backtest, runner = await self.build()
            fills = iter([(100.0, 100.0, "maker", 0.02), (100.0, 100.0, "maker", 0.02), (100.0, 100.0, "taker", 0.05), (100.0, 100.0, "taker", 0.05)])

            async def carry_fill(leg, action, execution, wait, maker, taker):
                return next(fills)

            manager._carry_fill = carry_fill  # type: ignore[method-assign]
            position = await manager.open_carry(
                canonical_symbol="AAA-USDT-PERP", long_exchange="delta", short_exchange="binance", notional_usd=1000, leverage=2,
                signal_apr=100, opened_by=BOT_ID, execution="maker_first",
            )
            self.assertAlmostEqual(position.realized_total_fees_usd, 0.4)  # 2 bp x 2 legs on $1,000
            closed = await manager.close_carry(position.id, "test")
            self.assertAlmostEqual(closed.realized_total_fees_usd, 0.4 + 1.0)

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
