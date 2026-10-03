from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone

from app.core.config import Settings
from app.services.execution import build_execution_plan
from app.services.opportunity_ranker import (
    break_even_hours,
    build_opportunities,
    build_opportunity,
    build_opportunity_leg,
    expected_funding_over_hours,
)
from tests.test_helpers import make_snapshot

NOW = datetime(2026, 10, 2, 15, 0, tzinfo=timezone.utc)


def at(hours: float) -> datetime:
    return NOW + timedelta(hours=hours)


class HourlyNormalisationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.settings = Settings()

    def test_same_raw_rate_on_4h_and_8h_is_a_real_spread(self) -> None:
        # 0.1% every 4h pays twice as much per hour as 0.1% every 8h.
        snapshots = [
            make_snapshot(exchange="binance", funding_rate=0.001, funding_interval_hours=4),
            make_snapshot(exchange="delta", funding_rate=0.001, funding_interval_hours=8),
        ]

        opportunity = build_opportunities(snapshots, self.settings)[0]

        self.assertEqual(opportunity.long_leg.exchange, "delta")
        self.assertEqual(opportunity.short_leg.exchange, "binance")
        self.assertAlmostEqual(opportunity.spread_rate_hourly, 0.001 / 4 - 0.001 / 8)
        self.assertAlmostEqual(opportunity.spread_rate, 0.001)  # 8h-equivalent
        self.assertAlmostEqual(opportunity.gross_apr_percent, 0.000125 * 8760 * 100)

    def test_pair_is_chosen_on_hourly_rate_not_raw_rate(self) -> None:
        snapshots = [
            make_snapshot(exchange="binance", funding_rate=0.0006, funding_interval_hours=4),   # 0.015%/h
            make_snapshot(exchange="coindcx", funding_rate=0.0010, funding_interval_hours=8),   # 0.0125%/h
            make_snapshot(exchange="delta", funding_rate=-0.0002, funding_interval_hours=8),    # -0.0025%/h
        ]

        opportunity = build_opportunities(snapshots, self.settings)[0]

        self.assertEqual(opportunity.short_leg.exchange, "binance")
        self.assertEqual(opportunity.long_leg.exchange, "delta")
        self.assertEqual(opportunity.long_leg.funding_interval_hours, 8)
        self.assertEqual(opportunity.short_leg.funding_interval_hours, 4)
        self.assertTrue(any("different schedules" in warning for warning in opportunity.warnings))

    def test_slow_refresh_venue_is_flagged(self) -> None:
        slow = make_snapshot(exchange="wazirx", funding_rate=-0.001)
        slow.metadata["rate_refresh_seconds"] = 900
        slow.metadata["rate_changed_at"] = (datetime.now(timezone.utc) - timedelta(minutes=7, seconds=5)).isoformat()
        snapshots = [make_snapshot(exchange="binance", funding_rate=0.002), slow]

        opportunity = build_opportunities(snapshots, self.settings)[0]

        self.assertTrue(any("unchanged for at least 7m" in warning for warning in opportunity.warnings))

    def test_assumed_interval_is_flagged(self) -> None:
        guessed = make_snapshot(exchange="wazirx", funding_rate=-0.001)
        guessed.metadata["interval_source"] = "assumed"
        opportunity = build_opportunities([make_snapshot(exchange="binance", funding_rate=0.002), guessed], self.settings)[0]

        self.assertTrue(any("8h is assumed" in warning for warning in opportunity.warnings))

    def test_equal_spreads_prefer_the_pair_with_visible_open_interest(self) -> None:
        snapshots = [
            make_snapshot(exchange="wazirx", funding_rate=0.00005, open_interest_usd=None),
            make_snapshot(exchange="binance", funding_rate=0.0001, open_interest_usd=None),
            make_snapshot(exchange="delta", funding_rate=0.0001, open_interest_usd=3_000_000),
        ]

        opportunity = build_opportunities(snapshots, self.settings)[0]

        self.assertEqual((opportunity.long_leg.exchange, opportunity.short_leg.exchange), ("wazirx", "delta"))

    def test_pairs_with_implausible_price_gap_are_dropped(self) -> None:
        snapshots = [
            make_snapshot(exchange="binance", funding_rate=0.002, mark_price=0.01),
            make_snapshot(exchange="delta", funding_rate=-0.001, mark_price=10.0),  # 1000x-style contract
        ]

        self.assertEqual(build_opportunities(snapshots, self.settings), [])


