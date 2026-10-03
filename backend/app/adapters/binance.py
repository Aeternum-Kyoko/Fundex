from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from app.adapters.base import ExchangeAdapter
from app.models.market import FundingSnapshot
from app.services.symbol_registry import normalize_exchange_symbol

logger = logging.getLogger(__name__)


class BinanceAdapter(ExchangeAdapter):
    exchange = "binance"
    display_name = "Binance"
    _maker_fee_bps = 2.0
    _taker_fee_bps = 5.0
    # Binance only lists symbols whose interval differs from the 8h default in fundingInfo.
    _default_funding_interval_hours = 8
    _funding_info_ttl = timedelta(hours=1)

    def __init__(self, client, settings=None) -> None:
        super().__init__(client, settings)
        self._funding_intervals: dict[str, int] = {}
        self._funding_info_updated_at: datetime | None = None
        self._quote_volumes: dict[str, float] = {}
        self._volumes_updated_at: datetime | None = None
        # Only contracts Binance lists as TRADING; SETTLING ones are delisted but still appear in premiumIndex.
        self._trading_symbols: set[str] | None = None
        self._symbols_updated_at: datetime | None = None

    async def _refresh_trading_symbols_if_needed(self) -> None:
        now = datetime.now(timezone.utc)
        if self._symbols_updated_at and now - self._symbols_updated_at < timedelta(hours=1):
            return
        try:
            response = await self.client.get("https://fapi.binance.com/fapi/v1/exchangeInfo", timeout=30.0)
            response.raise_for_status()
            self._trading_symbols = self.parse_trading_symbols(response.json())
            self._symbols_updated_at = now
        except Exception:
            logger.warning("Binance exchangeInfo refresh failed; keeping the previous tradable list", exc_info=True)

    @staticmethod
    def parse_trading_symbols(payload: dict) -> set[str]:
        return {
            item["symbol"]
            for item in payload.get("symbols", [])
            if item.get("status") == "TRADING" and item.get("contractType") == "PERPETUAL"
        }

    async def _refresh_volumes_if_needed(self) -> None:
        now = datetime.now(timezone.utc)
        if self._volumes_updated_at and now - self._volumes_updated_at < timedelta(minutes=5):
            return
        try:
            response = await self.client.get("https://fapi.binance.com/fapi/v1/ticker/24hr", timeout=30.0)
            response.raise_for_status()
            self._quote_volumes = {
                item["symbol"]: float(item["quoteVolume"]) for item in response.json() if item.get("symbol") and item.get("quoteVolume")
            }
            self._volumes_updated_at = now
        except Exception:
            logger.warning("Binance 24h volume refresh failed; keeping previous values", exc_info=True)

    async def _refresh_funding_intervals_if_needed(self) -> None:
        now = datetime.now(timezone.utc)
        if self._funding_info_updated_at and now - self._funding_info_updated_at < self._funding_info_ttl:
            return
        response = await self.client.get("https://fapi.binance.com/fapi/v1/fundingInfo", timeout=30.0)
        response.raise_for_status()
        self._funding_intervals = self.parse_funding_info(response.json())
        self._funding_info_updated_at = now

    @staticmethod
    def parse_funding_info(payload: list[dict]) -> dict[str, int]:
        intervals: dict[str, int] = {}
        for item in payload:
            symbol = item.get("symbol")
            hours = item.get("fundingIntervalHours")
            if symbol and isinstance(hours, (int, float)) and hours > 0:
                intervals[symbol] = int(hours)
        return intervals

    @staticmethod
    def _extract_max_leverage(item: dict) -> float | None:
        raw_value = item.get("maxLeverage") or item.get("max_leverage")
        if raw_value in (None, ""):
            return None
        try:
            return float(raw_value)
        except (TypeError, ValueError):
            return None

    async def fetch_snapshots(self) -> list[FundingSnapshot]:
        try:
            await self._refresh_funding_intervals_if_needed()
        except Exception:
            if self._funding_info_updated_at is None:
                # Without the interval table every 4h/1h symbol would be mislabelled as 8h, so fail the poll.
                raise
            logger.warning("Binance fundingInfo refresh failed; using cached intervals", exc_info=True)

        await self._refresh_volumes_if_needed()
        await self._refresh_trading_symbols_if_needed()
        response = await self.client.get("https://fapi.binance.com/fapi/v1/premiumIndex", timeout=30.0)
        response.raise_for_status()
        payload = response.json()

        snapshots: list[FundingSnapshot] = []
        for item in payload:
            symbol = item.get("symbol", "")
            if not symbol.endswith("USDT"):
                continue
            if self._trading_symbols is not None and symbol not in self._trading_symbols:
                continue

            identity = normalize_exchange_symbol(self.exchange, symbol)
            next_funding_ms = item.get("nextFundingTime")
            next_funding_time = None
            if next_funding_ms:
                next_funding_time = datetime.fromtimestamp(next_funding_ms / 1000, tz=timezone.utc)

            snapshots.append(
                FundingSnapshot(
                    exchange=self.exchange,
                    exchange_symbol=symbol,
                    canonical_symbol=identity.canonical_symbol,
                    base_asset=identity.base_asset,
                    quote_asset=identity.quote_asset,
                    funding_rate=float(item["lastFundingRate"]),
                    funding_interval_hours=self._funding_intervals.get(symbol, self._default_funding_interval_hours),
                    max_leverage=self._extract_max_leverage(item),
                    volume_24h=self._quote_volumes.get(symbol),
                    mark_price=float(item["markPrice"]),
                    index_price=float(item["indexPrice"]),
                    next_funding_time=next_funding_time,
                    maker_fee_bps=self._maker_fee_bps,
                    taker_fee_bps=self._taker_fee_bps,
                    metadata={
                        "source": "premiumIndex",
                        "source_quote_asset": identity.source_quote_asset,
                    },
                )
            )

        return snapshots
