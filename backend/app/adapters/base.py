from __future__ import annotations

from abc import ABC, abstractmethod

from httpx import AsyncClient

from app.core.config import Settings
from app.models.market import ExchangeName, FundingSnapshot


class ExchangeAdapter(ABC):
    exchange: ExchangeName
    display_name: str

    def __init__(self, client: AsyncClient, settings: Settings | None = None) -> None:
        self.client = client
        self.settings = settings

    @abstractmethod
    async def fetch_snapshots(self) -> list[FundingSnapshot]:
        raise NotImplementedError

    async def close(self) -> None:
        """Stop any background work the adapter owns (streams, refresh tasks)."""
        return None
