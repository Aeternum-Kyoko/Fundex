from __future__ import annotations

import unittest
from datetime import datetime, timezone

from app.models.market import ExchangeStatus
from app.services.exchange_profiles import annualised_percent, coin_row, exchange_summary
from tests.test_helpers import make_snapshot

NOW = datetime.now(timezone.utc)


def market():
    snapshots = [
        make_snapshot(exchange="binance", canonical_symbol="AAA-USDT-PERP", funding_rate=0.0008, funding_interval_hours=8, taker_fee_bps=5),
        make_snapshot(exchange="delta", canonical_symbol="AAA-USDT-PERP", funding_rate=-0.0001, funding_interval_hours=1, taker_fee_bps=5),
        make_snapshot(exchange="coindcx", canonical_symbol="AAA-USDT-PERP", funding_rate=0.0004, funding_interval_hours=8, taker_fee_bps=5.9),
        make_snapshot(exchange="binance", canonical_symbol="BBB-USDT-PERP", funding_rate=-0.0002, funding_interval_hours=4, taker_fee_bps=5),
    ]
    by_coin: dict[str, list] = {}
    for item in snapshots:
        by_coin.setdefault(item.canonical_symbol, []).append(item)
    return snapshots, by_coin


class CoinRowTests(unittest.TestCase):
    def test_annualises_by_the_contracts_own_interval(self) -> None:
        snapshots, _ = market()
        self.assertAlmostEqual(annualised_percent(snapshots[0]), 0.0008 * 3 * 365 * 100)
        self.assertAlmostEqual(annualised_percent(snapshots[1]), -0.0001 * 24 * 365 * 100)

    def test_rank_and_best_pair_against_other_venues(self) -> None:
        snapshots, by_coin = market()
        binance = coin_row(snapshots[0], by_coin, None)
        self.assertEqual((binance["rank"], binance["listed_on"]), (1, 3))  # highest funding: the place to be short
        self.assertEqual(binance["best_pair"]["role"], "short here")
        self.assertEqual(binance["best_pair"]["other"], "delta")
        self.assertAlmostEqual(binance["best_pair"]["spread_apr"], (0.0001 + 0.0001) * 24 * 365 * 100)
        delta = coin_row(snapshots[1], by_coin, None)
        self.assertEqual((delta["rank"], delta["best_pair"]["role"], delta["best_pair"]["other"]), (3, "long here", "binance"))
        lonely = coin_row(snapshots[3], by_coin, None)
        self.assertIsNone(lonely["best_pair"])

    def test_account_fee_overrides_the_published_one(self) -> None:
        snapshots, by_coin = market()
        self.assertEqual(coin_row(snapshots[0], by_coin, 4.5)["taker_fee_bps"], 4.5)


class SummaryTests(unittest.TestCase):
    def test_summary_counts_fees_and_sources(self) -> None:
        snapshots, _ = market()
        status = ExchangeStatus(exchange="binance", display_name="Binance", healthy=True, snapshot_count=2)
        mine = [s for s in snapshots if s.exchange == "binance"]
        summary = exchange_summary("binance", mine, snapshots, status, None, NOW)
        self.assertEqual((summary["coins"], summary["shared_coins"]), (2, 1))
        self.assertEqual(summary["interval_mix"], {"4h": 1, "8h": 1})
        self.assertIn("published", summary["fees"]["source"])
        self.assertEqual(summary["funding"]["positive_share"], 0.5)
        with_key = exchange_summary("binance", mine, snapshots, status, 4.0, NOW)
        self.assertIn("your account", with_key["fees"]["source"])
        self.assertEqual(with_key["fees"]["taker_bps"]["max"], 4.0)
        delta = exchange_summary("delta", [snapshots[1]], snapshots, None, None, NOW)
        self.assertIn("own API", delta["fees"]["source"])
        self.assertFalse(delta["healthy"])


class RouteOrderTests(unittest.TestCase):
    def test_exchange_pages_do_not_shadow_the_older_exchange_routes(self) -> None:
        from app.main import app

        paths = [getattr(route, "path", "") for route in app.routes]
        self.assertLess(paths.index("/api/exchanges/funding-leaders"), paths.index("/api/exchanges/{exchange}"))
        self.assertLess(paths.index("/api/exchanges/status"), paths.index("/api/exchanges/{exchange}"))


if __name__ == "__main__":
    unittest.main()
