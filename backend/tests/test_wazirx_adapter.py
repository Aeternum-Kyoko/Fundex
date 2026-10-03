from __future__ import annotations

import unittest
from datetime import datetime, timezone

from app.adapters.wazirx import WazirXAdapter


def premium_item(symbol: str, funding_rate: str = "0.0001", next_funding_ms: int = 1790956800000) -> dict:
    return {
        "symbol": symbol,
        "markPrice": "85474.6",
        "indexPrice": "85460.1",
        "estimatedSettlePrice": "85470.0",
        "lastFundingRate": funding_rate,
        "nextFundingTime": next_funding_ms,
    }


class WazirXAdapterTests(unittest.TestCase):
    def test_parses_usdt_perpetual_into_canonical_snapshot(self) -> None:
        metadata = {"BTCUSDT": {"symbol": "BTCUSDT", "baseAsset": "BTC", "quoteAsset": "USDT", "marginAsset": "INR", "maxLeverage": "150"}}

        snapshots = WazirXAdapter.parse_premium_index([premium_item("BTCUSDT", "0.000018423")], metadata)

        self.assertEqual(len(snapshots), 1)
        snapshot = snapshots[0]
        self.assertEqual(snapshot.exchange, "wazirx")
        self.assertEqual(snapshot.canonical_symbol, "BTC-USDT-PERP")
        self.assertAlmostEqual(snapshot.funding_rate, 0.000018423)
        self.assertEqual(snapshot.funding_interval_hours, 8)
        self.assertEqual(snapshot.max_leverage, 150.0)
        self.assertEqual(snapshot.next_funding_time, datetime(2026, 10, 2, 16, 0, tzinfo=timezone.utc))
        self.assertEqual(snapshot.metadata["margin_asset"], "INR")

    def test_skips_inr_quoted_contracts(self) -> None:
        metadata = {"BTCINR": {"symbol": "BTCINR", "baseAsset": "BTC", "quoteAsset": "INR"}}

        snapshots = WazirXAdapter.parse_premium_index([premium_item("BTCINR")], metadata)

        self.assertEqual(snapshots, [])

    def test_works_without_metadata_and_skips_missing_funding(self) -> None:
        payload = [premium_item("ETHUSDT"), {**premium_item("SOLUSDT"), "lastFundingRate": None}]

        snapshots = WazirXAdapter.parse_premium_index(payload, {})

        self.assertEqual([snapshot.canonical_symbol for snapshot in snapshots], ["ETH-USDT-PERP"])
        self.assertIsNone(snapshots[0].max_leverage)

    def test_tracks_when_the_rate_last_changed(self) -> None:
        adapter = WazirXAdapter(client=None)
        first = datetime(2026, 10, 2, 15, 54, 25, tzinfo=timezone.utc)
        later = datetime(2026, 10, 2, 15, 54, 45, tzinfo=timezone.utc)
        changed = datetime(2026, 10, 2, 15, 55, 6, tzinfo=timezone.utc)

        adapter._track_rate_changes(WazirXAdapter.parse_premium_index([premium_item("BTCUSDT", "0.000014976")], {}), first)
        same = WazirXAdapter.parse_premium_index([premium_item("BTCUSDT", "0.000014976")], {})
        adapter._track_rate_changes(same, later)
        moved = WazirXAdapter.parse_premium_index([premium_item("BTCUSDT", "0.000011349")], {})
        adapter._track_rate_changes(moved, changed)

        self.assertEqual(same[0].metadata["rate_changed_at"], first.isoformat())
        self.assertFalse(same[0].metadata["rate_change_observed"])
        self.assertEqual(moved[0].metadata["rate_changed_at"], changed.isoformat())
        self.assertTrue(moved[0].metadata["rate_change_observed"])
        self.assertEqual(moved[0].metadata["rate_refresh_seconds"], 900)

    def test_interval_prefers_observed_rollover_then_reference_then_assumption(self) -> None:
        adapter = WazirXAdapter(client=None)
        adapter._reference_intervals = {"ETHUSDT": 4}
        sixteen = int(datetime(2026, 10, 2, 16, 0, tzinfo=timezone.utc).timestamp() * 1000)
        twenty = int(datetime(2026, 10, 2, 20, 0, tzinfo=timezone.utc).timestamp() * 1000)
        midnight = int(datetime(2026, 10, 3, 0, 0, tzinfo=timezone.utc).timestamp() * 1000)

        before = WazirXAdapter.parse_premium_index(
            [premium_item("ETHUSDT", next_funding_ms=sixteen), premium_item("NEWUSDT", next_funding_ms=sixteen)], {}
        )
        adapter._resolve_intervals(before)
        self.assertEqual([(s.funding_interval_hours, s.metadata["interval_source"]) for s in before], [(4, "binance_reference"), (8, "assumed")])

        # After the 16:00 settlement NEWUSDT rolls to 20:00 (so it is 4-hourly) and ETHUSDT to midnight (8-hourly).
        after = WazirXAdapter.parse_premium_index(
            [premium_item("ETHUSDT", next_funding_ms=midnight), premium_item("NEWUSDT", next_funding_ms=twenty)], {}
        )
        adapter._resolve_intervals(after)
        self.assertEqual([(s.funding_interval_hours, s.metadata["interval_source"]) for s in after], [(8, "observed"), (4, "observed")])


if __name__ == "__main__":
    unittest.main()
