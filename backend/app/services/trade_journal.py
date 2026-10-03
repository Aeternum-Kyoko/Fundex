from __future__ import annotations

import asyncio
import json
import sqlite3
from pathlib import Path

from app.models.trade import TradeSessionResponse

FINAL_STATUSES = {"completed", "failed", "cancelled"}


class TradeJournal:
    """Every paper and live trade, persisted so results survive restarts and can be analysed."""

    def __init__(self, database_path: Path) -> None:
        self.database_path = database_path
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(self.database_path) as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS trade_journal (
                    id TEXT PRIMARY KEY,
                    mode TEXT NOT NULL,
                    canonical_symbol TEXT NOT NULL,
                    status TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    payload TEXT NOT NULL
                )
                """
            )
            connection.execute("CREATE INDEX IF NOT EXISTS idx_trade_journal_created ON trade_journal (created_at DESC)")

    async def save(self, session: TradeSessionResponse) -> None:
        payload = session.model_dump_json()
        await asyncio.to_thread(self._save_sync, session, payload)

    def _save_sync(self, session: TradeSessionResponse, payload: str) -> None:
        with sqlite3.connect(self.database_path) as connection:
            connection.execute(
                """
                INSERT INTO trade_journal (id, mode, canonical_symbol, status, created_at, updated_at, payload)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, payload = excluded.payload
                """,
                (
                    session.id,
                    session.mode,
                    session.canonical_symbol,
                    session.status,
                    session.created_at.isoformat(),
                    session.updated_at.isoformat(),
                    payload,
                ),
            )

    async def list(self, limit: int = 500, mode: str | None = None) -> list[TradeSessionResponse]:
        return await asyncio.to_thread(self._list_sync, limit, mode)

    def _list_sync(self, limit: int, mode: str | None) -> list[TradeSessionResponse]:
        query = "SELECT payload FROM trade_journal"
        params: tuple = ()
        if mode:
            query += " WHERE mode = ?"
            params = (mode,)
        query += " ORDER BY created_at DESC LIMIT ?"
        with sqlite3.connect(self.database_path) as connection:
            rows = connection.execute(query, (*params, limit)).fetchall()
        return [TradeSessionResponse.model_validate_json(row[0]) for row in rows]

    async def get(self, session_id: str) -> TradeSessionResponse | None:
        return await asyncio.to_thread(self._get_sync, session_id)

    def _get_sync(self, session_id: str) -> TradeSessionResponse | None:
        with sqlite3.connect(self.database_path) as connection:
            row = connection.execute("SELECT payload FROM trade_journal WHERE id = ?", (session_id,)).fetchone()
        return TradeSessionResponse.model_validate_json(row[0]) if row else None

    async def interrupted(self) -> list[TradeSessionResponse]:
        """Sessions that were still running when the server stopped."""
        sessions = await self.list(limit=200)
        return [session for session in sessions if session.status not in FINAL_STATUSES]