class CostAndHorizonTests(unittest.TestCase):
    def setUp(self) -> None:
        self.settings = Settings(holding_horizon_hours=168)

    def test_costs_are_paid_once_not_every_period(self) -> None:
        long_leg = make_snapshot(exchange="delta", funding_rate=-0.001, next_funding_time=at(1))
        short_leg = make_snapshot(exchange="binance", funding_rate=0.002, next_funding_time=at(1))

        opportunity = build_opportunity(long_leg, short_leg, self.settings, now=NOW)

        # Fees: 5 bps taker on each leg, entry + exit = 0.2%. Slippage 0.04% per leg (4M combined OI) x2.
        self.assertAlmostEqual(opportunity.estimated_round_trip_fee_percent, 0.2)
        self.assertAlmostEqual(opportunity.estimated_slippage_percent, 0.04)
        self.assertAlmostEqual(opportunity.estimated_total_cost_percent, 0.28)
        # Settlements at 1h, 9h, ... 161h -> 21 inside 168h, each worth 0.3%.
        self.assertAlmostEqual(opportunity.expected_funding_percent, 21 * 0.3)
        self.assertAlmostEqual(opportunity.net_return_percent, 21 * 0.3 - 0.28)
        self.assertAlmostEqual(opportunity.net_apr_percent, (21 * 0.3 - 0.28) * 8760 / 168)
        self.assertGreater(opportunity.net_apr_percent, 0)
        # First settlement pays 0.3% >= 0.28% costs.
        self.assertAlmostEqual(opportunity.break_even_hours or 0, 1.0)

    def test_small_spread_breaks_even_later_instead_of_showing_huge_negative_apr(self) -> None:
        # 0.02% per 8h edge: the old formula subtracted 0.28% every period (about -280% APR).
        long_leg = make_snapshot(exchange="delta", funding_rate=0.0, next_funding_time=at(2), open_interest_usd=2_000_000)
        short_leg = make_snapshot(exchange="binance", funding_rate=0.0002, next_funding_time=at(2))

        opportunity = build_opportunity(long_leg, short_leg, self.settings, now=NOW)

        # 14 settlements (2h, 10h, ..., 106h) are needed to collect 0.28%.
        self.assertAlmostEqual(opportunity.break_even_hours or 0, 2 + 13 * 8)
        self.assertAlmostEqual(opportunity.expected_funding_percent, 21 * 0.02)
        self.assertAlmostEqual(opportunity.net_return_percent, 21 * 0.02 - 0.28)
        self.assertGreater(opportunity.net_apr_percent, 0)

    def test_unprofitable_hold_is_flagged(self) -> None:
        settings = Settings(holding_horizon_hours=24)
        long_leg = make_snapshot(exchange="delta", funding_rate=0.0, next_funding_time=at(2))
        short_leg = make_snapshot(exchange="binance", funding_rate=0.0002, next_funding_time=at(2))

        opportunity = build_opportunity(long_leg, short_leg, settings, now=NOW)

        self.assertLess(opportunity.net_return_percent, 0)
        self.assertTrue(any("Not profitable" in warning for warning in opportunity.warnings))


