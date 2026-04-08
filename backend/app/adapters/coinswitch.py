from __future__ import annotations

import time
from datetime import datetime, timezone
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

    async def fetch_snapshots(self) -> list[FundingSnapshot]:
        epoch_time = await self._get_server_epoch()
        params = {"exchange": self.settings.coinswitch_exchange}
        endpoint = "/trade/api/v2/futures/all-pairs/ticker"
        signature, request_path = self._sign_request("GET", endpoint, params, str(epoch_time))

        response = await self.client.get(
            f"{self._base_url}{request_path}",
            headers={
                "Content-Type": "application/json",
                "X-AUTH-SIGNATURE": signature,
                "X-AUTH-APIKEY": self.settings.coinswitch_api_key or "",
                "X-AUTH-EPOCH": str(epoch_time),
                "User-Agent": "ArbRadar/1.0",
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
            next_funding = None
            if item.get("next_funding_timestamp"):
                next_funding = datetime.fromtimestamp(item["next_funding_timestamp"] / 1000, tz=timezone.utc)

            snapshots.append(
                FundingSnapshot(
                    exchange=self.exchange,
                    exchange_symbol=symbol,
                    canonical_symbol=canonical_symbol,
                    base_asset=base_asset,
                    quote_asset=quote_asset,
                    funding_rate=float(item["funding_rate"]),
                    funding_interval_hours=8,
                    mark_price=float(item["mark_price"]) if item.get("mark_price") is not None else None,
                    index_price=float(item["index_price"]) if item.get("index_price") is not None else None,
                    open_interest=float(item["open_interest"]) if item.get("open_interest") is not None else None,
                    open_interest_usd=float(item["open_interest_value"]) if item.get("open_interest_value") is not None else None,
                    volume_24h=float(item["quote_asset_volume_24h"]) if item.get("quote_asset_volume_24h") is not None else None,
                    next_funding_time=next_funding,
                    maker_fee_bps=self._maker_fee_bps,
                    taker_fee_bps=self._taker_fee_bps,
                    metadata={
                        "source": "coinswitch_all_pairs_ticker",
                        "best_bid_size": float(item["best_bid_size"]) if item.get("best_bid_size") is not None else None,
                        "best_ask_size": float(item["best_ask_size"]) if item.get("best_ask_size") is not None else None,
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
        if not self.settings or not self.settings.coinswitch_secret_key:
            raise RuntimeError("CoinSwitch secret key is missing.")

        request_path = endpoint
        if params:
            request_path += "?" + urlencode(params)

        request_string = f"{method}{request_path}{epoch_time}".encode("utf-8")
        secret_key_bytes = bytes.fromhex(self.settings.coinswitch_secret_key)
        private_key = ed25519.Ed25519PrivateKey.from_private_bytes(secret_key_bytes)
        signature = private_key.sign(request_string).hex()
        return signature, request_path
