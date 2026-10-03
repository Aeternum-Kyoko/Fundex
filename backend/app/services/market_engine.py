from __future__ import annotations

import asyncio
import contextlib
import logging
from datetime import datetime, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from httpx import AsyncClient

from app.adapters.base import ExchangeAdapter
from app.adapters.binance import BinanceAdapter
from app.adapters.coindcx import CoinDCXAdapter
from app.adapters.coinswitch import CoinSwitchAdapter
from app.adapters.delta import DeltaAdapter
from app.adapters.wazirx import WazirXAdapter
from app.core.config import Settings
from app.models.market import ExchangeStatus
from app.services.arbitrage import build_opportunities
from app.services.history_store import HistoryStore
from app.services.links import exchange_display_name
from app.services.credentials import BinanceAccountProbe, CredentialStore
from app.services.liquidity import LiquidityService, RankingContext, SpreadTracker, enabled_exchange_names
from app.services.market_store import MarketStore
from app.services.telegram_notifier import TelegramNotifier

logger = logging.getLogger(__name__)


class MarketEngine:
    def __init__(self, settings: Settings, store: MarketStore, history_store: HistoryStore) -> None:
        self.settings = settings
        self.store = store
        self.history_store = history_store
        self.client = AsyncClient()
        self.telegram_notifier = TelegramNotifier(self.client, settings, history_store)
        self.adapters: list[ExchangeAdapter] = []
        self.tasks: list[asyncio.Task[None]] = []
        # Bumped after every successful poll; the dashboard stream tells clients to refetch when it changes.
        self.data_version = 0
        self._data_changed = asyncio.Event()
        self._last_history_save: datetime | None = None
        self._last_snapshot_save: datetime | None = None
        self.ranking_context = RankingContext(
            liquidity=LiquidityService(
                self.client,
                notional_usd=settings.liquidity_reference_notional_usd,
                top_n=settings.liquidity_top_n,
                max_age_seconds=settings.liquidity_max_age_seconds,
            ),
            spreads=SpreadTracker(),
        )
        self.telegram_notifier.command_service.ranking_context = self.ranking_context
        self.credential_store = CredentialStore(settings.database_file, settings.credentials_encryption_key)
        self._binance_probe = BinanceAccountProbe(self.client)
        self._coinswitch_task: asyncio.Task[None] | None = None
        self._coinswitch_adapter: CoinSwitchAdapter | None = None
        self._metrics: dict[str, dict[str, int | float | str | None]] = {
            "adapters": {},
            "retention": {
                "runs": 0,
                "last_run_at": None,
                "last_deleted_total": 0,
                "last_verification_at": None,
                "last_verification_local_date": None,
                "last_verification_ok": None,
            },
            "telegram": {"bot_polls": 0, "bot_poll_errors": 0, "last_processed_updates": 0},
        }
        try:
            self._retention_timezone = ZoneInfo(self.settings.telegram_daily_summary_timezone)
        except ZoneInfoNotFoundError:
            logger.warning(
                "Invalid timezone %s for retention verification logs; falling back to UTC",
                self.settings.telegram_daily_summary_timezone,
            )
            self._retention_timezone = timezone.utc

        if settings.binance_enabled:
            self.adapters.append(BinanceAdapter(self.client, settings))
        if settings.delta_enabled:
            self.adapters.append(DeltaAdapter(self.client, settings))
        if settings.coindcx_enabled:
            self.adapters.append(CoinDCXAdapter(self.client, settings))
        if settings.coinswitch_enabled and settings.coinswitch_configured:
            self.adapters.append(CoinSwitchAdapter(self.client, settings))
        if settings.wazirx_enabled:
            self.adapters.append(WazirXAdapter(self.client, settings))

    async def start(self) -> None:
        await self._seed_statuses()
        for adapter in self.adapters:
            self.tasks.append(asyncio.create_task(self._run_adapter(adapter), name=f"{adapter.exchange}-poller"))
        if self.settings.telegram_enabled and self.settings.telegram_bot_token:
            self.tasks.append(asyncio.create_task(self._run_telegram_bot(), name="telegram-bot-poller"))
        self.tasks.append(asyncio.create_task(self._run_liquidity(), name="liquidity-sampler"))
        for exchange in ("binance", "coinswitch"):
            try:
                await self.apply_credentials(exchange)
            except Exception:  # pragma: no cover
                logger.exception("Applying stored %s credentials failed", exchange)

    def _signal_data_changed(self) -> None:
        self.data_version += 1
        self._data_changed.set()
        self._data_changed = asyncio.Event()

    async def wait_for_change(self, known_version: int, timeout: float) -> int:
        if self.data_version != known_version:
            return self.data_version
        event = self._data_changed
        try:
            await asyncio.wait_for(event.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            pass
        return self.data_version

    async def _save_history_if_due(self, snapshots, opportunities) -> None:
        # Feeds the per-pair history charts and funding trends (previously never written).
        now = datetime.now(timezone.utc)
        try:
            if self._last_history_save is None or (now - self._last_history_save).total_seconds() >= 60:
                self._last_history_save = now
                await self.history_store.save_opportunities(opportunities)
            if self._last_snapshot_save is None or (now - self._last_snapshot_save).total_seconds() >= 300:
                self._last_snapshot_save = now
                await self.history_store.save_snapshots(snapshots)
        except Exception:  # pragma: no cover
            logger.exception("Saving history failed")

    def enabled_exchange_names(self) -> list[str]:
        return enabled_exchange_names(self.settings, self.ranking_context)

    async def apply_credentials(self, exchange: str) -> dict:
        """Load the stored key for `exchange`, verify it and put it to work. Returns the verification outcome."""
        credential = await self.credential_store.get(exchange)
        if exchange == "binance":
            if credential is None:
                self.ranking_context.taker_fee_overrides_bps.pop("binance", None)
                return {"status": "not_configured", "message": "No key stored; Binance's default 0.05% taker fee is used."}
            try:
                status, message, details = await self._binance_probe.probe(credential)
                self.ranking_context.taker_fee_overrides_bps["binance"] = float(details["taker_fee_bps"])
            except Exception as exc:
                self.ranking_context.taker_fee_overrides_bps.pop("binance", None)
                status, message, details = "error", f"{exc}. Falling back to the default fee.", {}
            await self.credential_store.record_verification(exchange, status, message, details)
            return {"status": status, "message": message, "details": details}

        if exchange == "coinswitch":
            await self._stop_coinswitch()
            if credential is None:
                self.ranking_context.runtime_exchanges.discard("coinswitch")
                return {"status": "not_configured", "message": "No key stored; CoinSwitch is not monitored."}
            adapter = CoinSwitchAdapter(
                self.client,
                self.settings,
                api_key=credential.api_key,
                secret_key=credential.api_secret,
                exchange_code=credential.extra.get("exchange") or self.settings.coinswitch_exchange,
            )
            try:
                snapshots = await adapter.fetch_snapshots()
            except Exception as exc:
                message = f"CoinSwitch rejected the key or returned no data: {exc}"
                await self.credential_store.record_verification(exchange, "error", message, {})
                await self.store.mark_error("coinswitch", "CoinSwitch", message, configured=False)
                return {"status": "error", "message": message}
            await self.store.update_exchange("coinswitch", "CoinSwitch", snapshots)
            self._coinswitch_adapter = adapter
            self.ranking_context.runtime_exchanges.add("coinswitch")
            self._coinswitch_task = asyncio.create_task(self._run_adapter(adapter), name="coinswitch-poller")
            message = f"Verified: {len(snapshots)} CoinSwitch perpetuals are now monitored."
            await self.credential_store.record_verification(exchange, "verified", message, {"symbols": len(snapshots)})
            return {"status": "verified", "message": message}

        return {"status": "not_supported", "message": "This exchange does not need API keys."}

    async def _stop_coinswitch(self) -> None:
        if self._coinswitch_task and not self._coinswitch_task.done():
            self._coinswitch_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._coinswitch_task
        self._coinswitch_task = None
        self._coinswitch_adapter = None

    async def build_opportunities(self, snapshots=None):
        snapshots = snapshots if snapshots is not None else await self.store.get_snapshots()
        return build_opportunities(snapshots, self.settings, self.ranking_context)

    async def _run_liquidity(self) -> None:
        # Sample order books for the strongest pairs; separate from feed polling so a slow book never delays rates.
        await asyncio.sleep(5)
        while True:
            try:
                opportunities = await self.build_opportunities()
                measured = await self.ranking_context.liquidity.refresh(opportunities)  # type: ignore[union-attr]
                logger.info("Sampled %s order books for liquidity", measured)
            except Exception:  # pragma: no cover
                logger.exception("Liquidity sampling failed")
            await asyncio.sleep(max(15.0, self.settings.liquidity_max_age_seconds / 3))

    async def stop(self) -> None:
        for task in self.tasks:
            task.cancel()
        for task in self.tasks:
            with contextlib.suppress(asyncio.CancelledError):
                await task
        for adapter in self.adapters:
            with contextlib.suppress(Exception):
                await adapter.close()
        await self._stop_coinswitch()
        await self.client.aclose()

    def metrics(self) -> dict[str, object]:
        return {
            "adapters": self._metrics["adapters"],
            "retention": {
                **self._metrics["retention"],
                "status": self.history_store.retention_status,
            },
            "telegram": {
                **self._metrics["telegram"],
                "notifier": self.telegram_notifier.status().get("metrics", {}),
            },
        }

    async def _run_adapter(self, adapter: ExchangeAdapter) -> None:
        while True:
            started_at = datetime.now(timezone.utc)
            try:
                snapshots = await adapter.fetch_snapshots()
                await self.store.update_exchange(adapter.exchange, adapter.display_name, snapshots)
                all_snapshots = await self.store.get_snapshots()
                opportunities = build_opportunities(all_snapshots, self.settings, self.ranking_context)
                self.ranking_context.spreads.record(opportunities)  # type: ignore[union-attr]
                await self._save_history_if_due(all_snapshots, opportunities)
                self._signal_data_changed()
                await self._prune_if_due()
                await self._verify_daily_retention_cleanup()
                await self.telegram_notifier.notify(opportunities)
                await self.telegram_notifier.notify_captures(opportunities)
                if await self._daily_summary_ready():
                    await self.telegram_notifier.notify_daily_summary(all_snapshots, opportunities)
                duration_ms = (datetime.now(timezone.utc) - started_at).total_seconds() * 1000
                self._metrics["adapters"][adapter.exchange] = {
                    "runs": int(self._metrics["adapters"].get(adapter.exchange, {}).get("runs", 0)) + 1,
                    "failures": int(self._metrics["adapters"].get(adapter.exchange, {}).get("failures", 0)),
                    "last_success_at": datetime.now(timezone.utc).isoformat(),
                    "last_error_at": self._metrics["adapters"].get(adapter.exchange, {}).get("last_error_at"),
                    "last_duration_ms": round(duration_ms, 2),
                    "last_snapshot_count": len(snapshots),
                    "last_opportunity_count": len(opportunities),
                }
                logger.info(
                    "Polled %s successfully: %s snapshots, %s opportunities, %.2fms",
                    adapter.exchange,
                    len(snapshots),
                    len(opportunities),
                    duration_ms,
                )
            except Exception as exc:  # pragma: no cover
                logger.exception("Polling failed for %s", adapter.exchange)
                await self.store.mark_error(adapter.exchange, adapter.display_name, str(exc))
                previous = self._metrics["adapters"].get(adapter.exchange, {})
                self._metrics["adapters"][adapter.exchange] = {
                    "runs": int(previous.get("runs", 0)),
                    "failures": int(previous.get("failures", 0)) + 1,
                    "last_success_at": previous.get("last_success_at"),
                    "last_error_at": datetime.now(timezone.utc).isoformat(),
                    "last_duration_ms": previous.get("last_duration_ms"),
                    "last_snapshot_count": previous.get("last_snapshot_count", 0),
                    "last_opportunity_count": previous.get("last_opportunity_count", 0),
                }
            await asyncio.sleep(self.settings.default_poll_interval_seconds)

    async def _run_telegram_bot(self) -> None:
        while True:
            try:
                snapshots = await self.store.get_snapshots()
                opportunities = build_opportunities(snapshots, self.settings, self.ranking_context)
                result = await self.telegram_notifier.process_updates(snapshots, opportunities)
                self._metrics["telegram"]["bot_polls"] = int(self._metrics["telegram"]["bot_polls"]) + 1
                self._metrics["telegram"]["last_processed_updates"] = int(result.get("processed", 0))
            except Exception as exc:  # pragma: no cover
                logger.exception("Telegram bot polling failed")
                self.telegram_notifier._last_error = str(exc)  # noqa: SLF001
                self._metrics["telegram"]["bot_poll_errors"] = int(self._metrics["telegram"]["bot_poll_errors"]) + 1
            await asyncio.sleep(self.settings.telegram_poll_interval_seconds)

    async def _prune_if_due(self) -> None:
        if not self.history_store.retention_due(self.settings.retention_prune_interval_minutes):
            return

        stats = await self.history_store.prune_old_data(
            funding_snapshot_retention_hours=self.settings.funding_snapshot_retention_hours,
            opportunity_history_retention_days=self.settings.opportunity_history_retention_days,
            telegram_alert_state_retention_days=self.settings.telegram_alert_state_retention_days,
        )
        deleted_total = int(stats["funding_snapshots_deleted"]) + int(stats["opportunity_history_deleted"]) + int(stats["telegram_alert_state_deleted"])
        self._metrics["retention"]["runs"] = int(self._metrics["retention"]["runs"]) + 1
        self._metrics["retention"]["last_run_at"] = stats["ran_at"]
        self._metrics["retention"]["last_deleted_total"] = deleted_total
        logger.info(
            "Retention prune completed: %s snapshot rows, %s opportunity rows, %s alert-state rows deleted",
            stats["funding_snapshots_deleted"],
            stats["opportunity_history_deleted"],
            stats["telegram_alert_state_deleted"],
        )

    async def _verify_daily_retention_cleanup(self) -> None:
        now_utc = datetime.now(timezone.utc)
        local_now = now_utc.astimezone(self._retention_timezone)
        local_date = local_now.date().isoformat()

        if self._metrics["retention"].get("last_verification_local_date") == local_date:
            return

        storage_stats = await self.history_store.get_storage_stats()
        retention_status = self.history_store.retention_status
        last_prune_at = retention_status.get("ran_at")
        prune_ran_today = False
        if isinstance(last_prune_at, str) and last_prune_at:
            try:
                prune_ran_today = datetime.fromisoformat(last_prune_at).astimezone(self._retention_timezone).date().isoformat() == local_date
            except ValueError:
                prune_ran_today = False

        self._metrics["retention"]["last_verification_at"] = now_utc.isoformat()
        self._metrics["retention"]["last_verification_local_date"] = local_date
        self._metrics["retention"]["last_verification_ok"] = prune_ran_today

        log_message = (
            "Daily retention verification (%s): prune_ran_today=%s, "
            "db_size_bytes=%s, funding_snapshot_rows=%s, opportunity_history_rows=%s, "
            "telegram_alert_state_rows=%s, telegram_daily_summary_rows=%s, last_prune_at=%s"
        )
        log_args = (
            local_date,
            prune_ran_today,
            storage_stats["database_size_bytes"],
            storage_stats["funding_snapshot_rows"],
            storage_stats["opportunity_history_rows"],
            storage_stats["telegram_alert_state_rows"],
            storage_stats["telegram_daily_summary_rows"],
            last_prune_at,
        )
        if prune_ran_today:
            logger.info(log_message, *log_args)
        else:
            logger.warning(log_message, *log_args)

    async def _seed_statuses(self) -> None:
        status_definitions = [
            (
                "binance",
                self.settings.binance_enabled,
                True,
                None,
            ),
            (
                "delta",
                self.settings.delta_enabled,
                True,
                None,
            ),
            (
                "coindcx",
                self.settings.coindcx_enabled,
                True,
                None,
            ),
            (
                "coinswitch",
                self.settings.coinswitch_enabled,
                self.settings.coinswitch_configured,
                "CoinSwitch API key and secret are required." if self.settings.coinswitch_enabled and not self.settings.coinswitch_configured else None,
            ),
            (
                "wazirx",
                self.settings.wazirx_enabled,
                True,
                None,
            ),
        ]

        for exchange, enabled, configured, error_message in status_definitions:
            await self.store.set_status(
                ExchangeStatus(
                    exchange=exchange,
                    display_name=exchange_display_name(exchange),
                    enabled=enabled,
                    configured=configured if enabled else False,
                    healthy=False,
                    last_error=None if enabled and configured else error_message,
                    snapshot_count=0,
                )
            )

    async def _daily_summary_ready(self) -> bool:
        statuses = await self.store.get_statuses()
        expected = set(self.enabled_exchange_names())
        healthy = {
            status.exchange
            for status in statuses
            if status.exchange in expected and status.healthy and status.snapshot_count > 0
        }
        return expected.issubset(healthy)
