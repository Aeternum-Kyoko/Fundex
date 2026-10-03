from __future__ import annotations

import asyncio
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

from app.core.config import Settings
from app.models.execution import ExecutionLegPlan
from app.models.trade import FundingLegResult, TradeLegExecution, TradeSessionResponse
from app.services.execution import build_execution_plan
from app.services.market_store import MarketStore
from app.services.opportunity_ranker import build_opportunities, capture_opportunity
from app.services.settled_funding import SettledFundingResolver
from app.services.trade_journal import TradeJournal
from app.services.trade_manager import TradeManager
from tests.test_helpers import make_snapshot

SOON = datetime.now(timezone.utc) + timedelta(hours=1)
_TMP = tempfile.TemporaryDirectory()


def isolated_settings() -> Settings:
    # Never let tests write into the real journal database.
    return Settings(database_path=str(Path(_TMP.name) / "test.sqlite"))


def leg_plan(exchange: str, side: str, notional: float = 1000.0) -> ExecutionLegPlan:
    return ExecutionLegPlan(
        exchange=exchange, display_name=exchange.title(), exchange_symbol="XUSDT", side=side, reference_price=100.0,  # type: ignore[arg-type]
        notional_usd=notional, estimated_quantity=10.0, leverage=2, initial_margin_usd=500, taker_fee_percent=0.05,
        estimated_entry_fee_usd=0.5, estimated_exit_fee_usd=0.5, trade_url="#",
    )


def trade_leg(exchange: str, side: str) -> TradeLegExecution:
    return TradeLegExecution(
        exchange=exchange, display_name=exchange.title(), exchange_symbol="XUSDT", side=side, reference_price=100.0,  # type: ignore[arg-type]
        estimated_quantity=10.0, leverage=2, notional_usd=1000, initial_margin_usd=500, trade_url="#",
    )


def session(status: str = "completed", mode: str = "paper") -> TradeSessionResponse:
    now = datetime.now(timezone.utc)
    return TradeSessionResponse(
        id=f"s-{status}-{mode}", canonical_symbol="X-USDT-PERP", mode=mode, scenario="best", status=status,  # type: ignore[arg-type]
        current_phase="x", created_at=now, updated_at=now, capital_input_usd=1000, leverage=2, holding_periods=1,
        expected_net_pnl_usd=1, expected_funding_pnl_usd=3, estimated_total_fees_usd=2, expected_net_return_on_capital_percent=0.1,
        long_leg=trade_leg("delta", "buy"), short_leg=trade_leg("binance", "sell"),
    )


class CapturePairTests(unittest.TestCase):
    def test_capture_opportunity_and_plan_use_the_next_settlement_pair(self) -> None:
        snapshots = [
            make_snapshot(exchange="binance", funding_rate=0.0005, funding_interval_hours=4, next_funding_time=SOON),
            make_snapshot(exchange="delta", funding_rate=0.0008, funding_interval_hours=8, next_funding_time=SOON),
        ]
        hold = build_opportunities(snapshots, Settings())[0]
        captured = capture_opportunity(hold, snapshots, Settings())

        self.assertEqual(hold.short_leg.exchange, "binance")
        self.assertEqual(captured.short_leg.exchange, "delta")
        plan = build_execution_plan(
            captured, notional_usd=1000, capital_usd=None, leverage=2, leverage_overrides=None, holding_periods=1,
            basis_risk_buffer_percent=0, funding_fraction_override=captured.capture.capture_percent / 100,
        )
        self.assertAlmostEqual(plan.estimated_funding_pnl_usd, 0.3)  # 0.03% of $1,000


class _Response:
    def __init__(self, payload) -> None:
        self.payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self):
        return self.payload


class _Client:
    def __init__(self, payloads: dict) -> None:
        self.payloads = payloads

    async def get(self, url, params=None, timeout=None, headers=None):
        for prefix, payload in self.payloads.items():
            if url.startswith(prefix):
                return _Response(payload)
        raise AssertionError(url)


