from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone

from app.core.config import Settings
from app.services.liquidity import RankingContext
from app.services.opportunity_ranker import best_capture, build_opportunities
from tests.test_helpers import make_snapshot

NOW = datetime(2026, 10, 2, 15, 0, tzinfo=timezone.utc)


def at(hours: float) -> datetime:
    return NOW + timedelta(hours=hours)


class CaptureTests(unittest.TestCase):
    def setUp(self) -> None:
        self.settings = Settings()

    def test_both_legs_settling_together_collect_both_payments_once(self) -> None:
        entries = [
            make_snapshot(exchange="delta", funding_rate=-0.001, next_funding_time=at(1)),
            make_snapshot(exchange="binance", funding_rate=0.002, next_funding_time=at(1)),
        ]

        capture = best_capture(entries, self.settings, RankingContext(), NOW, [])

        self.assertEqual((capture.long_leg.exchange, capture.short_leg.exchange), ("delta", "binance"))
        self.assertEqual(capture.settling, "both")
        self.assertAlmostEqual(capture.capture_percent, 0.3)
        self.assertAlmostEqual(capture.fee_percent, 0.2)  # 5 bps taker, in and out, both legs
        self.assertAlmostEqual(capture.slippage_percent, 0.08)
        self.assertAlmostEqual(capture.net_percent, 0.3 - 0.28)
        self.assertEqual(capture.settles_at, at(1))

    def test_capture_uses_raw_rates_so_it_can_pick_the_opposite_pair_to_the_hold(self) -> None:
        # Binance 0.05% every 4h beats Delta 0.08% every 8h per hour, so the HOLD shorts Binance.
        # At the shared 16:00 settlement each pays its raw rate once, so the CAPTURE shorts Delta.
        soon = datetime.now(timezone.utc) + timedelta(hours=1)
        entries = [
            make_snapshot(exchange="binance", funding_rate=0.0005, funding_interval_hours=4, next_funding_time=soon),
            make_snapshot(exchange="delta", funding_rate=0.0008, funding_interval_hours=8, next_funding_time=soon),
        ]

        opportunity = build_opportunities(entries, self.settings)[0]

        self.assertEqual(opportunity.short_leg.exchange, "binance")
        self.assertEqual(opportunity.capture.short_leg.exchange, "delta")
        self.assertAlmostEqual(opportunity.capture.capture_percent, 0.03)

    def test_only_the_leg_settling_in_the_window_pays(self) -> None:
        entries = [
            make_snapshot(exchange="coindcx", funding_rate=0.003, next_funding_time=at(1)),
            make_snapshot(exchange="delta", funding_rate=0.0, next_funding_time=at(5)),
        ]

        capture = best_capture(entries, self.settings, RankingContext(), NOW, [])

        self.assertEqual(capture.short_leg.exchange, "coindcx")
        self.assertEqual(capture.settling, "short")
        self.assertFalse(capture.long_leg.settles_in_window)
        self.assertAlmostEqual(capture.capture_percent, 0.3)
        self.assertEqual(capture.settles_at, at(1))

    def test_hold_only_checks_do_not_drag_capture_trust(self) -> None:
        soon = datetime.now(timezone.utc) + timedelta(hours=1)
        entries = [
            make_snapshot(exchange="delta", funding_rate=-0.001, next_funding_time=soon),
            make_snapshot(exchange="binance", funding_rate=0.0011, next_funding_time=soon),
        ]
        opportunity = build_opportunities(entries, Settings(holding_horizon_hours=1))[0]

        self.assertTrue(any(check.key == "profit" and check.status == "fail" for check in opportunity.trust_checks))
        self.assertNotEqual(opportunity.capture.data_trust_level, "low")


if __name__ == "__main__":
    unittest.main()
