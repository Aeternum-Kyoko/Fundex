from __future__ import annotations

import asyncio
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

from cryptography.fernet import Fernet
from fastapi import HTTPException

from app.api.admin import require_admin
from app.core.config import Settings
from app.services.credentials import BinanceAccountProbe, CredentialStore, StoredCredential
from app.services.liquidity import (
    DepthQuote,
    LiquidityService,
    RankingContext,
    SpreadTracker,
    build_depth_quote,
    impact_percent,
)
from app.services.opportunity_ranker import build_opportunities, build_opportunity
from tests.test_helpers import make_opportunity, make_snapshot

NOW = datetime(2026, 10, 2, 15, 0, tzinfo=timezone.utc)


class OrderBookMathTests(unittest.TestCase):
    def test_impact_walks_levels_and_reports_average_distance_from_mid(self) -> None:
        # $1,000 buy: $500 at 100.0 (5 units) + $500 at 101.0 (4.9505 units) -> avg 100.4975.
        impact = impact_percent([(100.0, 5), (101.0, 100)], 1_000, mid_price=99.95)
        self.assertAlmostEqual(impact, (1000 / (5 + 500 / 101) - 99.95) / 99.95 * 100, places=9)

    def test_thin_book_is_unfillable(self) -> None:
        self.assertIsNone(impact_percent([(1.0, 10)], 1_000, mid_price=1.0))

    def test_depth_quote_round_trip_is_buy_plus_sell_impact(self) -> None:
        quote = build_depth_quote("binance", "XUSDT", bids=[(99.9, 100)], asks=[(100.1, 100)], notional_usd=1_000, now=NOW)
        self.assertIsNotNone(quote)
        self.assertAlmostEqual(quote.mid_price, 100.0)
        self.assertAlmostEqual(quote.round_trip_percent or 0, 0.2, places=9)
        self.assertAlmostEqual(quote.top_of_book_spread_percent, 0.2, places=9)


class _FixedLiquidity(LiquidityService):
    def __init__(self, quotes: dict) -> None:
        super().__init__(client=None, notional_usd=1_000, top_n=1, max_age_seconds=120)  # type: ignore[arg-type]
        self._quotes = quotes


def _quote(exchange: str, symbol: str, buy: float | None, sell: float | None) -> DepthQuote:
    return DepthQuote(exchange, symbol, datetime.now(timezone.utc), 1_000, 1.0, buy, sell, 0.02)  # type: ignore[arg-type]


class LiquidityInRankingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.settings = Settings(liquidity_reference_notional_usd=1_000)
        self.snapshots = [
            make_snapshot(exchange="delta", funding_rate=-0.001, exchange_symbol="BTCUSD"),
            make_snapshot(exchange="binance", funding_rate=0.002, exchange_symbol="BTCUSDT"),
        ]

    def test_measured_books_replace_the_estimate(self) -> None:
        context = RankingContext(
            liquidity=_FixedLiquidity({("delta", "BTCUSD"): _quote("delta", "BTCUSD", 0.03, 0.02), ("binance", "BTCUSDT"): _quote("binance", "BTCUSDT", 0.01, 0.01)})
        )
        opportunity = build_opportunities(self.snapshots, self.settings, context)[0]

        self.assertEqual(opportunity.slippage_source, "orderbook")
        self.assertAlmostEqual(opportunity.long_leg.slippage_round_trip_percent or 0, 0.05)
        self.assertAlmostEqual(opportunity.estimated_total_cost_percent, 0.2 + 0.05 + 0.02)
        self.assertEqual(next(c for c in opportunity.trust_checks if c.key == "liquidity").status, "pass")

    def test_unfillable_book_makes_trust_low(self) -> None:
        context = RankingContext(liquidity=_FixedLiquidity({("delta", "BTCUSD"): _quote("delta", "BTCUSD", None, 0.02)}))
        opportunity = build_opportunities(self.snapshots, self.settings, context)[0]

        self.assertEqual(opportunity.trust_level, "low")
        self.assertTrue(any("cannot fill $1,000" in warning for warning in opportunity.warnings))

    def test_unmeasured_liquidity_is_called_an_estimate(self) -> None:
        opportunity = build_opportunities(self.snapshots, self.settings)[0]

        self.assertEqual(opportunity.slippage_source, "estimate")
        self.assertEqual(next(c for c in opportunity.trust_checks if c.key == "liquidity").status, "warn")

    def test_account_fee_tier_overrides_default_fee(self) -> None:
        context = RankingContext(taker_fee_overrides_bps={"binance": 3.6})
        opportunity = build_opportunities(self.snapshots, self.settings, context)[0]

        self.assertAlmostEqual(opportunity.short_leg.taker_fee_bps, 3.6)
        self.assertAlmostEqual(opportunity.estimated_round_trip_fee_percent, (5 + 3.6) * 2 / 100)


