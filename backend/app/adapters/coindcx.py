from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

from app.adapters.base import ExchangeAdapter
from app.models.market import FundingSnapshot
from app.services.symbols import canonicalize


class CoinDCXAdapter(ExchangeAdapter):
    exchange = "coindcx"
    display_name = "CoinDCX"
    _default_maker_fee_bps = 2.36
    _default_taker_fee_bps = 5.9
    _metadata_ttl = timedelta(hours=6)

    def __init__(self, client, settings=None) -> None:
        super().__init__(client, settings)
        self._instrument_pairs: set[str] = set()
        self._instrument_metadata: dict[str, dict] = {}
        self._instrument_metadata_updated_at: datetime | None = None
        self._metadata_lock = asyncio.Lock()

    @staticmethod
    def _extract_max_leverage(instrument: dict) -> float | None:
        candidate_values = (
            instrument.get("max_leverage"),
            instrument.get("maxLeverage"),
            instrument.get("maximum_leverage"),
            instrument.get("leverage"),
        )
        for value in candidate_values:
            if value in (None, ""):
                continue
            try:
                parsed = float(value)
            except (TypeError, ValueError):
                continue
            if parsed > 0:
                return parsed
        return None

    @staticmethod
    def _next_funding_boundary(reference_time_ms: int | None, interval_hours: int = 8) -> datetime | None:
        if not reference_time_ms:
            return None

        reference_time = datetime.fromtimestamp(reference_time_ms / 1000, tz=timezone.utc)
        aligned = reference_time.replace(minute=0, second=0, microsecond=0)
        resolved_interval = max(1, interval_hours)
        while aligned.hour % resolved_interval != 0 or aligned <= reference_time:
            aligned += timedelta(hours=1)
        return aligned

    async def _refresh_instrument_metadata_if_needed(self) -> None:
        now = datetime.now(timezone.utc)
        if self._instrument_metadata_updated_at and now - self._instrument_metadata_updated_at < self._metadata_ttl:
            return

        async with self._metadata_lock:
            if self._instrument_metadata_updated_at and now - self._instrument_metadata_updated_at < self._metadata_ttl:
                return

            active_pairs_response = await self.client.get(
                "https://api.coindcx.com/exchange/v1/derivatives/futures/data/active_instruments?margin_currency_short_name[]=USDT",
                headers={"User-Agent": "Mozilla/5.0 ArbRadar/1.0"},
                timeout=30.0,
            )
            active_pairs_response.raise_for_status()
            active_pairs = [pair for pair in active_pairs_response.json() if isinstance(pair, str)]

            semaphore = asyncio.Semaphore(20)

            async def fetch_instrument(pair: str) -> tuple[str, dict | None]:
                async with semaphore:
                    response = await self.client.get(
                        "https://api.coindcx.com/exchange/v1/derivatives/futures/data/instrument",
                        params={"pair": pair, "margin_currency_short_name": "USDT"},
                        headers={"User-Agent": "Mozilla/5.0 ArbRadar/1.0"},
                        timeout=30.0,
                    )
                    response.raise_for_status()
                    payload = response.json().get("instrument") or {}
                    return pair, payload if isinstance(payload, dict) else None

            results = await asyncio.gather(*(fetch_instrument(pair) for pair in active_pairs), return_exceptions=True)

            metadata: dict[str, dict] = {}
            for result in results:
                if isinstance(result, Exception):
                    continue
                pair, instrument = result
                if instrument and instrument.get("status") == "active" and instrument.get("kind") == "perpetual":
                    metadata[pair] = instrument

            self._instrument_pairs = set(active_pairs)
            self._instrument_metadata = metadata
            self._instrument_metadata_updated_at = datetime.now(timezone.utc)

    async def fetch_snapshots(self) -> list[FundingSnapshot]:
        await self._refresh_instrument_metadata_if_needed()

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
            if exchange_symbol not in self._instrument_pairs:
                continue

            instrument = self._instrument_metadata.get(exchange_symbol, {})
            market_symbol = item.get("mkt", "")
            if not market_symbol.endswith("USDT"):
                continue

            if feed_timestamp_ms and item.get("ctRT") and (feed_timestamp_ms - item["ctRT"]) > 15 * 60 * 1000:
                continue

            base_asset_hint = instrument.get("underlying_currency_short_name")
            quote_asset_hint = instrument.get("quote_currency_short_name")
            canonical_symbol, base_asset, quote_asset = canonicalize(
                market_symbol,
                base_asset=base_asset_hint,
                quote_asset=quote_asset_hint,
            )

            funding_interval_hours = int(instrument.get("funding_frequency") or 8)
            next_funding_reference_ms = item.get("bmST") or feed_timestamp_ms
            next_funding_time = self._next_funding_boundary(next_funding_reference_ms, funding_interval_hours)
            maker_fee_bps = float(instrument.get("maker_fee", self._default_maker_fee_bps / 100)) * 100
            taker_fee_bps = float(instrument.get("taker_fee", self._default_taker_fee_bps / 100)) * 100

            snapshots.append(
                FundingSnapshot(
                    exchange=self.exchange,
                    exchange_symbol=exchange_symbol,
                    canonical_symbol=canonical_symbol,
                    base_asset=base_asset,
                    quote_asset=quote_asset,
                    funding_rate=float(item["fr"]),
                    funding_interval_hours=funding_interval_hours,
                    max_leverage=self._extract_max_leverage(instrument),
                    mark_price=float(item["mp"]) if item.get("mp") is not None else None,
                    volume_24h=float(item["v"]) if item.get("v") is not None else None,
                    next_funding_time=next_funding_time,
                    maker_fee_bps=maker_fee_bps,
                    taker_fee_bps=taker_fee_bps,
                    metadata={
                        "source": "coindcx_current_prices",
                        "estimated_funding_rate": float(item.get("efr", item["fr"])),
                        "feed_timestamp_ms": feed_timestamp_ms,
                        "instrument_status": instrument.get("status"),
                        "margin_currency": instrument.get("margin_currency_short_name"),
                        "min_notional": instrument.get("min_notional"),
                        "unit_contract_value": instrument.get("unit_contract_value"),
                        "mark_send_timestamp_ms": item.get("bmST"),
                        "trade_send_timestamp_ms": item.get("btST"),
                    },
                )
            )

        return snapshots