class SettlementScheduleTests(unittest.TestCase):
    def test_mixed_intervals_count_each_legs_real_settlements(self) -> None:
        long_leg = build_opportunity_leg(
            make_snapshot(exchange="delta", funding_rate=-0.0008, funding_interval_hours=8, next_funding_time=at(7))
        )
        short_leg = build_opportunity_leg(
            make_snapshot(exchange="binance", funding_rate=0.0004, funding_interval_hours=4, next_funding_time=at(1))
        )

        # Over 10h: long settles once (7h) earning 0.08%; short settles at 1h, 5h, 9h earning 3 x 0.04%.
        funding = expected_funding_over_hours(long_leg, short_leg, 10, now=NOW)

        self.assertAlmostEqual(funding, 0.0008 + 3 * 0.0004)

    def test_next_funding_in_the_past_rolls_forward(self) -> None:
        long_leg = build_opportunity_leg(
            make_snapshot(exchange="delta", funding_rate=0.0, funding_interval_hours=8, next_funding_time=at(-0.5))
        )
        short_leg = build_opportunity_leg(
            make_snapshot(exchange="binance", funding_rate=0.001, funding_interval_hours=8, next_funding_time=at(-0.5))
        )

        # The stale timestamp means the next real settlement is 7.5h away, so nothing lands in 7h.
        self.assertAlmostEqual(expected_funding_over_hours(long_leg, short_leg, 7, now=NOW), 0.0)
        self.assertAlmostEqual(break_even_hours(long_leg, short_leg, 0.001, now=NOW) or 0, 7.5)

    def test_break_even_is_none_when_funding_never_covers_costs(self) -> None:
        long_leg = build_opportunity_leg(make_snapshot(exchange="delta", funding_rate=0.0, next_funding_time=at(1)))
        short_leg = build_opportunity_leg(make_snapshot(exchange="binance", funding_rate=0.000001, next_funding_time=at(1)))

        self.assertIsNone(break_even_hours(long_leg, short_leg, 0.01, now=NOW))


class TradeWindowTests(unittest.TestCase):
    def test_short_window_only_collects_legs_settling_inside_it(self) -> None:
        from app.services.opportunity_ranker import funding_events
        from app.services.trade_manager import TradeManager

        # Long leg pays out at T (rate +0.05%, so the long side PAYS); short leg settles 4h later.
        long_leg = make_snapshot(exchange="delta", funding_rate=0.0005, funding_interval_hours=8, next_funding_time=at(1))
        short_leg = make_snapshot(exchange="binance", funding_rate=0.0012, funding_interval_hours=8, next_funding_time=at(5))
        opportunity = build_opportunity(long_leg, short_leg, Settings(), now=NOW)
        entry, exit_ = at(1) - timedelta(seconds=30), at(1) + timedelta(seconds=30)

        events = funding_events(opportunity.long_leg, opportunity.short_leg, (exit_ - entry).total_seconds() / 3600, now=entry)

        self.assertEqual(TradeManager._settling_leg_names(opportunity, entry, exit_), ["long"])
        self.assertAlmostEqual(sum(amount for _, amount in events), -0.0005)  # a cost, not income


class ExecutionPlanConsistencyTests(unittest.TestCase):
    def test_plan_funding_uses_the_same_schedule_maths_as_the_table(self) -> None:
        settings = Settings()
        long_leg = make_snapshot(exchange="delta", funding_rate=-0.0008, funding_interval_hours=8, next_funding_time=datetime.now(timezone.utc) + timedelta(hours=7))
        short_leg = make_snapshot(exchange="binance", funding_rate=0.0004, funding_interval_hours=4, next_funding_time=datetime.now(timezone.utc) + timedelta(hours=1))
        opportunity = build_opportunity(long_leg, short_leg, settings)

        plan = build_execution_plan(
            opportunity,
            notional_usd=10_000,
            capital_usd=None,
            leverage=2,
            leverage_overrides=None,
            holding_periods=3,  # 3 x 4h (the faster leg) = 12h
            basis_risk_buffer_percent=0.0,
        )

        # 12h: long settles at 7h (+0.08%), short at 1h, 5h, 9h (+0.12%) -> 0.20% of 10,000.
        self.assertAlmostEqual(plan.estimated_funding_pnl_usd, 20.0, places=6)


if __name__ == "__main__":
    unittest.main()
