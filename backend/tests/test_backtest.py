from __future__ import annotations

import asyncio
import tempfile
import unittest
from pathlib import Path

from app.services.backtest import BacktestParams, BacktestService, CoinSeries, capture_at, cost_percent, simulate

H = 3600


class CaptureMathTests(unittest.TestCase):
    def test_both_legs_settling_net_out(self) -> None:
        gross, direction = capture_at(0.0004, -0.0006)  # Binance +0.04%, Delta -0.06%
        self.assertAlmostEqual(gross, 0.001)
        self.assertEqual(direction, "long Delta, short Binance")

    def test_single_settling_leg_pays_its_full_rate_either_sign(self) -> None:
        self.assertAlmostEqual(capture_at(None, -0.0005)[0], 0.0005)
        self.assertAlmostEqual(capture_at(0.0003, None)[0], 0.0003)
        self.assertAlmostEqual(capture_at(-0.0003, None)[0], 0.0003)

    def test_cost_is_four_taker_fills_plus_two_round_trip_slippages(self) -> None:
        self.assertAlmostEqual(cost_percent(5, 5, 0.1), 0.2 + 0.2)


class SimulationTests(unittest.TestCase):
    def series(self) -> list[CoinSeries]:
        # 4h Binance vs 8h Delta: at 0h both settle, at 4h only Binance.
        return [CoinSeries("X-USDT-PERP", "X", binance={0: 0.002, 4 * H: 0.001, 8 * H: 0.0}, delta={0: -0.002, 8 * H: 0.0})]

    def test_trades_only_when_net_clears_threshold(self) -> None:
        params = BacktestParams(days=1, notional_usd=1000, binance_taker_bps=5, delta_taker_bps=5, slippage_percent_per_leg=0.0)
        result = simulate(self.series(), params, 0, 8 * H)
        # Costs 0.2%: 0h captures 0.4% (net +0.2%), 4h captures 0.1% (net -0.1%), 8h nothing.
        self.assertEqual(result["settlements"], 3)
        self.assertEqual(result["trades"], 1)
        self.assertAlmostEqual(result["total_net_usd"], 2.0)
        self.assertEqual(result["best_trades"][0]["settling"], "both")

    def test_sensitivity_grid_gets_better_as_costs_fall(self) -> None:
        result = simulate(self.series(), BacktestParams(days=1), 0, 8 * H)
        free = result["sensitivity"][0][0]
        expensive = result["sensitivity"][-1][-1]
        self.assertEqual(free["taker_bps"], 0.0)
        self.assertGreaterEqual(free["net_usd"], expensive["net_usd"])
        self.assertAlmostEqual(free["net_usd"], (0.4 + 0.1) / 100 * 1000)


class _Response:
    def __init__(self, payload) -> None:
        self.payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self):
        return self.payload


class _Client:
    async def get(self, url, params=None, timeout=None):
        if "binance" in url:
            return _Response([{"fundingTime": 8 * H * 1000 + 7, "fundingRate": "0.0001"}])
        return _Response({"result": [{"time": 8 * H, "close": 0.05}, {"time": 9 * H, "close": 0.05}]})


class HistoryTests(unittest.TestCase):
    def test_history_parsing_snaps_times_and_keeps_only_interval_boundaries(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            service = BacktestService(_Client(), Path(directory) / "h.sqlite")  # type: ignore[arg-type]
            binance = asyncio.run(service._binance_history("XUSDT", 0))
            delta = asyncio.run(service._delta_history("XUSD", 8, 0, 10 * H))
        self.assertEqual(binance, {8 * H: 0.0001})
        self.assertEqual(delta, {8 * H: 0.0005})  # 9h is not an 8h boundary; Delta values are in percent


if __name__ == "__main__":
    unittest.main()