class SettledFundingTests(unittest.TestCase):
    T = datetime(2026, 10, 2, 16, 0, tzinfo=timezone.utc)

    def test_binance_and_delta_history_are_exact(self) -> None:
        t_ms = int(self.T.timestamp() * 1000)
        client = _Client(
            {
                "https://fapi.binance.com/fapi/v1/fundingRate": [{"fundingTime": t_ms + 3, "fundingRate": "-0.00470676"}],
                "https://api.india.delta.exchange/v2/history/candles": {"result": [{"time": int(self.T.timestamp()), "close": 0.03606298}]},
            }
        )
        resolver = SettledFundingResolver(client, MarketStore())  # type: ignore[arg-type]

        self.assertEqual(asyncio.run(resolver.resolve("binance", "SANDUSDT", "SAND-USDT-PERP", self.T, -0.009)), (-0.00470676, "exchange_history"))
        rate, source = asyncio.run(resolver.resolve("delta", "XRPUSD", "XRP-USDT-PERP", self.T, 0.0003))
        self.assertAlmostEqual(rate, 0.0003606298)
        self.assertEqual(source, "exchange_history")

    def test_venue_without_history_falls_back_to_labelled_estimate(self) -> None:
        resolver = SettledFundingResolver(_Client({}), MarketStore())  # type: ignore[arg-type]
        self.assertEqual(asyncio.run(resolver.resolve("wazirx", "XUSDT", "X-USDT-PERP", self.T, 0.0002)), (0.0002, "estimate"))


