from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from httpx import AsyncClient

from app.services.market_store import MarketStore

logger = logging.getLogger(__name__)


class SettledFundingResolver:
    """Finds the funding rate that actually settled, so results use reality instead of the prediction.

    Sources, best first:
      exchange_history      Binance fundingRate history, Delta FUNDING:<symbol> candles (exact).
      post_settlement_feed  CoinDCX's `fr` after the settlement rolls over (it then holds the settled rate).
      estimate              Venues without history (WazirX, CoinSwitch): the last prediction before settlement.
    """

    def __init__(self, client: AsyncClient, market_store: MarketStore) -> None:
        self.client = client
        self.market_store = market_store

    async def resolve(
        self,
        exchange: str,
        exchange_symbol: str,
        canonical_symbol: str,
        settles_at: datetime,
        predicted_rate: float,
    ) -> tuple[float, str]:
        try:
            if exchange == "binance":
                rate = await self._binance(exchange_symbol, settles_at)
                if rate is not None:
                    return rate, "exchange_history"
            elif exchange == "delta":
                rate = await self._delta(exchange_symbol, settles_at)
                if rate is not None:
                    return rate, "exchange_history"
            elif exchange == "coindcx":
                rate = await self._coindcx_post_settlement(canonical_symbol, settles_at)
                if rate is not None:
                    return rate, "post_settlement_feed"
        except Exception:
            logger.warning("Settled funding lookup failed for %s %s", exchange, exchange_symbol, exc_info=True)
        return predicted_rate, "estimate"

    async def _binance(self, symbol: str, settles_at: datetime) -> float | None:
        start = int((settles_at - timedelta(minutes=2)).timestamp() * 1000)
        end = int((settles_at + timedelta(minutes=10)).timestamp() * 1000)
        response = await self.client.get(
            "https://fapi.binance.com/fapi/v1/fundingRate",
            params={"symbol": symbol, "startTime": start, "endTime": end, "limit": 5},
            timeout=15.0,
        )
        response.raise_for_status()
        target = settles_at.timestamp() * 1000
        rows = [row for row in response.json() if abs(float(row["fundingTime"]) - target) <= 120_000]
        return float(rows[0]["fundingRate"]) if rows else None

    async def _delta(self, symbol: str, settles_at: datetime) -> float | None:
        start = int(settles_at.timestamp()) - 120
        response = await self.client.get(
            "https://api.india.delta.exchange/v2/history/candles",
            params={"resolution": "1m", "symbol": f"FUNDING:{symbol}", "start": start, "end": start + 240},
            timeout=15.0,
        )
        response.raise_for_status()
        candles = response.json().get("result") or []
        target = int(settles_at.timestamp())
        exact = [candle for candle in candles if abs(int(candle["time"]) - target) <= 60]
        if not exact:
            return None
        # Delta publishes funding in percent.
        return float(exact[0]["close"]) / 100

    async def _coindcx_post_settlement(self, canonical_symbol: str, settles_at: datetime) -> float | None:
        if datetime.now(timezone.utc) < settles_at + timedelta(seconds=45):
            return None
        snapshots = await self.market_store.get_snapshots({"coindcx"})  # type: ignore[arg-type]
        for snapshot in snapshots:
            if snapshot.canonical_symbol == canonical_symbol and snapshot.fetched_at > settles_at + timedelta(seconds=30):
                settled = snapshot.metadata.get("last_settled_funding_rate")
                return float(settled) if settled is not None else None
        return None
