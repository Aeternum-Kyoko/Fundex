from __future__ import annotations

import asyncio
import sqlite3
from pathlib import Path

from app.models.market import ArbitrageOpportunity, FundingSnapshot, OpportunityHistoryPoint


class HistoryStore:
    def __init__(self, database_path: Path) -> None:
        self.database_path = database_path
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = asyncio.Lock()
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path)
        connection.row_factory = sqlite3.Row
        return connection

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
