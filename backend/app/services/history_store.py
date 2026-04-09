from __future__ import annotations

import asyncio
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

from app.models.market import ArbitrageOpportunity, FundingSnapshot, FundingTrendPoint, FundingTrendSeries, OpportunityHistoryPoint


class HistoryStore:
    def __init__(self, database_path: Path) -> None:
        self.database_path = database_path
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = asyncio.Lock()
        self._last_retention_run_at: datetime | None = None
        self._last_retention_stats: dict[str, int | str | None] = {
            "funding_snapshots_deleted": 0,
            "opportunity_history_deleted": 0,
            "telegram_alert_state_deleted": 0,
            "ran_at": None,
        }
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path)
        connection.row_factory = sqlite3.Row
        return connection

    @property
    def retention_status(self) -> dict[str, int | str | None]:
        return dict(self._last_retention_stats)

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS funding_snapshots (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    exchange_name TEXT NOT NULL,
                    canonical_symbol TEXT NOT NULL,
                    exchange_symbol TEXT NOT NULL,
                    funding_rate REAL NOT NULL,
                    mark_price REAL,
                    open_interest_usd REAL,
                    volume_24h REAL,
                    fetched_at TEXT NOT NULL,
                    next_funding_time TEXT
                );

                CREATE TABLE IF NOT EXISTS opportunity_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    canonical_symbol TEXT NOT NULL,
                    net_apr_percent REAL NOT NULL,
                    gross_apr_percent REAL NOT NULL,
                    spread_rate REAL NOT NULL,
                    confidence_score REAL NOT NULL,
                    recorded_at TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_snapshots_symbol_time
                ON funding_snapshots (canonical_symbol, fetched_at DESC);

                CREATE INDEX IF NOT EXISTS idx_opportunities_symbol_time
                ON opportunity_history (canonical_symbol, recorded_at DESC);

                CREATE TABLE IF NOT EXISTS telegram_chat_settings (
                    chat_id TEXT PRIMARY KEY,
                    alerts_enabled INTEGER NOT NULL DEFAULT 1
                );

                CREATE TABLE IF NOT EXISTS telegram_watchlist (
                    chat_id TEXT NOT NULL,
                    canonical_symbol TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (chat_id, canonical_symbol)
                );

                CREATE INDEX IF NOT EXISTS idx_telegram_watchlist_chat
                ON telegram_watchlist (chat_id, canonical_symbol);

                CREATE TABLE IF NOT EXISTS telegram_symbol_alert_state (
                    canonical_symbol TEXT PRIMARY KEY,
                    state TEXT NOT NULL,
                    last_event_at TEXT NOT NULL,
                    last_entered_at TEXT,
                    last_exited_at TEXT,
                    last_spread_rate REAL,
                    last_confidence_score REAL,
                    last_combined_oi_usd REAL,
                    last_reason TEXT
                );

                CREATE TABLE IF NOT EXISTS telegram_daily_summary_state (
                    summary_key TEXT PRIMARY KEY,
                    last_sent_local_date TEXT NOT NULL,
                    last_sent_at TEXT NOT NULL
                );
                """
            )

    async def save_snapshots(self, snapshots: list[FundingSnapshot]) -> None:
        if not snapshots:
            return
        async with self._lock:
            await asyncio.to_thread(self._save_snapshots_sync, snapshots)

    def _save_snapshots_sync(self, snapshots: list[FundingSnapshot]) -> None:
        with self._connect() as connection:
            connection.executemany(
                """
                INSERT INTO funding_snapshots (
                    exchange_name,
                    canonical_symbol,
                    exchange_symbol,
                    funding_rate,
                    mark_price,
                    open_interest_usd,
                    volume_24h,
                    fetched_at,
                    next_funding_time
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        snapshot.exchange,
                        snapshot.canonical_symbol,
                        snapshot.exchange_symbol,
                        snapshot.funding_rate,
                        snapshot.mark_price,
                        snapshot.open_interest_usd,
                        snapshot.volume_24h,
                        snapshot.fetched_at.isoformat(),
                        snapshot.next_funding_time.isoformat() if snapshot.next_funding_time else None,
                    )
                    for snapshot in snapshots
                ],
            )
            connection.commit()

    async def save_opportunities(self, opportunities: list[ArbitrageOpportunity]) -> None:
        if not opportunities:
            return
        async with self._lock:
            await asyncio.to_thread(self._save_opportunities_sync, opportunities)

    def _save_opportunities_sync(self, opportunities: list[ArbitrageOpportunity]) -> None:
        with self._connect() as connection:
            for opportunity in opportunities:
                latest = connection.execute(
                    """
                    SELECT net_apr_percent, gross_apr_percent, spread_rate
                    FROM opportunity_history
                    WHERE canonical_symbol = ?
                    ORDER BY recorded_at DESC
                    LIMIT 1
                    """,
                    (opportunity.canonical_symbol,),
                ).fetchone()

                if latest and all(
                    abs(latest[column] - value) < 1e-9
                    for column, value in (
                        ("net_apr_percent", opportunity.net_apr_percent),
                        ("gross_apr_percent", opportunity.gross_apr_percent),
                        ("spread_rate", opportunity.spread_rate),
                    )
                ):
                    continue

                connection.execute(
                    """
                    INSERT INTO opportunity_history (
                        canonical_symbol,
                        net_apr_percent,
                        gross_apr_percent,
                        spread_rate,
                        confidence_score,
                        recorded_at
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        opportunity.canonical_symbol,
                        opportunity.net_apr_percent,
                        opportunity.gross_apr_percent,
                        opportunity.spread_rate,
                        opportunity.confidence_score,
                        opportunity.updated_at.isoformat(),
                    ),
                )
            connection.commit()

    async def get_opportunity_history(self, canonical_symbol: str, limit: int) -> list[OpportunityHistoryPoint]:
        async with self._lock:
            return await asyncio.to_thread(self._get_opportunity_history_sync, canonical_symbol, limit)

    def _get_opportunity_history_sync(self, canonical_symbol: str, limit: int) -> list[OpportunityHistoryPoint]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT canonical_symbol, net_apr_percent, gross_apr_percent, spread_rate, confidence_score, recorded_at
                FROM opportunity_history
                WHERE canonical_symbol = ?
                ORDER BY recorded_at DESC
                LIMIT ?
                """,
                (canonical_symbol, limit),
            ).fetchall()

        return [
            OpportunityHistoryPoint(
                recorded_at=row["recorded_at"],
                net_apr_percent=row["net_apr_percent"],
                gross_apr_percent=row["gross_apr_percent"],
                spread_rate=row["spread_rate"],
                confidence_score=row["confidence_score"],
            )
            for row in reversed(rows)
        ]

    async def get_alert_enabled_chat_ids(self, default_chat_ids: list[str]) -> list[str]:
        async with self._lock:
            return await asyncio.to_thread(self._get_alert_enabled_chat_ids_sync, default_chat_ids)

    def _get_alert_enabled_chat_ids_sync(self, default_chat_ids: list[str]) -> list[str]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT chat_id, alerts_enabled
                FROM telegram_chat_settings
                WHERE chat_id IN ({placeholders})
                """.format(placeholders=",".join("?" for _ in default_chat_ids) if default_chat_ids else "NULL"),
                default_chat_ids,
            ).fetchall() if default_chat_ids else []

        settings = {row["chat_id"]: bool(row["alerts_enabled"]) for row in rows}
        return [chat_id for chat_id in default_chat_ids if settings.get(chat_id, True)]

    async def set_alerts_enabled(self, chat_id: str, enabled: bool) -> None:
        async with self._lock:
            await asyncio.to_thread(self._set_alerts_enabled_sync, chat_id, enabled)

    def _set_alerts_enabled_sync(self, chat_id: str, enabled: bool) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO telegram_chat_settings (chat_id, alerts_enabled)
                VALUES (?, ?)
                ON CONFLICT(chat_id) DO UPDATE SET alerts_enabled = excluded.alerts_enabled
                """,
                (chat_id, 1 if enabled else 0),
            )
            connection.commit()

    async def get_alerts_enabled(self, chat_id: str, default: bool = True) -> bool:
        async with self._lock:
            return await asyncio.to_thread(self._get_alerts_enabled_sync, chat_id, default)

    def _get_alerts_enabled_sync(self, chat_id: str, default: bool) -> bool:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT alerts_enabled
                FROM telegram_chat_settings
                WHERE chat_id = ?
                """,
                (chat_id,),
            ).fetchone()
        return bool(row["alerts_enabled"]) if row else default

    async def add_watch_symbol(self, chat_id: str, canonical_symbol: str) -> None:
        async with self._lock:
            await asyncio.to_thread(self._add_watch_symbol_sync, chat_id, canonical_symbol)

    def _add_watch_symbol_sync(self, chat_id: str, canonical_symbol: str) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                INSERT OR IGNORE INTO telegram_watchlist (chat_id, canonical_symbol)
                VALUES (?, ?)
                """,
                (chat_id, canonical_symbol),
            )
            connection.commit()

    async def remove_watch_symbol(self, chat_id: str, canonical_symbol: str) -> None:
        async with self._lock:
            await asyncio.to_thread(self._remove_watch_symbol_sync, chat_id, canonical_symbol)

    def _remove_watch_symbol_sync(self, chat_id: str, canonical_symbol: str) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                DELETE FROM telegram_watchlist
                WHERE chat_id = ? AND canonical_symbol = ?
                """,
                (chat_id, canonical_symbol),
            )
            connection.commit()

    async def get_watch_symbols(self, chat_id: str) -> list[str]:
        async with self._lock:
            return await asyncio.to_thread(self._get_watch_symbols_sync, chat_id)

    def _get_watch_symbols_sync(self, chat_id: str) -> list[str]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT canonical_symbol
                FROM telegram_watchlist
                WHERE chat_id = ?
                ORDER BY canonical_symbol
                """,
                (chat_id,),
            ).fetchall()
        return [row["canonical_symbol"] for row in rows]

    async def get_daily_summary_state(self, summary_key: str = "default") -> dict[str, str] | None:
        async with self._lock:
            return await asyncio.to_thread(self._get_daily_summary_state_sync, summary_key)

    def _get_daily_summary_state_sync(self, summary_key: str) -> dict[str, str] | None:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT summary_key, last_sent_local_date, last_sent_at
                FROM telegram_daily_summary_state
                WHERE summary_key = ?
                """,
                (summary_key,),
            ).fetchone()
        if row is None:
            return None
        return {
            "summary_key": row["summary_key"],
            "last_sent_local_date": row["last_sent_local_date"],
            "last_sent_at": row["last_sent_at"],
        }

    async def mark_daily_summary_sent(
        self,
        local_date: str,
        sent_at: datetime | None = None,
        summary_key: str = "default",
    ) -> None:
        async with self._lock:
            await asyncio.to_thread(self._mark_daily_summary_sent_sync, summary_key, local_date, sent_at)

    def _mark_daily_summary_sent_sync(
        self,
        summary_key: str,
        local_date: str,
        sent_at: datetime | None,
    ) -> None:
        resolved_sent_at = (sent_at or datetime.now(timezone.utc)).isoformat()
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO telegram_daily_summary_state (summary_key, last_sent_local_date, last_sent_at)
                VALUES (?, ?, ?)
                ON CONFLICT(summary_key) DO UPDATE SET
                    last_sent_local_date = excluded.last_sent_local_date,
                    last_sent_at = excluded.last_sent_at
                """,
                (summary_key, local_date, resolved_sent_at),
            )
            connection.commit()

    async def prune_old_data(
        self,
        *,
        funding_snapshot_retention_hours: int,
        opportunity_history_retention_days: int,
        telegram_alert_state_retention_days: int,
    ) -> dict[str, int | str | None]:
        async with self._lock:
            return await asyncio.to_thread(
                self._prune_old_data_sync,
                funding_snapshot_retention_hours,
                opportunity_history_retention_days,
                telegram_alert_state_retention_days,
            )

    def _prune_old_data_sync(
        self,
        funding_snapshot_retention_hours: int,
        opportunity_history_retention_days: int,
        telegram_alert_state_retention_days: int,
    ) -> dict[str, int | str | None]:
        now = datetime.now(timezone.utc)
        snapshot_cutoff = (now - timedelta(hours=funding_snapshot_retention_hours)).isoformat()
        opportunity_cutoff = (now - timedelta(days=opportunity_history_retention_days)).isoformat()
        alert_state_cutoff = (now - timedelta(days=telegram_alert_state_retention_days)).isoformat()

        with self._connect() as connection:
            snapshot_deleted = connection.execute(
                """
                DELETE FROM funding_snapshots
                WHERE fetched_at < ?
                """,
                (snapshot_cutoff,),
            ).rowcount
            opportunity_deleted = connection.execute(
                """
                DELETE FROM opportunity_history
                WHERE recorded_at < ?
                """,
                (opportunity_cutoff,),
            ).rowcount
            alert_state_deleted = connection.execute(
                """
                DELETE FROM telegram_symbol_alert_state
                WHERE state = 'inactive' AND last_event_at < ?
                """,
                (alert_state_cutoff,),
            ).rowcount
            connection.commit()

        self._last_retention_run_at = now
        self._last_retention_stats = {
            "funding_snapshots_deleted": int(snapshot_deleted or 0),
            "opportunity_history_deleted": int(opportunity_deleted or 0),
            "telegram_alert_state_deleted": int(alert_state_deleted or 0),
            "ran_at": now.isoformat(),
        }
        return dict(self._last_retention_stats)

    def retention_due(self, interval_minutes: int) -> bool:
        if self._last_retention_run_at is None:
            return True
        return datetime.now(timezone.utc) - self._last_retention_run_at >= timedelta(minutes=interval_minutes)

    async def get_funding_trends(
        self,
        symbols: list[str],
        exchanges: list[str],
        limit: int,
    ) -> list[FundingTrendSeries]:
        async with self._lock:
            return await asyncio.to_thread(self._get_funding_trends_sync, symbols, exchanges, limit)

    def _get_funding_trends_sync(
        self,
        symbols: list[str],
        exchanges: list[str],
        limit: int,
    ) -> list[FundingTrendSeries]:
        if not symbols or not exchanges:
            return []

        with self._connect() as connection:
            rows = connection.execute(
                f"""
                SELECT exchange_name, canonical_symbol, funding_rate, fetched_at
                FROM funding_snapshots
                WHERE canonical_symbol IN ({",".join("?" for _ in symbols)})
                  AND exchange_name IN ({",".join("?" for _ in exchanges)})
                ORDER BY fetched_at DESC
                """,
                [*symbols, *exchanges],
            ).fetchall()

        grouped: dict[tuple[str, str], list[FundingTrendPoint]] = {}
        for row in rows:
            key = (row["canonical_symbol"], row["exchange_name"])
            points = grouped.setdefault(key, [])
            if len(points) >= limit:
                continue
            points.append(
                FundingTrendPoint(
                    recorded_at=row["fetched_at"],
                    funding_rate=row["funding_rate"],
                )
            )

        return [
            FundingTrendSeries(
                canonical_symbol=canonical_symbol,
                exchange=exchange_name,
                points=list(reversed(points)),
            )
            for (canonical_symbol, exchange_name), points in grouped.items()
        ]

    async def get_symbol_alert_states(self) -> dict[str, dict[str, str | float | None]]:
        async with self._lock:
            return await asyncio.to_thread(self._get_symbol_alert_states_sync)

    def _get_symbol_alert_states_sync(self) -> dict[str, dict[str, str | float | None]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT canonical_symbol, state, last_event_at, last_entered_at, last_exited_at,
                       last_spread_rate, last_confidence_score, last_combined_oi_usd, last_reason
                FROM telegram_symbol_alert_state
                """
            ).fetchall()

        return {
            row["canonical_symbol"]: {
                "state": row["state"],
                "last_event_at": row["last_event_at"],
                "last_entered_at": row["last_entered_at"],
                "last_exited_at": row["last_exited_at"],
                "last_spread_rate": row["last_spread_rate"],
                "last_confidence_score": row["last_confidence_score"],
                "last_combined_oi_usd": row["last_combined_oi_usd"],
                "last_reason": row["last_reason"],
            }
            for row in rows
        }

    async def mark_symbol_alert_entered(self, opportunity: ArbitrageOpportunity) -> None:
        async with self._lock:
            await asyncio.to_thread(self._mark_symbol_alert_entered_sync, opportunity)

    def _mark_symbol_alert_entered_sync(self, opportunity: ArbitrageOpportunity) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO telegram_symbol_alert_state (
                    canonical_symbol,
                    state,
                    last_event_at,
                    last_entered_at,
                    last_spread_rate,
                    last_confidence_score,
                    last_combined_oi_usd,
                    last_reason
                ) VALUES (?, 'active', ?, ?, ?, ?, ?, ?)
                ON CONFLICT(canonical_symbol) DO UPDATE SET
                    state = 'active',
                    last_event_at = excluded.last_event_at,
                    last_entered_at = excluded.last_entered_at,
                    last_spread_rate = excluded.last_spread_rate,
                    last_confidence_score = excluded.last_confidence_score,
                    last_combined_oi_usd = excluded.last_combined_oi_usd,
                    last_reason = excluded.last_reason
                """,
                (
                    opportunity.canonical_symbol,
                    opportunity.updated_at.isoformat(),
                    opportunity.updated_at.isoformat(),
                    opportunity.spread_rate,
                    opportunity.confidence_score,
                    opportunity.combined_open_interest_usd,
                    "entered",
                ),
            )
            connection.commit()

    async def mark_symbol_alert_exited(self, canonical_symbol: str, reason: str) -> None:
        async with self._lock:
            await asyncio.to_thread(self._mark_symbol_alert_exited_sync, canonical_symbol, reason)

    def _mark_symbol_alert_exited_sync(self, canonical_symbol: str, reason: str) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO telegram_symbol_alert_state (
                    canonical_symbol,
                    state,
                    last_event_at,
                    last_exited_at,
                    last_reason
                ) VALUES (?, 'inactive', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)
                ON CONFLICT(canonical_symbol) DO UPDATE SET
                    state = 'inactive',
                    last_event_at = CURRENT_TIMESTAMP,
                    last_exited_at = CURRENT_TIMESTAMP,
                    last_reason = excluded.last_reason
                """,
                (canonical_symbol, reason),
            )
            connection.commit()