class TrustLevelTests(unittest.TestCase):
    def test_new_edge_cannot_be_high_trust(self) -> None:
        from app.models.market import TrustCheck
        from app.services.opportunity_ranker import summarise_trust

        clean = [TrustCheck(key="profit", label="After costs", status="pass", detail="ok")]
        self.assertEqual(summarise_trust(clean)[0], "high")
        unproven = clean + [TrustCheck(key="persistence", label="Persistence", status="info", detail="New")]
        self.assertEqual(summarise_trust(unproven)[0], "medium")


class PersistenceTests(unittest.TestCase):
    def test_lasting_edge_passes_and_spike_fails(self) -> None:
        tracker = SpreadTracker(window=timedelta(hours=2), sample_every=timedelta(seconds=30))
        lasting = make_opportunity(long_exchange="delta", short_exchange="binance", spread_rate=0.0008)
        lasting.spread_rate_hourly = 0.0001
        for minute in range(60):
            tracker.record([lasting], now=NOW + timedelta(minutes=minute))
        minutes, share, count = tracker.persistence("BTC-USDT-PERP", "delta", "binance", 0.0001, now=NOW + timedelta(minutes=60))
        self.assertGreaterEqual(minutes, 59)
        self.assertEqual(share, 1.0)

        _, spike_share, _ = tracker.persistence("BTC-USDT-PERP", "delta", "binance", 0.001, now=NOW + timedelta(minutes=60))
        self.assertEqual(spike_share, 0.0)

    def test_persistence_check_reaches_the_opportunity(self) -> None:
        tracker = SpreadTracker()
        seed = make_opportunity(long_exchange="delta", short_exchange="binance")
        seed.spread_rate_hourly = 0.0003 / 8
        start = datetime.now(timezone.utc) - timedelta(minutes=40)
        for minute in range(0, 40):
            tracker.record([seed], now=start + timedelta(minutes=minute))
        snapshots = [
            make_snapshot(exchange="delta", funding_rate=-0.001),
            make_snapshot(exchange="binance", funding_rate=0.002),  # 0.3%/8h now vs 0.03%/8h tracked
        ]
        opportunity = build_opportunities(snapshots, Settings(), RankingContext(spreads=tracker))[0]

        check = next(c for c in opportunity.trust_checks if c.key == "persistence")
        self.assertEqual(check.status, "fail")
        self.assertIn("spike", check.detail)


class FirstPaymentTests(unittest.TestCase):
    def test_first_settlement_that_costs_money_is_flagged(self) -> None:
        # Long leg has a positive rate (long pays) and settles first; short pays later.
        long_leg = make_snapshot(exchange="delta", funding_rate=0.0005, next_funding_time=NOW + timedelta(hours=1))
        short_leg = make_snapshot(exchange="binance", funding_rate=0.003, next_funding_time=NOW + timedelta(hours=5))

        opportunity = build_opportunity(long_leg, short_leg, Settings(), now=NOW)

        check = next(c for c in opportunity.trust_checks if c.key == "first_payment")
        self.assertEqual(check.status, "warn")
        self.assertIn("costs 0.0500%", check.detail)


