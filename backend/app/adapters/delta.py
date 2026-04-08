from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.adapters.base import ExchangeAdapter
from app.models.market import FundingSnapshot
from app.services.symbol_registry import normalize_exchange_symbol


class DeltaAdapter(ExchangeAdapter):
    exchange = "delta"
    display_name = "Delta Exchange India"
    _maker_fee_bps = 2.0
    _taker_fee_bps = 5.0

    @staticmethod
    def _parse_exchange_time(raw_time: str | None) -> datetime | None:
        if not raw_time:
            return None

        normalized = raw_time.replace("Z", "+00:00")
        if "." in normalized:
            prefix, suffix = normalized.split(".", 1)
            fraction, timezone_suffix = suffix.split("+", 1)
            normalized = f"{prefix}.{fraction[:6]}+{timezone_suffix}"
        return datetime.fromisoformat(normalized).astimezone(timezone.utc)

    @staticmethod
    def _next_funding_boundary(reference_time: datetime | None) -> datetime | None:
        if reference_time is None:
            return None

        aligned = reference_time.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)
        while aligned.hour % 8 != 0 or aligned <= reference_time:
            aligned += timedelta(hours=1)
        return aligned

    async def fetch_snapshots(self) -> list[FundingSnapshot]:
        response = await self.client.get(
            "https://api.india.delta.exchange/v2/tickers",
            params={"contract_types": "perpetual_futures"},
            timeout=30.0,
        )
        response.raise_for_status()
        payload = response.json()

        snapshots: list[FundingSnapshot] = []
        for item in payload.get("result", []):
            symbol = item.get("symbol", "")
            if not symbol:
                continue

            identity = normalize_exchange_symbol(
                self.exchange,
                symbol,
                base_asset_hint=item.get("underlying_asset_symbol"),
                quote_asset_hint=item.get("quoting_asset", {}).get("symbol"),
            )

            reference_time = datetime.now(timezone.utc)
            next_funding_time = self._next_funding_boundary(reference_time)

            snapshots.append(
                FundingSnapshot(
                    exchange=self.exchange,
                    exchange_symbol=symbol,
                    canonical_symbol=identity.canonical_symbol,
                    base_asset=identity.base_asset,
                    quote_asset=identity.quote_asset,
                    funding_rate=float(item["funding_rate"]) / 100,
                    funding_interval_hours=8,
                    mark_price=float(item["mark_price"]),
                    index_price=float(item["spot_price"]),
                    open_interest=float(item["oi"]) if item.get("oi") is not None else None,
                    open_interest_usd=float(item["oi_value_usd"]) if item.get("oi_value_usd") is not None else None,
                    volume_24h=float(item["turnover_usd"]) if item.get("turnover_usd") is not None else None,
                    next_funding_time=next_funding_time,
                    maker_fee_bps=self._maker_fee_bps,
                    taker_fee_bps=self._taker_fee_bps,
                    metadata={
                        "source": "delta_tickers",
                        "source_quote_asset": identity.source_quote_asset,
                        "exchange_time": self._parse_exchange_time(item.get("time")).isoformat()
                        if item.get("time")
                        else None,
                        "best_bid_size": float(item["quotes"]["bid_size"]) if item.get("quotes", {}).get("bid_size") else None,
                        "best_ask_size": float(item["quotes"]["ask_size"]) if item.get("quotes", {}).get("ask_size") else None,
                    },
                )
            )

        return snapshots
