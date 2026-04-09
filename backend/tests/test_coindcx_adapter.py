from __future__ import annotations

import unittest
from datetime import datetime, timezone

from app.adapters.coindcx import CoinDCXAdapter


class CoinDCXAdapterTests(unittest.TestCase):
    def test_next_funding_boundary_respects_four_hour_frequency(self) -> None:
        reference = datetime(2026, 4, 9, 5, 17, tzinfo=timezone.utc)

        next_boundary = CoinDCXAdapter._next_funding_boundary(int(reference.timestamp() * 1000), 4)

        self.assertEqual(next_boundary, datetime(2026, 4, 9, 8, 0, tzinfo=timezone.utc))

    def test_next_funding_boundary_respects_eight_hour_frequency(self) -> None:
        reference = datetime(2026, 4, 9, 5, 17, tzinfo=timezone.utc)

        next_boundary = CoinDCXAdapter._next_funding_boundary(int(reference.timestamp() * 1000), 8)

        self.assertEqual(next_boundary, datetime(2026, 4, 9, 8, 0, tzinfo=timezone.utc))
