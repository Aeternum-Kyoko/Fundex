from __future__ import annotations

import unittest
from datetime import datetime, timezone

from app.adapters.delta import DeltaAdapter


class DeltaAdapterTests(unittest.TestCase):
    def test_next_funding_boundary_respects_four_hour_frequency(self) -> None:
        reference = datetime(2026, 4, 9, 1, 17, tzinfo=timezone.utc)

        next_boundary = DeltaAdapter._next_funding_boundary(reference, 4)

        self.assertEqual(next_boundary, datetime(2026, 4, 9, 4, 0, tzinfo=timezone.utc))

    def test_build_product_metadata_uses_rate_exchange_interval_and_fee_rates(self) -> None:
        metadata = DeltaAdapter._build_product_metadata(
            {
                "maker_commission_rate": "0.0002",
                "taker_commission_rate": "0.0005",
                "funding_method": "mark_price",
                "annualized_funding": "43.8",
                "product_specs": {
                    "rate_exchange_interval": 14400,
                },
            }
        )

        self.assertEqual(metadata["funding_interval_seconds"], 14_400)
        self.assertEqual(metadata["maker_fee_bps"], 2.0)
        self.assertEqual(metadata["taker_fee_bps"], 5.0)
        self.assertEqual(metadata["funding_method"], "mark_price")
        self.assertEqual(metadata["annualized_funding"], "43.8")
