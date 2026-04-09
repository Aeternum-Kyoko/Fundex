from __future__ import annotations

import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from app.services.history_store import HistoryStore
from tests.test_helpers import make_opportunity, make_snapshot


class HistoryStoreRetentionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.store = HistoryStore(Path(self.temp_dir.name) / "history.db")

    async def asyncTearDown(self) -> None:
        self.temp_dir.cleanup()

    async def test_prune_old_data_removes_old_rows(self) -> None:
        old_time = datetime.now(timezone.utc) - timedelta(days=120)
        recent_time = datetime.now(timezone.utc)

        await self.store.save_snapshots(
            [
                make_snapshot(exchange="binance", fetched_at=old_time),
                make_snapshot(exchange="delta", fetched_at=recent_time, canonical_symbol="ETH-USDT-PERP"),
            ]
        )
        await self.store.save_opportunities(
            [
                make_opportunity(canonical_symbol="BTC-USDT-PERP", updated_at=old_time),
                make_opportunity(canonical_symbol="ETH-USDT-PERP", updated_at=recent_time),
            ]
        )
        await self.store.mark_symbol_alert_exited("BTC-USDT-PERP", "old exit")

        with self.store._connect() as connection:  # noqa: SLF001
            connection.execute(
                """
                UPDATE telegram_symbol_alert_state
                SET last_event_at = ?, last_exited_at = ?
                WHERE canonical_symbol = ?
                """,
                (old_time.isoformat(), old_time.isoformat(), "BTC-USDT-PERP"),
            )
            connection.commit()

        stats = await self.store.prune_old_data(
            funding_snapshot_retention_hours=24,
            opportunity_history_retention_days=30,
            telegram_alert_state_retention_days=30,
        )

        self.assertGreaterEqual(int(stats["funding_snapshots_deleted"]), 1)
        self.assertGreaterEqual(int(stats["opportunity_history_deleted"]), 1)
        self.assertGreaterEqual(int(stats["telegram_alert_state_deleted"]), 1)

    async def test_daily_summary_state_round_trip(self) -> None:
        await self.store.mark_daily_summary_sent("2026-04-09")

        state = await self.store.get_daily_summary_state()

        self.assertIsNotNone(state)
        assert state is not None
        self.assertEqual(state["last_sent_local_date"], "2026-04-09")
        self.assertIn("last_sent_at", state)
