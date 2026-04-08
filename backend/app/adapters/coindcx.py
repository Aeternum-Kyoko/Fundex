from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.adapters.base import ExchangeAdapter
from app.models.market import FundingSnapshot
from app.services.symbols import canonicalize


class CoinDCXAdapter(ExchangeAdapter):
    exchange = "coindcx"
    display_name = "CoinDCX"
    _maker_fee_bps = 2.5
    _taker_fee_bps = 7.4

    @staticmethod
    def _next_funding_boundary(reference_time_ms: int | None) -> datetime | None:
        if not reference_time_ms:
            return None

        reference_time = datetime.fromtimestamp(reference_time_ms / 1000, tz=timezone.utc)
        aligned = reference_time.replace(minute=0, second=0, microsecond=0)
        while aligned.hour % 8 != 0 or aligned <= reference_time:
            aligned += timedelta(hours=1)
        return aligned

    async def fetch_snapshots(self) -> list[FundingSnapshot]:
        response = await self.client.get(
            "https://public.coindcx.com/market_data/v3/current_prices/futures/rt",
            headers={"User-Agent": "Mozilla/5.0 ArbRadar/1.0"},
            timeout=30.0,
        )
        response.raise_for_status()
        payload = response.json()
        feed_timestamp_ms = payload.get("ts")

        snapshots: list[FundingSnapshot] = []
        for exchange_symbol, item in payload.get("prices", {}).items():
            market_symbol = item.get("mkt", "")
            if not market_symbol.endswith("USDT"):
                continue

            if feed_timestamp_ms and item.get("ctRT") and (feed_timestamp_ms - item["ctRT"]) > 15 * 60 * 1000:
                continue

            canonical_symbol, base_asset, quote_asset = canonicalize(market_symbol)
            next_funding_time = self._next_funding_boundary(feed_timestamp_ms)

            snapshots.append(
                FundingSnapshot(
                    exchange=self.exchange,
                    exchange_symbol=exchange_symbol,
                    canonical_symbol=canonical_symbol,
                    base_asset=base_asset,
                    quote_asset=quote_asset,
                    funding_rate=float(item["fr"]),
                    funding_interval_hours=8,
                    mark_price=float(item["mp"]) if item.get("mp") is not None else None,
                    volume_24h=float(item["v"]) if item.get("v") is not None else None,
                    next_funding_time=next_funding_time,
                    maker_fee_bps=self._maker_fee_bps,
                    taker_fee_bps=self._taker_fee_bps,
                    metadata={
                        "source": "coindcx_current_prices",
                        "estimated_funding_rate": float(item.get("efr", item["fr"])),
                        "feed_timestamp_ms": feed_timestamp_ms,
                    },
                )
            )

        return snapshots
