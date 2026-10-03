from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from app.adapters.base import ExchangeAdapter
from app.models.market import FundingSnapshot
from app.services.symbol_registry import normalize_exchange_symbol

logger = logging.getLogger(__name__)


class WazirXAdapter(ExchangeAdapter):
    exchange = "wazirx"
    display_name = "WazirX"
    _base_url = "https://api.wazirx.com"
    # 0.02% maker / 0.04% taker, plus 18% GST (same treatment as CoinDCX).
    _maker_fee_bps = 2.36
    _taker_fee_bps = 4.72
    # WazirX publishes no interval field. Verified 2026-10-02 16:00 UTC: 194 of 280 USDT perps settle every 4h
    # and 86 every 8h, matching Binance's fundingInfo symbol-for-symbol. 8h is only the last-resort assumption.
    _default_funding_interval_hours = 8
    _valid_intervals = (1, 2, 4, 8)
    _reference_ttl = timedelta(hours=6)
    # Observed 2026-10-02 15:54-16:26 UTC: lastFundingRate is republished in batches every 15 minutes
    # (15:55, 16:10, 16:25 for ~92 of 280 symbols), while Binance's predicted rate moves every few seconds.
    _rate_refresh_seconds = 900
    _metadata_ttl = timedelta(hours=6)

    def __init__(self, client, settings=None) -> None:
        super().__init__(client, settings)
        self._instrument_metadata: dict[str, dict] = {}
        self._instrument_metadata_updated_at: datetime | None = None
        self._metadata_lock = asyncio.Lock()
        self._last_rates: dict[str, tuple[float, datetime]] = {}
        self._last_next_funding: dict[str, datetime] = {}
        self._observed_intervals: dict[str, int] = {}
        self._reference_intervals: dict[str, int] = {}
        self._reference_updated_at: datetime | None = None

    @staticmethod
    def _to_float(value) -> float | None:
        if value in (None, ""):
            return None
        try:
            return float(value)
        except (TypeError, ValueError):
            return None

    async def _refresh_instrument_metadata_if_needed(self) -> None:
        now = datetime.now(timezone.utc)
        if self._instrument_metadata_updated_at and now - self._instrument_metadata_updated_at < self._metadata_ttl:
            return

        async with self._metadata_lock:
            if self._instrument_metadata_updated_at and now - self._instrument_metadata_updated_at < self._metadata_ttl:
                return

            response = await self.client.get(f"{self._base_url}/fapi/v1/exchangeInfo", timeout=30.0)
            response.raise_for_status()
            symbols = response.json().get("symbols", [])

            self._instrument_metadata = {
                item["symbol"]: item
                for item in symbols
                if item.get("symbol") and item.get("contractType") == "PERPETUAL"
            }
            self._instrument_metadata_updated_at = datetime.now(timezone.utc)

    async def fetch_snapshots(self) -> list[FundingSnapshot]:
        try:
            await self._refresh_instrument_metadata_if_needed()
        except Exception:
            # Metadata only adds leverage/contract details; keep polling funding without it.
            logger.warning("WazirX exchangeInfo refresh failed; using cached metadata", exc_info=True)

        response = await self.client.get(f"{self._base_url}/fapi/v1/premiumIndex", timeout=30.0)
        response.raise_for_status()
        snapshots = self.parse_premium_index(response.json(), self._instrument_metadata)
        now = datetime.now(timezone.utc)
        await self._refresh_reference_intervals_if_needed(now)
        self._resolve_intervals(snapshots)
        self._track_rate_changes(snapshots, now)
        return snapshots

    async def _refresh_reference_intervals_if_needed(self, now: datetime) -> None:
        if self._reference_updated_at and now - self._reference_updated_at < self._reference_ttl:
            return
        try:
            response = await self.client.get("https://fapi.binance.com/fapi/v1/fundingInfo", timeout=30.0)
            response.raise_for_status()
            self._reference_intervals = {
                item["symbol"]: int(item["fundingIntervalHours"])
                for item in response.json()
                if item.get("symbol") and isinstance(item.get("fundingIntervalHours"), (int, float))
            }
            self._reference_updated_at = now
        except Exception:
            logger.warning("Reference funding intervals unavailable; WazirX intervals fall back to observation", exc_info=True)

    def _resolve_intervals(self, snapshots: list[FundingSnapshot]) -> None:
        for snapshot in snapshots:
            symbol = snapshot.exchange_symbol
            next_funding = snapshot.next_funding_time
            previous = self._last_next_funding.get(symbol)
            if next_funding is not None:
                if previous is not None and next_funding > previous:
                    # The schedule rolled past a settlement: the step is the exact interval.
                    step_hours = round((next_funding - previous).total_seconds() / 3600)
                    if step_hours in self._valid_intervals:
                        self._observed_intervals[symbol] = step_hours
                self._last_next_funding[symbol] = next_funding

            if symbol in self._observed_intervals:
                interval, source = self._observed_intervals[symbol], "observed"
            elif symbol in self._reference_intervals:
                interval, source = self._reference_intervals[symbol], "binance_reference"
            else:
                interval, source = self._default_funding_interval_hours, "assumed"
            snapshot.funding_interval_hours = interval
            snapshot.metadata["interval_source"] = source

    def _track_rate_changes(self, snapshots: list[FundingSnapshot], now: datetime) -> None:
        # The payload timestamps are response times, so record when each rate actually last moved.
        for snapshot in snapshots:
            previous = self._last_rates.get(snapshot.exchange_symbol)
            changed_at = previous[1] if previous and previous[0] == snapshot.funding_rate else now
            self._last_rates[snapshot.exchange_symbol] = (snapshot.funding_rate, changed_at)
            snapshot.metadata["rate_changed_at"] = changed_at.isoformat()
            snapshot.metadata["rate_change_observed"] = previous is not None and changed_at == now

    @classmethod
    def parse_premium_index(cls, payload: list[dict], instrument_metadata: dict[str, dict]) -> list[FundingSnapshot]:
        snapshots: list[FundingSnapshot] = []
        for item in payload:
            symbol = item.get("symbol", "")
            # INR-quoted contracts are priced in rupees and can't be paired with the USDT books elsewhere.
            if not symbol.endswith("USDT"):
                continue

            instrument = instrument_metadata.get(symbol, {})
            if instrument and instrument.get("quoteAsset") != "USDT":
                continue

            funding_rate = cls._to_float(item.get("lastFundingRate"))
            if funding_rate is None:
                continue

            identity = normalize_exchange_symbol(
                "wazirx",
                symbol,
                base_asset_hint=instrument.get("baseAsset"),
                quote_asset_hint=instrument.get("quoteAsset"),
            )
            next_funding_ms = item.get("nextFundingTime")
            next_funding_time = (
                datetime.fromtimestamp(next_funding_ms / 1000, tz=timezone.utc) if next_funding_ms else None
            )

            snapshots.append(
                FundingSnapshot(
                    exchange="wazirx",
                    exchange_symbol=symbol,
                    canonical_symbol=identity.canonical_symbol,
                    base_asset=identity.base_asset,
                    quote_asset=identity.quote_asset,
                    funding_rate=funding_rate,
                    funding_interval_hours=cls._default_funding_interval_hours,
                    max_leverage=cls._to_float(instrument.get("maxLeverage")),
                    mark_price=cls._to_float(item.get("markPrice")),
                    index_price=cls._to_float(item.get("indexPrice")),
                    next_funding_time=next_funding_time,
                    maker_fee_bps=cls._maker_fee_bps,
                    taker_fee_bps=cls._taker_fee_bps,
                    metadata={
                        "source": "wazirx_premium_index",
                        "rate_refresh_seconds": cls._rate_refresh_seconds,
                        "source_quote_asset": identity.source_quote_asset,
                        "margin_asset": instrument.get("marginAsset"),
                        "contract_name": instrument.get("contractName"),
                        "estimated_settle_price": cls._to_float(item.get("estimatedSettlePrice")),
                    },
                )
            )

        return snapshots