class JournalTests(unittest.TestCase):
    def test_round_trip_and_restart_marks_running_trades_interrupted(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            settings = Settings(database_path=str(Path(directory) / "db.sqlite"))
            manager = TradeManager(settings, MarketStore())
            asyncio.run(manager.journal.save(session("completed")))
            asyncio.run(manager.journal.save(session("entered", "live")))

            asyncio.run(manager.start())
            stored = {item.id: item for item in asyncio.run(manager.list_journal())}

            self.assertEqual(stored["s-completed-paper"].status, "completed")
            self.assertEqual(stored["s-entered-live"].status, "failed")
            self.assertIn("open positions", stored["s-entered-live"].events[-1].message)
            asyncio.run(manager.client.aclose())


class _Books:
    def __init__(self, book) -> None:
        self.book = book

    async def fetch(self, exchange, symbol):
        return self.book


class PaperFillTests(unittest.TestCase):
    def test_paper_buy_walks_the_live_book(self) -> None:
        manager = TradeManager(isolated_settings(), MarketStore())
        manager._books = _Books(([(99.9, 100)], [(100.1, 5), (100.3, 100)]))  # type: ignore[assignment]

        price, mid, _ = asyncio.run(manager._book_fill(leg_plan("binance", "buy"), "buy"))

        # $1,000: $500.50 at 100.1 (5 units) then $499.50 at 100.3 (4.98 units).
        self.assertAlmostEqual(mid, 100.0)
        self.assertAlmostEqual(price, 1000 / (5 + 499.5 / 100.3), places=6)
        asyncio.run(manager.client.aclose())

    def test_thin_book_refuses_the_fill(self) -> None:
        manager = TradeManager(isolated_settings(), MarketStore())
        manager._books = _Books(([(99.9, 1)], [(100.1, 1)]))  # type: ignore[assignment]
        with self.assertRaises(RuntimeError):
            asyncio.run(manager._book_fill(leg_plan("binance", "buy"), "buy"))
        asyncio.run(manager.client.aclose())


class ResultTests(unittest.TestCase):
    def test_results_come_from_fills_and_settled_funding(self) -> None:
        manager = TradeManager(isolated_settings(), MarketStore())
        response = session("exiting")
        response.long_leg.entry_fill_price, response.long_leg.entry_mid_price = 100.05, 100.0
        response.long_leg.exit_fill_price, response.long_leg.exit_mid_price = 100.15, 100.2
        response.short_leg.entry_fill_price, response.short_leg.entry_mid_price = 99.95, 100.0
        response.short_leg.exit_fill_price, response.short_leg.exit_mid_price = 100.25, 100.2
        response.funding_legs = [FundingLegResult(exchange="binance", side="short", settles_at=datetime.now(timezone.utc) - timedelta(minutes=5), predicted_rate=0.001)]
        record = SimpleNamespace(response=response, plan=SimpleNamespace(long_leg=leg_plan("delta", "buy"), short_leg=leg_plan("binance", "sell")))
        manager._sessions[response.id] = record  # type: ignore[assignment]

        asyncio.run(manager._finalize_results(response.id))

        # Long +0.10 x 10, short -0.30 x 10 -> -2.00 price; fees 0.05% of four ~$1,000 fills.
        self.assertAlmostEqual(response.realized_price_pnl_usd, -2.0, places=6)
        self.assertAlmostEqual(response.realized_total_fees_usd, (100.05 + 100.15 + 99.95 + 100.25) * 10 * 0.0005, places=6)
        self.assertAlmostEqual(response.realized_slippage_usd, 0.05 * 10 * 4, places=6)

        class _Resolver:
            async def resolve(self, *args):
                return 0.0012, "exchange_history"

        manager._funding_resolver = _Resolver()  # type: ignore[assignment]
        asyncio.run(manager._resolve_settled_funding(response.id))

        self.assertEqual(response.funding_status, "settled")
        self.assertAlmostEqual(response.funding_legs[0].payment_usd, 0.0012 * 99.95 * 10, places=6)
        self.assertAlmostEqual(
            response.realized_net_pnl_usd, -2.0 + 0.0012 * 99.95 * 10 - response.realized_total_fees_usd, places=6
        )
        asyncio.run(manager.client.aclose())


if __name__ == "__main__":
    unittest.main()


class SchedulerTests(unittest.TestCase):
    def test_sleep_follows_the_wall_clock_in_short_steps(self) -> None:
        import app.services.trade_manager as tm

        manager = TradeManager(isolated_settings(), MarketStore())
        slept: list[float] = []
        original_sleep = asyncio.sleep

        async def fake_sleep(seconds: float) -> None:
            slept.append(seconds)
            await original_sleep(0)

        clock = [datetime(2026, 10, 2, 17, 0, tzinfo=timezone.utc)]
        target = clock[0] + timedelta(seconds=12)
        tm_now, tm_sleep = tm._utcnow, tm.asyncio.sleep
        try:
            tm._utcnow = lambda: clock[0]  # type: ignore[assignment]
            tm.asyncio.sleep = fake_sleep  # type: ignore[assignment]

            async def run() -> None:
                task = asyncio.ensure_future(manager._sleep_until(target))
                for _ in range(5):
                    await original_sleep(0)
                    clock[0] += timedelta(seconds=5)  # wall clock jumps (e.g. after a suspend)
                await task

            asyncio.run(run())
        finally:
            tm._utcnow, tm.asyncio.sleep = tm_now, tm_sleep  # type: ignore[assignment]
        self.assertTrue(slept and max(slept) <= tm.WALL_CLOCK_STEP_SECONDS)
        asyncio.run(manager.client.aclose())

    def test_late_entry_is_refused_without_orders(self) -> None:
        manager = TradeManager(isolated_settings(), MarketStore())
        response = session("armed")
        response.scheduled_entry_at = datetime.now(timezone.utc) - timedelta(hours=10)
        response.scheduled_exit_at = response.scheduled_entry_at + timedelta(seconds=45)
        entered: list[str] = []

        async def no_entry(session_id: str) -> None:
            entered.append(session_id)

        manager._simulate_entry = no_entry  # type: ignore[assignment]
        record = SimpleNamespace(response=response, request=SimpleNamespace(mode="paper"), task=None, credentials={})
        manager._sessions[response.id] = record  # type: ignore[assignment]

        asyncio.run(manager._run_session(response.id))

        self.assertEqual(response.status, "failed")
        self.assertEqual(entered, [])
        self.assertIn("Missed the entry window", response.events[-1].message)
        asyncio.run(manager.client.aclose())


def test_recent_settled_funding_reads_binance_history():
    import asyncio

    from app.services.settled_funding import SettledFundingResolver

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return [{"fundingTime": 1_700_000_000_000, "fundingRate": "0.0001"}, {"fundingTime": 1_700_028_800_000, "fundingRate": "0.0003"}]

    class FakeClient:
        async def get(self, url, params=None, timeout=None):
            assert "fundingRate" in url and params["symbol"] == "BTCUSDT"
            return FakeResponse()

    resolver = SettledFundingResolver(FakeClient(), market_store=None)  # type: ignore[arg-type]
    rows = asyncio.run(resolver.recent("binance", "BTCUSDT", 8, None, 2))
    assert [rate for _, rate in rows] == [0.0001, 0.0003]
    assert asyncio.run(resolver.recent("wazirx", "BTC", 8, None, 2)) == []
