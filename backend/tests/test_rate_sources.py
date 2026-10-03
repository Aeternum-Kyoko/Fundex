from __future__ import annotations

import asyncio
import unittest
from datetime import datetime, timedelta, timezone

from app.adapters.binance import BinanceAdapter
from app.adapters.coindcx import CoinDCXAdapter
from app.adapters.delta import DeltaAdapter


class _Response:
    def __init__(self, payload) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self):
        return self._payload


class _FakeClient:
    def __init__(self, routes: dict[str, object]) -> None:
        self.routes = routes
        self.calls: list[str] = []

    async def get(self, url: str, **_kwargs) -> _Response:
        self.calls.append(url)
        for prefix, payload in self.routes.items():
            if url.startswith(prefix):
                return _Response(payload)
        raise AssertionError(f"unexpected url {url}")


class BinanceIntervalTests(unittest.TestCase):
    def test_uses_per_symbol_interval_and_defaults_to_8h(self) -> None:
        client = _FakeClient(
            {
                "https://fapi.binance.com/fapi/v1/fundingInfo": [
                    {"symbol": "SANDUSDT", "fundingIntervalHours": 4},
                    {"symbol": "XUSDT", "fundingIntervalHours": 1},
                ],
                "https://fapi.binance.com/fapi/v1/premiumIndex": [
                    {"symbol": s, "lastFundingRate": "0.0001", "markPrice": "1", "indexPrice": "1", "nextFundingTime": 1790956800000}
                    for s in ("SANDUSDT", "XUSDT", "BTCUSDT")
                ],
            }
        )

        snapshots = asyncio.run(BinanceAdapter(client).fetch_snapshots())

        intervals = {snapshot.exchange_symbol: snapshot.funding_interval_hours for snapshot in snapshots}
        self.assertEqual(intervals, {"SANDUSDT": 4, "XUSDT": 1, "BTCUSDT": 8})

    def test_first_poll_fails_rather_than_guessing_intervals(self) -> None:
        class _Failing(_FakeClient):
            async def get(self, url: str, **kwargs):
                if "fundingInfo" in url:
                    raise RuntimeError("down")
                return await super().get(url, **kwargs)

        with self.assertRaises(RuntimeError):
            asyncio.run(BinanceAdapter(_Failing({})).fetch_snapshots())


class CoinDCXRateTests(unittest.TestCase):
    def test_uses_predicted_rate_not_last_settled(self) -> None:
        adapter = CoinDCXAdapter(
            _FakeClient(
                {
                    "https://public.coindcx.com/market_data/v3/current_prices/futures/rt": {
                        "ts": 1790955661000,
                        "prices": {
                            "B-SAND_USDT": {"mkt": "SANDUSDT", "fr": -0.00470676, "efr": -0.00995918, "mp": 0.0628, "ctRT": 1790955661000, "bmST": 1790955661000},
                            "B-OLD_USDT": {"mkt": "OLDUSDT", "fr": 0.0001, "mp": 1.0, "ctRT": 1790955661000, "bmST": 1790955661000},
                        },
                    }
                }
            )
        )
        adapter._instrument_pairs = {"B-SAND_USDT", "B-OLD_USDT"}
        adapter._instrument_metadata = {"B-SAND_USDT": {"funding_frequency": 4}, "B-OLD_USDT": {"funding_frequency": 8}}
        adapter._instrument_metadata_updated_at = datetime.now(timezone.utc)

        snapshots = {snapshot.exchange_symbol: snapshot for snapshot in asyncio.run(adapter.fetch_snapshots())}

        self.assertAlmostEqual(snapshots["B-SAND_USDT"].funding_rate, -0.00995918)
        self.assertAlmostEqual(snapshots["B-SAND_USDT"].metadata["last_settled_funding_rate"], -0.00470676)
        self.assertEqual(snapshots["B-SAND_USDT"].metadata["funding_rate_source"], "efr")
        # Without a prediction, the settled rate is the only number available and is labelled as such.
        self.assertAlmostEqual(snapshots["B-OLD_USDT"].funding_rate, 0.0001)
        self.assertEqual(snapshots["B-OLD_USDT"].metadata["funding_rate_source"], "fr")


class DeltaStreamTests(unittest.TestCase):
    def test_parses_full_key_messages_and_prefers_predicted_rate(self) -> None:
        parsed = DeltaAdapter._parse_funding_message(
            {
                "type": "funding_rate",
                "symbol": "BTCUSD",
                "funding_rate": 0.0005,
                "predicted_funding_rate": 0.0007,
                "funding_interval": 28800,
                "next_funding_realization": 1790956800000000,
                "timestamp": 1790955699585518,
            }
        )

        self.assertEqual(parsed["funding_rate_percent"], 0.0007)
        self.assertEqual(parsed["funding_interval_seconds"], 28800)

    def test_stale_stream_values_are_ignored(self) -> None:
        adapter = DeltaAdapter(_FakeClient({}))
        now = datetime.now(timezone.utc)
        fresh_us = int(now.timestamp() * 1_000_000)
        stale_us = int((now - timedelta(minutes=5)).timestamp() * 1_000_000)
        adapter._funding_cache = {
            "FRESH": {"funding_rate_percent": 0.01, "timestamp": fresh_us},
            "STALE": {"funding_rate_percent": 0.01, "timestamp": stale_us},
        }

        self.assertTrue(adapter._fresh_funding_metadata("FRESH", now))
        self.assertEqual(adapter._fresh_funding_metadata("STALE", now), {})
        self.assertEqual(adapter._fresh_funding_metadata("MISSING", now), {})


if __name__ == "__main__":
    unittest.main()


class BinanceTradableTests(unittest.TestCase):
    def test_settling_contracts_are_excluded(self) -> None:
        symbols = BinanceAdapter.parse_trading_symbols(
            {
                "symbols": [
                    {"symbol": "BTCUSDT", "status": "TRADING", "contractType": "PERPETUAL"},
                    {"symbol": "OMUSDT", "status": "SETTLING", "contractType": "PERPETUAL"},
                    {"symbol": "BTCUSDT_261226", "status": "TRADING", "contractType": "CURRENT_QUARTER"},
                ]
            }
        )
        self.assertEqual(symbols, {"BTCUSDT"})
