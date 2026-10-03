from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

from cryptography.hazmat.primitives.asymmetric import ed25519

from app.adapters.base import ExchangeAdapter
from app.models.market import FundingSnapshot
from app.services.symbols import canonicalize


class CoinSwitchAdapter(ExchangeAdapter):
    exchange = "coinswitch"
    display_name = "CoinSwitch"
    _maker_fee_bps = 2.0
    _taker_fee_bps = 5.0
    _base_url = "https://coinswitch.co"
    _metadata_ttl = timedelta(hours=6)

    def __init__(self, client, settings=None, *, api_key: str | None = None, secret_key: str | None = None, exchange_code: str | None = None) -> None:
        super().__init__(client, settings)
        # Keys saved through the admin page take precedence over .env values.
        self._api_key = api_key or (settings.coinswitch_api_key if settings else None)
        self._secret_key = secret_key or (settings.coinswitch_secret_key if settings else None)
        self._exchange_code = exchange_code or (settings.coinswitch_exchange if settings else "EXCHANGE_2")
        self._instrument_metadata: dict[str, dict[str, float | str | None]] = {}
        self._instrument_metadata_updated_at: datetime | None = None

    @classmethod
    def _extract_max_leverage(cls, item: dict) -> float | None:
        candidate_values = (
            item.get("max_leverage"),
            item.get("maxLeverage"),
            item.get("leverage"),
            item.get("allowed_leverage"),
        )
        for value in candidate_values:
            parsed = cls._to_float(value)
            if parsed is not None and parsed > 0:
                return parsed
        return None

    async def _refresh_instrument_metadata_if_needed(self, epoch_time: int) -> None:
        now = datetime.now(timezone.utc)
        if self._instrument_metadata_updated_at and now - self._instrument_metadata_updated_at < self._metadata_ttl:
            return

        params = {"exchange": self._exchange_code}
        endpoint = "/trade/api/v2/futures/instrument_info"
        signature, request_path = self._sign_request("GET", endpoint, params, str(epoch_time))

        response = await self.client.get(
            f"{self._base_url}{request_path}",
            headers={
                "Content-Type": "application/json",
                "X-AUTH-SIGNATURE": signature,
                "X-AUTH-APIKEY": self._api_key or "",
                "X-AUTH-EPOCH": str(epoch_time),
                "User-Agent": "Fundex/1.0",
            },
            timeout=30.0,
        )
        response.raise_for_status()
        payload = response.json()

        metadata: dict[str, dict[str, float | str | None]] = {}
        raw_data = payload.get("data", {})
        if isinstance(raw_data, dict):
            iterator = raw_data.items()
        elif isinstance(raw_data, list):
            iterator = ((item.get("symbol"), item) for item in raw_data if isinstance(item, dict))
        else:
            iterator = []

        for symbol, item in iterator:
            if not symbol or not isinstance(item, dict):
                continue
            metadata[str(symbol).upper()] = {
                "max_leverage": self._extract_max_leverage(item),
            }

        self._instrument_metadata = metadata
        self._instrument_metadata_updated_at = now

    async def fetch_snapshots(self) -> list[FundingSnapshot]:
        epoch_time = await self._get_server_epoch()
        await self._refresh_instrument_metadata_if_needed(epoch_time)
        params = {"exchange": self._exchange_code}
        endpoint = "/trade/api/v2/futures/all-pairs/ticker"
        signature, request_path = self._sign_request("GET", endpoint, params, str(epoch_time))

        response = await self.client.get(
            f"{self._base_url}{request_path}",
            headers={
                "Content-Type": "application/json",
                "X-AUTH-SIGNATURE": signature,
                "X-AUTH-APIKEY": self._api_key or "",
                "X-AUTH-EPOCH": str(epoch_time),
                "User-Agent": "Fundex/1.0",
            },
            timeout=30.0,
        )
        response.raise_for_status()
        payload = response.json()

        snapshots: list[FundingSnapshot] = []
        for symbol, item in payload.get("data", {}).items():
            if not symbol.endswith("USDT"):
                continue

            canonical_symbol, base_asset, quote_asset = canonicalize(symbol)
            instrument_metadata = self._instrument_metadata.get(symbol.upper(), {})
            next_funding = None
            if item.get("next_funding_timestamp"):
                next_funding = datetime.fromtimestamp(item["next_funding_timestamp"] / 1000, tz=timezone.utc)

            funding_rate = self._to_float(item.get("funding_rate"))
            if funding_rate is None:
                continue

            snapshots.append(
                FundingSnapshot(
                    exchange=self.exchange,
                    exchange_symbol=symbol,
                    canonical_symbol=canonical_symbol,
                    base_asset=base_asset,
                    quote_asset=quote_asset,
                    funding_rate=funding_rate,
                    funding_interval_hours=8,
                    max_leverage=self._extract_max_leverage(item) or self._to_float(instrument_metadata.get("max_leverage")),
                    mark_price=self._to_float(item.get("mark_price")),
                    index_price=self._to_float(item.get("index_price")),
                    open_interest=self._to_float(item.get("open_interest")),
                    open_interest_usd=self._to_float(item.get("open_interest_value")),
                    volume_24h=self._to_float(item.get("quote_asset_volume_24h")),
                    next_funding_time=next_funding,
                    maker_fee_bps=self._maker_fee_bps,
                    taker_fee_bps=self._taker_fee_bps,
                    metadata={
                        "source": "coinswitch_all_pairs_ticker",
                        "best_bid_size": self._to_float(item.get("best_bid_size")),
                        "best_ask_size": self._to_float(item.get("best_ask_size")),
                    },
                )
            )

        return snapshots

    async def _get_server_epoch(self) -> int:
        response = await self.client.get(f"{self._base_url}/trade/api/v2/time", timeout=15.0)
        response.raise_for_status()
        payload = response.json()
        return int(payload.get("serverTime") or int(time.time() * 1000))

    def _sign_request(self, method: str, endpoint: str, params: dict[str, str], epoch_time: str) -> tuple[str, str]:
        if not self._secret_key:
            raise RuntimeError("CoinSwitch secret key is missing.")

        request_path = endpoint
        if params:
            request_path += "?" + urlencode(params)

        request_string = f"{method}{request_path}{epoch_time}".encode("utf-8")
        secret_key_bytes = bytes.fromhex(self._secret_key)
        private_key = ed25519.Ed25519PrivateKey.from_private_bytes(secret_key_bytes)
        signature = private_key.sign(request_string).hex()
        return signature, request_path

    @staticmethod
    def _to_float(value: object) -> float | None:
        if value in (None, ""):
            return None
        return float(value)
