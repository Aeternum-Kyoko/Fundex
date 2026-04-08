from __future__ import annotations

import asyncio
from collections import defaultdict
from datetime import datetime, timezone

from app.models.market import ExchangeName, ExchangeStatus, FundingSnapshot


class MarketStore:
    def __init__(self) -> None:
        self._snapshots: dict[ExchangeName, dict[str, FundingSnapshot]] = defaultdict(dict)
        self._statuses: dict[ExchangeName, ExchangeStatus] = {}
        self._lock = asyncio.Lock()

    async def set_status(self, status: ExchangeStatus) -> None:
        async with self._lock:
            self._statuses[status.exchange] = status

    async def update_exchange(self, exchange: ExchangeName, display_name: str, snapshots: list[FundingSnapshot]) -> None:
        async with self._lock:
            self._snapshots[exchange] = {snapshot.canonical_symbol: snapshot for snapshot in snapshots}
            self._statuses[exchange] = ExchangeStatus(
                exchange=exchange,
                display_name=display_name,
                enabled=True,
                configured=True,
                healthy=True,
                last_success_at=datetime.now(timezone.utc),
                snapshot_count=len(snapshots),
                last_error=None,
            )

    async def mark_error(self, exchange: ExchangeName, display_name: str, error_message: str, *, configured: bool = True) -> None:
        async with self._lock:
            previous = self._statuses.get(exchange)
            self._statuses[exchange] = ExchangeStatus(
                exchange=exchange,
                display_name=display_name,
                enabled=True,
                configured=configured,
                healthy=False,
                last_success_at=previous.last_success_at if previous else None,
                snapshot_count=previous.snapshot_count if previous else 0,
                last_error=error_message,
            )

    async def get_snapshots(self, include_exchanges: set[ExchangeName] | None = None) -> list[FundingSnapshot]:
        async with self._lock:
            snapshots: list[FundingSnapshot] = []
            for exchange, exchange_snapshots in self._snapshots.items():
                if include_exchanges and exchange not in include_exchanges:
                    continue
                snapshots.extend(exchange_snapshots.values())
            return sorted(snapshots, key=lambda item: (item.canonical_symbol, item.exchange))

    async def get_statuses(self) -> list[ExchangeStatus]:
        async with self._lock:
            return sorted(self._statuses.values(), key=lambda item: item.exchange)
