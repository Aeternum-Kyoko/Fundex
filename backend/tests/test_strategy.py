from __future__ import annotations

import unittest

from app.services.backtest import CoinSeries
import random
from datetime import datetime, timezone

from app.services.strategy import StrategyParams, build_events, decide, latest_signals, run_carry, run_lab

H = 3600


def flat(binance_rate: float, delta_rate: float, hours: int, binance_every: int = 8, delta_every: int = 8) -> CoinSeries:
    return CoinSeries(
        "X-USDT-PERP",
        "X",
        binance={t * H: binance_rate for t in range(0, hours + 1, binance_every)},
        delta={t * H: delta_rate for t in range(0, hours + 1, delta_every)},
    )


FREE = dict(binance_taker_bps=0, delta_taker_bps=0, slippage_percent_per_leg=0)


class SignalTests(unittest.TestCase):
    def test_signal_is_annualised_spread_once_both_legs_have_an_interval(self) -> None:
        events = build_events([flat(0.0001, -0.0001, 16)], lookback=1)
        self.assertIsNone(events[0].signal_apr)  # one point per leg: no interval yet
        # 0.02% spread every 8h = 0.06% a day = 21.9% a year
        self.assertAlmostEqual(events[1].signal_apr, 21.9)

    def test_interval_comes_from_the_gap_so_hourly_delta_counts_24_times(self) -> None:
        events = build_events([flat(0.0, -0.0001, 16, delta_every=1)], lookback=1)
        self.assertAlmostEqual(events[-1].signal_apr, 0.0001 * 24 * 365 * 100)


class CarryTests(unittest.TestCase):
    def test_no_look_ahead_entry_collects_from_the_next_settlement(self) -> None:
        series = [flat(0.0001, -0.0001, 48)]  # settles at 0,8,...,48h
        params = StrategyParams(notional_usd=1000, entry_apr_percent=10, exit_apr_percent=0, lookback=1, **FREE)
        result = run_carry(series, build_events(series, 1), params, 0, 48 * H)
        # Signal is known after 8h, entered then; paid at 16,24,32,40,48 = 5 x 0.02% x $1000.
        self.assertEqual(result["trades"], 1)
        self.assertAlmostEqual(result["funding_usd"], 1.0)
        self.assertEqual(result["trades_list"][0]["direction"], "long Delta, short Binance")
        self.assertTrue(result["trades_list"][0]["open_at_end"])

    def test_costs_are_paid_once_per_position_not_per_settlement(self) -> None:
        series = [flat(0.0001, -0.0001, 48)]
        params = StrategyParams(notional_usd=1000, entry_apr_percent=10, exit_apr_percent=0, lookback=1, binance_taker_bps=5, delta_taker_bps=5, slippage_percent_per_leg=0.1)
        result = run_carry(series, build_events(series, 1), params, 0, 48 * H)
        self.assertAlmostEqual(result["costs_usd"], 4.0)  # 0.4% round trip on $1000, once
        self.assertAlmostEqual(result["net_usd"], 1.0 - 4.0)

    def test_short_side_flips_with_a_negative_spread(self) -> None:
        series = [flat(-0.0002, 0.0, 48)]
        params = StrategyParams(entry_apr_percent=10, exit_apr_percent=0, lookback=1, **FREE)
        result = run_carry(series, build_events(series, 1), params, 0, 48 * H)
        self.assertEqual(result["trades_list"][0]["direction"], "long Binance, short Delta")
        self.assertGreater(result["funding_usd"], 0)

    def test_exits_when_the_spread_fades(self) -> None:
        series = [CoinSeries("X", "X", binance={t * H: (0.0003 if t <= 16 else 0.0) for t in range(0, 49, 8)}, delta={t * H: 0.0 for t in range(0, 49, 8)})]
        params = StrategyParams(entry_apr_percent=10, exit_apr_percent=5, lookback=1, **FREE)
        result = run_carry(series, build_events(series, 1), params, 0, 48 * H)
        trade = result["trades_list"][0]
        self.assertFalse(trade["open_at_end"])
        self.assertAlmostEqual(trade["hours"], 16)  # in at 8h, out at 24h once the 0 settles
        self.assertAlmostEqual(trade["funding_usd"], 0.0003 * 1000)  # paid at 16h only

    def test_slots_cap_positions_and_prefer_the_strongest(self) -> None:
        weak = CoinSeries("W", "W", {t * H: 0.0001 for t in range(0, 49, 8)}, {t * H: 0.0 for t in range(0, 49, 8)})
        strong = CoinSeries("S", "S", {t * H: 0.0005 for t in range(0, 49, 8)}, {t * H: 0.0 for t in range(0, 49, 8)})
        params = StrategyParams(entry_apr_percent=5, exit_apr_percent=0, lookback=1, max_positions=1, **FREE)
        result = run_carry([weak, strong], build_events([weak, strong], 1), params, 0, 48 * H)
        self.assertEqual([coin["coin"] for coin in result["by_coin"]], ["S"])

    def test_signal_warms_up_before_the_window_without_trading(self) -> None:
        series = [flat(0.0001, -0.0001, 48)]
        params = StrategyParams(entry_apr_percent=10, exit_apr_percent=0, lookback=1, **FREE)
        result = run_carry(series, build_events(series, 1), params, 24 * H, 48 * H)
        self.assertEqual(result["trades_list"][0]["entered"], "1970-01-02T00:00:00+00:00")  # enters at the window open
        self.assertAlmostEqual(result["funding_usd"], 3 * 0.0002 * 1000)


