from __future__ import annotations

import asyncio
import contextlib
import json
from datetime import datetime, timedelta, timezone

import websockets

from app.adapters.base import ExchangeAdapter
from app.models.market import FundingSnapshot
from app.services.symbol_registry import normalize_exchange_symbol


class DeltaAdapter(ExchangeAdapter):
    exchange = "delta"
    display_name = "Delta Exchange India"
    _ws_url = "wss://public-socket.india.delta.exchange"
    _metadata_ttl = timedelta(hours=6)

    def __init__(self, client, settings=None) -> None:
        super().__init__(client, settings)
        self._funding_cache: dict[str, dict[str, float | int | str | None]] = {}
        self._product_metadata: dict[str, dict[str, float | int | str | None]] = {}
        self._product_metadata_updated_at: datetime | None = None
        self._funding_task: asyncio.Task[None] | None = None
        self._funding_symbols: set[str] = set()
        self._funding_lock = asyncio.Lock()
        self._metadata_lock = asyncio.Lock()

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
    def _next_funding_boundary(reference_time: datetime | None, interval_hours: int = 8) -> datetime | None:
        if reference_time is None:
            return None

        aligned = reference_time.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)
        resolved_interval = max(1, interval_hours)
        while aligned.hour % resolved_interval != 0 or aligned <= reference_time:
            aligned += timedelta(hours=1)
        return aligned

    @staticmethod
    def _parse_next_funding_realization(raw_value: int | float | str | None) -> datetime | None:
        if raw_value in (None, ""):
            return None
        try:
            timestamp = int(raw_value)
        except (TypeError, ValueError):
            return None

        if timestamp > 10_000_000_000_000:
            timestamp_seconds = timestamp / 1_000_000
        elif timestamp > 10_000_000_000:
            timestamp_seconds = timestamp / 1_000
        else:
            timestamp_seconds = float(timestamp)
        return datetime.fromtimestamp(timestamp_seconds, tz=timezone.utc)

    @staticmethod
    def _build_product_metadata(product: dict) -> dict[str, float | int | str | None]:
        product_specs = product.get("product_specs") or {}
        interval_seconds = product_specs.get("rate_exchange_interval")
        try:
            funding_interval_seconds = int(interval_seconds) if interval_seconds is not None else 28_800
        except (TypeError, ValueError):
            funding_interval_seconds = 28_800

        maker_fee_raw = product.get("maker_commission_rate")
        taker_fee_raw = product.get("taker_commission_rate")
        try:
            maker_fee_bps = float(maker_fee_raw) * 10_000 if maker_fee_raw is not None else 2.0
        except (TypeError, ValueError):
            maker_fee_bps = 2.0
        try:
            taker_fee_bps = float(taker_fee_raw) * 10_000 if taker_fee_raw is not None else 5.0
        except (TypeError, ValueError):
            taker_fee_bps = 5.0

        return {
            "funding_interval_seconds": funding_interval_seconds,
            "maker_fee_bps": maker_fee_bps,
            "taker_fee_bps": taker_fee_bps,
            "funding_method": product.get("funding_method"),
            "annualized_funding": product.get("annualized_funding"),
        }

    async def _refresh_product_metadata_if_needed(self) -> None:
        now = datetime.now(timezone.utc)
        if self._product_metadata_updated_at and now - self._product_metadata_updated_at < self._metadata_ttl:
            return

        async with self._metadata_lock:
            if self._product_metadata_updated_at and now - self._product_metadata_updated_at < self._metadata_ttl:
                return

            response = await self.client.get(
                "https://api.india.delta.exchange/v2/products",
                params={"contract_types": "perpetual_futures"},
                timeout=30.0,
            )
            response.raise_for_status()
            payload = response.json()

            metadata: dict[str, dict[str, float | int | str | None]] = {}
            for item in payload.get("result", []):
                symbol = item.get("symbol")
                if not symbol:
                    continue
                metadata[symbol] = self._build_product_metadata(item)

            self._product_metadata = metadata
            self._product_metadata_updated_at = datetime.now(timezone.utc)

    async def _ensure_funding_stream(self, symbols: set[str]) -> None:
        if not symbols:
            return

        async with self._funding_lock:
            if symbols == self._funding_symbols and self._funding_task and not self._funding_task.done():
                return

            self._funding_symbols = set(symbols)
            if self._funding_task and not self._funding_task.done():
                self._funding_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await self._funding_task

            self._funding_task = asyncio.create_task(self._run_funding_stream(), name="delta-funding-rate-stream")

    async def _run_funding_stream(self) -> None:
        while True:
            try:
                async with websockets.connect(self._ws_url, ping_interval=20, ping_timeout=20) as websocket:
                    subscribe_payload = {
                        "type": "subscribe",
                        "payload": {
                            "channels": [
                                {
                                    "name": "funding_rate",
                                    "symbols": sorted(self._funding_symbols),
                                }
                            ]
                        },
                    }
                    await websocket.send(json.dumps(subscribe_payload))

                    async for raw_message in websocket:
                        payload = json.loads(raw_message)
                        if payload.get("type") != "funding_rate":
                            continue

                        symbol = payload.get("sy")
                        if not symbol:
                            continue

                        self._funding_cache[symbol] = {
                            "funding_rate_percent": payload.get("fr"),
                            "funding_interval_seconds": payload.get("fi"),
                            "next_funding_realization": payload.get("nfr"),
                            "timestamp": payload.get("ts"),
                        }
            except asyncio.CancelledError:
                raise
            except Exception:
                await asyncio.sleep(3)

    async def fetch_snapshots(self) -> list[FundingSnapshot]:
        await self._refresh_product_metadata_if_needed()

        response = await self.client.get(
            "https://api.india.delta.exchange/v2/tickers",
            params={"contract_types": "perpetual_futures"},
            timeout=30.0,
        )
        response.raise_for_status()
        payload = response.json()
        available_symbols = {item.get("symbol", "") for item in payload.get("result", []) if item.get("symbol")}
        await self._ensure_funding_stream(available_symbols)

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

            product_metadata = self._product_metadata.get(symbol, {})
            funding_metadata = self._funding_cache.get(symbol, {})
            funding_interval_seconds = funding_metadata.get("funding_interval_seconds") or product_metadata.get("funding_interval_seconds")
            funding_interval_hours = (
                max(1, int(funding_interval_seconds) // 3600)
                if isinstance(funding_interval_seconds, (int, float))
                else 8
            )
            next_funding_time = self._parse_next_funding_realization(funding_metadata.get("next_funding_realization"))
            if next_funding_time is None:
                reference_time = datetime.now(timezone.utc)
                next_funding_time = self._next_funding_boundary(reference_time, funding_interval_hours)

            funding_rate = (
                float(funding_metadata["funding_rate_percent"]) / 100
                if funding_metadata.get("funding_rate_percent") is not None
                else float(item["funding_rate"]) / 100
            )

            snapshots.append(
                FundingSnapshot(
                    exchange=self.exchange,
                    exchange_symbol=symbol,
                    canonical_symbol=identity.canonical_symbol,
                    base_asset=identity.base_asset,
                    quote_asset=identity.quote_asset,
                    funding_rate=funding_rate,
                    funding_interval_hours=funding_interval_hours,
                    mark_price=float(item["mark_price"]),
                    index_price=float(item["spot_price"]),
                    open_interest=float(item["oi"]) if item.get("oi") is not None else None,
                    open_interest_usd=float(item["oi_value_usd"]) if item.get("oi_value_usd") is not None else None,
                    volume_24h=float(item["turnover_usd"]) if item.get("turnover_usd") is not None else None,
                    next_funding_time=next_funding_time,
                    maker_fee_bps=float(product_metadata.get("maker_fee_bps", 2.0)),
                    taker_fee_bps=float(product_metadata.get("taker_fee_bps", 5.0)),
                    metadata={
                        "source": "delta_tickers",
                        "source_quote_asset": identity.source_quote_asset,
                        "exchange_time": self._parse_exchange_time(item.get("time")).isoformat()
                        if item.get("time")
                        else None,
                        "next_funding_realization": next_funding_time.isoformat() if next_funding_time else None,
                        "funding_interval_seconds": funding_interval_seconds,
                        "funding_method": product_metadata.get("funding_method"),
                        "annualized_funding": product_metadata.get("annualized_funding"),
                        "best_bid_size": float(item["quotes"]["bid_size"]) if item.get("quotes", {}).get("bid_size") else None,
                        "best_ask_size": float(item["quotes"]["ask_size"]) if item.get("quotes", {}).get("ask_size") else None,
                    },
                )
            )

        return snapshots
