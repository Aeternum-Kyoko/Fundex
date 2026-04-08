from __future__ import annotations

from datetime import datetime, timezone

from app.adapters.base import ExchangeAdapter
from app.models.market import FundingSnapshot
from app.services.symbols import canonicalize


class BinanceAdapter(ExchangeAdapter):
    exchange = "binance"
    display_name = "Binance"
    _maker_fee_bps = 2.0
    _taker_fee_bps = 5.0

    async def fetch_snapshots(self) -> list[FundingSnapshot]:
        response = await self.client.get("https://fapi.binance.com/fapi/v1/premiumIndex", timeout=30.0)
        response.raise_for_status()
        payload = response.json()

        snapshots: list[FundingSnapshot] = []
        for item in payload:
            symbol = item.get("symbol", "")
            if not symbol.endswith("USDT"):
                continue

            canonical_symbol, base_asset, quote_asset = canonicalize(symbol)
            next_funding_ms = item.get("nextFundingTime")
            next_funding_time = None
            if next_funding_ms:
                next_funding_time = datetime.fromtimestamp(next_funding_ms / 1000, tz=timezone.utc)

            snapshots.append(
                FundingSnapshot(
                    exchange=self.exchange,
                    exchange_symbol=symbol,
                    canonical_symbol=canonical_symbol,
                    base_asset=base_asset,
                    quote_asset=quote_asset,
                    funding_rate=float(item["lastFundingRate"]),
                    funding_interval_hours=8,
                    mark_price=float(item["markPrice"]),
                    index_price=float(item["indexPrice"]),
                    next_funding_time=next_funding_time,
                    maker_fee_bps=self._maker_fee_bps,
                    taker_fee_bps=self._taker_fee_bps,
                    metadata={"source": "premiumIndex"},
                )
            )

        return snapshots
