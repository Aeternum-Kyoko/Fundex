from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone

from app.core.config import Settings
from app.services.opportunity_ranker import build_opportunities
from tests.test_helpers import make_snapshot


class OpportunityRankerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.settings = Settings()

    def test_build_opportunities_picks_lowest_and_highest_funding_pair(self) -> None:
        snapshots = [
            make_snapshot(exchange="binance", funding_rate=0.002, exchange_symbol="BTCUSDT"),
            make_snapshot(exchange="delta", funding_rate=-0.001, exchange_symbol="BTCUSD"),
        ]

        opportunities = build_opportunities(snapshots, self.settings)

        self.assertEqual(len(opportunities), 1)
        opportunity = opportunities[0]
        self.assertEqual(opportunity.long_leg.exchange, "delta")
        self.assertEqual(opportunity.short_leg.exchange, "binance")
        self.assertAlmostEqual(opportunity.spread_rate, 0.003)

    def test_stale_snapshots_reduce_confidence_and_set_age(self) -> None:
        stale_time = datetime.now(timezone.utc) - timedelta(seconds=75)
        snapshots = [
            make_snapshot(exchange="binance", funding_rate=0.002, fetched_at=stale_time),
            make_snapshot(exchange="delta", funding_rate=-0.001, fetched_at=stale_time),
        ]

        opportunity = build_opportunities(snapshots, self.settings)[0]

        self.assertIsNotNone(opportunity.max_leg_age_seconds)
        self.assertGreater(opportunity.max_leg_age_seconds or 0, 60)
        self.assertLess(opportunity.confidence_score, 1.0)
        self.assertTrue(any("stale" in warning.lower() for warning in opportunity.warnings))

    def test_build_opportunities_considers_coindcx_when_it_has_the_extreme_rate(self) -> None:
        snapshots = [
            make_snapshot(exchange="binance", funding_rate=0.0015, exchange_symbol="ETHUSDT"),
            make_snapshot(exchange="delta", funding_rate=-0.001, exchange_symbol="ETHUSD"),
            make_snapshot(exchange="coindcx", funding_rate=0.0025, exchange_symbol="B-ETH_USDT"),
        ]

        opportunities = build_opportunities(snapshots, self.settings)

        self.assertEqual(len(opportunities), 1)
        opportunity = opportunities[0]
        self.assertEqual(opportunity.long_leg.exchange, "delta")
        self.assertEqual(opportunity.short_leg.exchange, "coindcx")
        self.assertAlmostEqual(opportunity.spread_rate, 0.0035)