class CredentialStoreTests(unittest.TestCase):
    def test_round_trip_is_encrypted_and_summaries_never_leak_secrets(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "db.sqlite"
            store = CredentialStore(path, Fernet.generate_key().decode())
            asyncio.run(store.set("binance", "PUBLICKEY12345678", "SECRET-VALUE-abcdef", {}))

            credential = asyncio.run(store.get("binance"))
            self.assertEqual((credential.api_key, credential.api_secret), ("PUBLICKEY12345678", "SECRET-VALUE-abcdef"))
            self.assertNotIn(b"SECRET-VALUE", path.read_bytes())
            summary = asyncio.run(store.summaries())["binance"]
            self.assertEqual(summary["key_hint"], "…5678")
            self.assertNotIn("SECRET", str(summary))

            # A different encryption key cannot read the row.
            other = CredentialStore(path, Fernet.generate_key().decode())
            self.assertIsNone(asyncio.run(other.get("binance")))

    def test_store_refuses_without_encryption_key(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = CredentialStore(Path(directory) / "db.sqlite", None)
            with self.assertRaises(RuntimeError):
                asyncio.run(store.set("binance", "PUBLICKEY12345678", "SECRET-VALUE", {}))


class AdminAuthTests(unittest.TestCase):
    def _request(self, token: str | None):
        return SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(settings=SimpleNamespace(admin_token=token))))

    def test_disabled_without_token(self) -> None:
        with self.assertRaises(HTTPException) as caught:
            asyncio.run(require_admin(self._request(None), "anything"))
        self.assertEqual(caught.exception.status_code, 503)

    def test_wrong_and_right_token(self) -> None:
        with self.assertRaises(HTTPException) as caught:
            asyncio.run(require_admin(self._request("correct-token-value"), "wrong"))
        self.assertEqual(caught.exception.status_code, 401)
        asyncio.run(require_admin(self._request("correct-token-value"), "correct-token-value"))


class _ProbeClient:
    def __init__(self, routes: dict) -> None:
        self.routes = routes
        self.headers_seen: list[dict] = []

    async def get(self, url: str, headers=None, timeout=None):
        self.headers_seen.append(headers or {})
        for prefix, (status, payload) in self.routes.items():
            if url.startswith(prefix):
                assert "signature=" in url and "timestamp=" in url
                return SimpleNamespace(status_code=status, json=lambda payload=payload: payload, text=str(payload))
        raise AssertionError(url)


class BinanceProbeTests(unittest.TestCase):
    credential = StoredCredential("binance", "KEYKEYKEY", "SECRETSECRET", {}, "now")

    def test_fee_tier_is_read_and_withdrawal_keys_are_flagged(self) -> None:
        client = _ProbeClient(
            {
                "https://fapi.binance.com/fapi/v1/commissionRate": (200, {"takerCommissionRate": "0.00036", "makerCommissionRate": "0.00018"}),
                "https://api.binance.com/sapi/v1/account/apiRestrictions": (200, {"enableWithdrawals": True, "enableFutures": False}),
            }
        )
        status, message, details = asyncio.run(BinanceAccountProbe(client).probe(self.credential))  # type: ignore[arg-type]

        self.assertAlmostEqual(details["taker_fee_bps"], 3.6)
        self.assertEqual(status, "warning")
        self.assertIn("WITHDRAW", message)
        self.assertEqual(client.headers_seen[0]["X-MBX-APIKEY"], "KEYKEYKEY")

    def test_rejected_key_raises(self) -> None:
        client = _ProbeClient({"https://fapi.binance.com/fapi/v1/commissionRate": (401, {"msg": "Invalid API-key"})})
        with self.assertRaises(PermissionError):
            asyncio.run(BinanceAccountProbe(client).probe(self.credential))  # type: ignore[arg-type]


if __name__ == "__main__":
    unittest.main()


def test_depth_profile_reports_impact_by_size_and_max_size():
    from app.services.liquidity import depth_profile

    asks = [(100.0 + i * 0.01, 50.0) for i in range(40)]
    bids = [(99.99 - i * 0.01, 50.0) for i in range(40)]
    profile = depth_profile(bids, asks)
    assert profile is not None
    sizes = profile["sizes"]
    assert sizes[0]["buy_percent"] is not None
    assert sizes[0]["buy_percent"] <= sizes[3]["buy_percent"]
    assert 0 < profile["max_size_usd"] < 40 * 50 * 100
    assert depth_profile([], asks) is None