class LabTests(unittest.TestCase):
    def test_lab_reports_baseline_optimizer_and_levers(self) -> None:
        series = [flat(0.0003, -0.0001, 24 * 9)]
        lab = run_lab(series, StrategyParams(days=9), 0, 24 * 9 * H)
        self.assertGreater(lab["strategy"]["net_usd"], 0)
        self.assertIn("net_usd", lab["snipe"])
        self.assertTrue(all(cell["exit_apr"] < cell["entry_apr"] for cell in lab["optimizer"]["grid"]))
        keys = {lever["key"] for lever in lab["levers"]}
        self.assertTrue({"tuned", "maker", "slippage", "slots"} <= keys)
        maker = next(lever for lever in lab["levers"] if lever["key"] == "maker")
        self.assertGreater(maker["delta_usd"], 0)


class LiveParityTests(unittest.TestCase):
    def test_live_decisions_reproduce_the_replay_exactly(self) -> None:
        rng = random.Random(7)
        series = []
        for index in range(25):
            bias = rng.gauss(0, 0.0002)
            every = rng.choice([1, 4, 8])
            series.append(
                CoinSeries(
                    f"C{index}-USDT-PERP",
                    f"C{index}",
                    binance={t * H: bias + rng.gauss(0, 0.0002) for t in range(0, 24 * 20, 8)},
                    delta={t * H: rng.gauss(0, 0.0001) * every / 8 for t in range(0, 24 * 20, every)},
                )
            )
        params = StrategyParams(lookback=3, entry_apr_percent=40, exit_apr_percent=5, max_positions=4)
        events = build_events(series, params.lookback)
        start, end = 3 * 24 * H, 20 * 24 * H - H
        replay = run_carry(series, events, params, start, end)

        held: dict[str, tuple[int, int]] = {}  # coin -> (side, entered)
        trades = []
        for moment in sorted({event.moment for event in events}):
            if not start <= moment <= end:
                continue
            signals = latest_signals(events, series, moment, max_age_hours=1e9)
            exits, entries = decide({coin: side for coin, (side, _) in held.items()}, signals, params)
            for coin in exits:
                side, entered = held.pop(coin)
                trades.append((coin, side, entered, moment))
            for coin, side, _ in entries:
                held[coin] = (side, moment)
        trades += [(coin, side, entered, end) for coin, (side, entered) in held.items()]

        def iso(moment: int) -> str:
            return datetime.fromtimestamp(moment, timezone.utc).isoformat()

        live = {(coin, side, iso(entered), iso(exited)) for coin, side, entered, exited in trades}
        listed = {
            (f"{t['coin']}-USDT-PERP", 1 if t["direction"] == "long Delta, short Binance" else -1, t["entered"], t["exited"])
            for t in replay["trades_list"]
        }
        self.assertGreater(len(listed), 5)
        self.assertEqual(len(trades), replay["trades"])
        self.assertLessEqual(listed, live)  # the replay lists its latest 40; each one must match a live decision exactly

    def test_decide_flips_side_and_respects_slots(self) -> None:
        params = StrategyParams(entry_apr_percent=50, exit_apr_percent=5, max_positions=2)
        exits, entries = decide({"A": 1, "B": 1}, {"A": -80, "B": 60, "C": 200}, params)
        self.assertEqual(exits, ["A"])
        self.assertEqual(entries, [("C", 1, 200), ])  # one slot free after A closes; C beats A's flip
        exits, entries = decide({"A": 1}, {"A": -80}, params)
        self.assertEqual((exits, entries), (["A"], [("A", -1, 80)]))

    def test_stale_coins_have_no_signal(self) -> None:
        series = [flat(0.0001, -0.0001, 16)]
        events = build_events(series, 1)
        self.assertIn("X-USDT-PERP", latest_signals(events, series, 16 * H))
        self.assertEqual(latest_signals(events, series, 40 * H), {})


if __name__ == "__main__":
    unittest.main()
