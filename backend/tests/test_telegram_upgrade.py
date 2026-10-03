from __future__ import annotations

import asyncio
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx

from app.core.config import Settings
from app.services.history_store import HistoryStore
from app.services.opportunity_ranker import build_opportunities
from app.services.telegram_commands import TelegramCommandService
from app.services.telegram_notifier import TelegramNotifier
from tests.test_helpers import make_snapshot
from tests.test_trade_engine import session

_TMP = tempfile.TemporaryDirectory()


def settings(**overrides) -> Settings:
    return Settings(database_path=str(Path(_TMP.name) / "tg.sqlite"), **overrides)


def opportunities(minutes_to_settle: float, short_rate: float = 0.005):
    soon = datetime.now(timezone.utc) + timedelta(minutes=minutes_to_settle)
    snapshots = [
        make_snapshot(exchange="delta", funding_rate=-0.001, next_funding_time=soon),
        make_snapshot(exchange="binance", funding_rate=short_rate, next_funding_time=soon),
    ]
    return build_opportunities(snapshots, settings())


class CaptureAlertTests(unittest.TestCase):
    def notifier(self, **overrides) -> TelegramNotifier:
        config = settings(**overrides)
        return TelegramNotifier(httpx.AsyncClient(), config, HistoryStore(config.database_file))

    def test_alerts_inside_the_lead_window_once_per_settlement(self) -> None:
        notifier = self.notifier(telegram_capture_lead_minutes=10)
        batch = opportunities(8)
        due = notifier.due_capture_alerts(batch)
        self.assertEqual(len(due), 1)
        notifier._capture_alerts_sent[notifier._capture_key(due[0])] = datetime.now(timezone.utc)
        # Same settlement on the next poll: already alerted.
        self.assertEqual(notifier.due_capture_alerts(batch), [])
        message = notifier.format_capture_alert(due)
        self.assertIn("Settling soon", message)
        self.assertIn("Collect +0.6000%", message)

    def test_no_alert_outside_window_or_below_threshold(self) -> None:
        notifier = self.notifier(telegram_capture_lead_minutes=10)
        self.assertEqual(notifier.due_capture_alerts(opportunities(30)), [])
        self.assertEqual(notifier.due_capture_alerts(opportunities(0.5)), [])  # under a minute: too late to act
        strict = self.notifier(telegram_capture_lead_minutes=10, telegram_min_capture_net_percent=5.0)
        self.assertEqual(strict.due_capture_alerts(opportunities(8)), [])


class HoldAlertRuleTests(unittest.TestCase):
    def test_missing_open_interest_does_not_block_alerts(self) -> None:
        config = settings(telegram_min_spread_percent=0.05, telegram_min_combined_oi_usd=1_000_000)
        notifier = TelegramNotifier(httpx.AsyncClient(), config, HistoryStore(config.database_file))
        soon = datetime.now(timezone.utc) + timedelta(hours=1)
        snapshots = [
            make_snapshot(exchange="wazirx", funding_rate=-0.001, open_interest_usd=None, next_funding_time=soon),
            make_snapshot(exchange="binance", funding_rate=0.002, open_interest_usd=None, next_funding_time=soon),
        ]
        opportunity = build_opportunities(snapshots, config)[0]
        failures = notifier._alert_quality_failures(opportunity)
        self.assertFalse(any("OI" in reason for reason in failures))


class TradeMessageTests(unittest.TestCase):
    def test_finished_and_failed_messages(self) -> None:
        done = session("completed")
        done.realized_net_pnl_usd, done.realized_funding_pnl_usd, done.realized_price_pnl_usd, done.realized_total_fees_usd = -1.5, 0.4, -0.1, 1.8
        self.assertIn("Paper trade X finished: −$1.50", TelegramNotifier.format_trade_message(done, "completed"))
        failed = session("failed", "live")
        self.assertIn("Live trade X failed", TelegramNotifier.format_trade_message(failed, "failed"))


class NextCommandTests(unittest.TestCase):
    def test_next_lists_upcoming_settlements(self) -> None:
        config = settings()
        service = TelegramCommandService(HistoryStore(config.database_file), config)
        reply = asyncio.run(service.build_reply("chat", "/next", [], opportunities(45)))
        self.assertIn("Next settlements worth a trade", reply)
        self.assertIn("sell Binance, buy Delta", reply)


if __name__ == "__main__":
    unittest.main()


class ResultsPrivacyTests(unittest.TestCase):
    def test_trade_results_are_only_shown_to_configured_chats(self) -> None:
        config = settings(telegram_chat_ids=["owner-1"])
        service = TelegramCommandService(HistoryStore(config.database_file), config, journal=object())
        stranger = asyncio.run(service.build_reply("someone-else", "/pnl", [], []))
        self.assertIn("only available", stranger)
        self.assertNotIn("Last 7 days", stranger)
        stranger_trades = asyncio.run(service.build_reply("someone-else", "/trades", [], []))
        self.assertIn("only available", stranger_trades)
