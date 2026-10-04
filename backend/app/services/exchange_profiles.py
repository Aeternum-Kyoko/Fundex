"""Exchange pages: what each venue is, what it charges, and how every coin on it looks right now.

Fees are labelled with where they came from: the exchange's own API per contract (Delta, CoinDCX), the user's
account tier read with their key (Binance, when one is stored), or the venue's published standard rate. Contract
specs (tick size, minimum order, margins, funding caps) come from each exchange's public instrument endpoints and
are cached for a few hours, since they rarely change.
"""

from __future__ import annotations

import asyncio
import logging
import statistics
import time
from datetime import datetime, timezone
from typing import Any

from httpx import AsyncClient

from app.models.market import FundingSnapshot
from app.services.links import exchange_display_name, exchange_trade_url

logger = logging.getLogger(__name__)

SPEC_CACHE_SECONDS = 6 * 3600

PROFILES: dict[str, dict[str, Any]] = {
    "binance": {
        "region": "Global",
        "market": "USDT-margined perpetual futures (USD-M)",
        "funding_schedule": "Each contract has its own interval, set by Binance and changed for volatile coins; the live mix is shown above.",
        "rate_feed": "Predicted rate (premiumIndex), refreshed every few seconds.",
        "history": "Settled funding history is public, so this venue is in the backtest and the strategy bot.",
        "published_fees": "Standard tier: 0.02% maker, 0.05% taker per fill. VIP tiers and BNB payment lower it.",
        "website": "https://www.binance.com/en/futures",
        "fee_page": "https://www.binance.com/en/fee/futureFee",
        "api_docs": "https://developers.binance.com/docs/derivatives/usds-margined-futures/general-info",
    },
    "delta": {
        "region": "India",
        "market": "USD-quoted perpetual futures on Delta Exchange India",
        "funding_schedule": "Each contract has its own interval, read from Delta's products API; the live mix is shown above.",
        "rate_feed": "Predicted rate over websocket, so it moves in near real time.",
        "history": "Settled funding history is public, so this venue is in the backtest and the strategy bot.",
        "published_fees": "Fees are read per contract from Delta's products API.",
        "website": "https://india.delta.exchange",
        "fee_page": None,
        "api_docs": "https://docs.delta.exchange",
    },
    "coindcx": {
        "region": "India",
        "market": "USDT-margined perpetual futures",
        "funding_schedule": "Mirrors Binance's funding for the same contracts.",
        "rate_feed": "Estimated funding rate from CoinDCX's price feed.",
        "history": "CoinDCX mirrors Binance's funding, so the backtest uses Binance for it.",
        "published_fees": "Fees are read per contract from CoinDCX's instrument API (they include GST).",
        "website": "https://coindcx.com/futures",
        "fee_page": None,
        "api_docs": "https://docs.coindcx.com",
    },
    "wazirx": {
        "region": "India",
        "market": "USDT-margined perpetual futures",
        "funding_schedule": "WazirX publishes no interval; most USDT perps settle every 4h (checked against Binance's schedule).",
        "rate_feed": "Funding rate republished in batches about every 15 minutes, so it lags other venues.",
        "history": "No public funding history, so WazirX is monitored but not backtested.",
        "published_fees": "Published rate: 0.0236% maker, 0.0472% taker including GST.",
        "website": "https://wazirx.com",
        "fee_page": None,
        "api_docs": "https://docs.wazirx.com",
    },
    "coinswitch": {
        "region": "India",
        "market": "Perpetual futures (CoinSwitch PRO)",
        "funding_schedule": "From the contract data CoinSwitch's API returns.",
        "rate_feed": "Read with your API key; CoinSwitch has no public futures feed.",
        "history": "No public funding history, so CoinSwitch is monitored but not backtested.",
        "published_fees": "Standard rate assumed: 0.02% maker, 0.05% taker.",
        "website": "https://coinswitch.co",
        "fee_page": None,
        "api_docs": None,
    },
}

LIVE_TRADING = {
    "binance": "Supported: needs USD-M futures permission and Hedge Mode.",
    "delta": "Supported: market orders, sizes rounded to whole contracts.",
    "coindcx": "Supported: market orders on USDT futures.",
    "coinswitch": "Supported, but leverage has to be set on the venue first.",
    "wazirx": "Monitor only: order routing is not wired up.",
}


def annualised_percent(snapshot: FundingSnapshot) -> float:
    return snapshot.funding_rate * 24 / max(snapshot.funding_interval_hours or 8, 1) * 365 * 100


def hourly_rate(snapshot: FundingSnapshot) -> float:
    return snapshot.funding_rate / max(snapshot.funding_interval_hours or 8, 1)


def fee_source(exchange: str, account_override: bool) -> str:
    if exchange == "binance":
        return "your account's tier, read from Binance with your key" if account_override else "Binance's published standard tier"
    if exchange in ("delta", "coindcx"):
        return f"per contract, from {exchange_display_name(exchange)}'s own API"  # type: ignore[arg-type]
    return "the venue's published rate"


def _spread(values: list[float]) -> dict | None:
    values = [value for value in values if value is not None]
    if not values:
        return None
    return {"min": min(values), "median": statistics.median(values), "max": max(values)}


def coin_row(snapshot: FundingSnapshot, by_coin: dict[str, list[FundingSnapshot]], taker_override: float | None) -> dict:
    """One coin on one exchange, plus where it stands against the same coin elsewhere."""
    others = [item for item in by_coin.get(snapshot.canonical_symbol, []) if item.exchange != snapshot.exchange]
    mine = hourly_rate(snapshot)
    # Rank 1 = the highest funding of all venues listing the coin, i.e. the best place to be short.
    rank = 1 + sum(1 for item in others if hourly_rate(item) > mine)
    best_long = min(others, key=hourly_rate, default=None)
    best_short = max(others, key=hourly_rate, default=None)
    if best_long and mine - hourly_rate(best_long) >= hourly_rate(best_short) - mine:
        pair = {"role": "short here", "other": best_long.exchange, "spread_apr": (mine - hourly_rate(best_long)) * 24 * 365 * 100}
    elif best_short:
        pair = {"role": "long here", "other": best_short.exchange, "spread_apr": (hourly_rate(best_short) - mine) * 24 * 365 * 100}
    else:
        pair = None
    premium = (snapshot.mark_price - snapshot.index_price) / snapshot.index_price * 100 if snapshot.mark_price and snapshot.index_price else None
    return {
        "canonical_symbol": snapshot.canonical_symbol,
        "coin": snapshot.base_asset,
        "exchange_symbol": snapshot.exchange_symbol,
        "funding_rate": snapshot.funding_rate,
        "interval_hours": snapshot.funding_interval_hours,
        "apr_percent": annualised_percent(snapshot),
        "next_funding_time": snapshot.next_funding_time.isoformat() if snapshot.next_funding_time else None,
        "mark_price": snapshot.mark_price,
        "index_price": snapshot.index_price,
        "premium_percent": premium,
        "open_interest_usd": snapshot.open_interest_usd,
        "volume_24h_usd": snapshot.volume_24h,
        "max_leverage": snapshot.max_leverage,
        "maker_fee_bps": snapshot.maker_fee_bps,
        "taker_fee_bps": taker_override if taker_override is not None else snapshot.taker_fee_bps,
        "listed_on": 1 + len(others),
        "rank": rank,
        "best_pair": pair,
        "trade_url": exchange_trade_url(snapshot.exchange, snapshot.exchange_symbol),
        "fetched_at": snapshot.fetched_at.isoformat(),
    }


def exchange_summary(exchange: str, snapshots: list[FundingSnapshot], all_snapshots: list[FundingSnapshot], status, taker_override: float | None, now: datetime) -> dict:
    profile = PROFILES.get(exchange, {})
    coins = {item.canonical_symbol for item in snapshots}
    shared = {item.canonical_symbol for item in all_snapshots if item.exchange != exchange} & coins
    intervals: dict[str, int] = {}
    for item in snapshots:
        key = f"{item.funding_interval_hours}h"
        intervals[key] = intervals.get(key, 0) + 1
    aprs = sorted(((annualised_percent(item), item.base_asset) for item in snapshots), reverse=True)
    upcoming = sorted(item.next_funding_time for item in snapshots if item.next_funding_time and item.next_funding_time > now)
    ages = [(now - item.fetched_at).total_seconds() for item in snapshots]
    return {
        "exchange": exchange,
        "display_name": exchange_display_name(exchange),  # type: ignore[arg-type]
        "region": profile.get("region"),
        "market": profile.get("market"),
        "healthy": bool(status.healthy) if status else False,
        "enabled": bool(status.enabled) if status else False,
        "configured": bool(status.configured) if status else False,
        "last_success_at": status.last_success_at.isoformat() if status and status.last_success_at else None,
        "last_error": status.last_error if status else None,
        "coins": len(coins),
        "shared_coins": len(shared),
        "interval_mix": dict(sorted(intervals.items(), key=lambda item: int(item[0][:-1]))),
        "next_settlement_at": upcoming[0].isoformat() if upcoming else None,
        "data_age_seconds": statistics.median(ages) if ages else None,
        "fees": {
            "taker_bps": _spread([taker_override if taker_override is not None else item.taker_fee_bps for item in snapshots]),
            "maker_bps": _spread([item.maker_fee_bps for item in snapshots]),
            "source": fee_source(exchange, taker_override is not None),
            "published": profile.get("published_fees"),
        },
        "funding": {
            "positive_share": sum(1 for item in snapshots if item.funding_rate > 0) / len(snapshots) if snapshots else None,
            "median_apr_percent": statistics.median(apr for apr, _ in aprs) if aprs else None,
            "highest": [{"coin": coin, "apr_percent": apr} for apr, coin in aprs[:5]],
            "lowest": [{"coin": coin, "apr_percent": apr} for apr, coin in aprs[-5:][::-1]],
        },
        "open_interest_usd": sum(item.open_interest_usd or 0.0 for item in snapshots) or None,
        "volume_24h_usd": sum(item.volume_24h or 0.0 for item in snapshots) or None,
        "max_leverage": _spread([item.max_leverage for item in snapshots if item.max_leverage]),
        "live_trading": LIVE_TRADING.get(exchange),
        "funding_schedule": profile.get("funding_schedule"),
        "rate_feed": profile.get("rate_feed"),
        "history": profile.get("history"),
        "links": {key: profile.get(key) for key in ("website", "fee_page", "api_docs") if profile.get(key)},
    }


def _num(value: Any) -> float | None:
    try:
        return float(value) if value not in (None, "") else None
    except (TypeError, ValueError):
        return None


class ExchangeSpecs:
    """Contract specs straight from each exchange's public instrument endpoints, cached."""

    def __init__(self, client: AsyncClient, adapters: list) -> None:
        self.client = client
        self.adapters = adapters
        self._cache: dict[str, tuple[float, dict[str, dict]]] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    async def for_symbol(self, exchange: str, exchange_symbol: str) -> list[dict]:
        specs = await self._load(exchange)
        return specs.get(exchange_symbol.upper(), [])  # type: ignore[return-value]

    async def _load(self, exchange: str) -> dict:
        cached = self._cache.get(exchange)
        if cached and time.time() - cached[0] < SPEC_CACHE_SECONDS:
            return cached[1]
        async with self._locks.setdefault(exchange, asyncio.Lock()):
            cached = self._cache.get(exchange)
            if cached and time.time() - cached[0] < SPEC_CACHE_SECONDS:
                return cached[1]
            try:
                loader = {"binance": self._binance, "delta": self._delta}.get(exchange, self._from_adapter)
                specs = await loader(exchange)
            except Exception:  # noqa: BLE001
                logger.warning("Contract specs unavailable for %s", exchange, exc_info=True)
                specs = cached[1] if cached else {}
            self._cache[exchange] = (time.time(), specs)
            return specs

    async def _binance(self, _: str) -> dict:
        info, funding = await asyncio.gather(
            self.client.get("https://fapi.binance.com/fapi/v1/exchangeInfo", timeout=30.0),
            self.client.get("https://fapi.binance.com/fapi/v1/fundingInfo", timeout=30.0),
        )
        info.raise_for_status()
        caps = {}
        if funding.status_code < 400:
            caps = {item["symbol"]: item for item in funding.json() if item.get("symbol")}
        out: dict[str, list[dict]] = {}
        for item in info.json().get("symbols", []):
            filters = {entry.get("filterType"): entry for entry in item.get("filters", [])}
            cap = caps.get(item.get("symbol"), {})
            onboard = item.get("onboardDate")
            rows = [
                ("Status", item.get("status")),
                ("Contract", item.get("contractType")),
                ("Listed", datetime.fromtimestamp(onboard / 1000, timezone.utc).strftime("%Y-%m-%d") if onboard else None),
                ("Tick size", filters.get("PRICE_FILTER", {}).get("tickSize")),
                ("Quantity step", filters.get("LOT_SIZE", {}).get("stepSize")),
                ("Minimum quantity", filters.get("LOT_SIZE", {}).get("minQty")),
                ("Largest market order", filters.get("MARKET_LOT_SIZE", {}).get("maxQty")),
                ("Minimum order value (USDT)", filters.get("MIN_NOTIONAL", {}).get("notional")),
                ("Liquidation fee", f"{_num(item.get('liquidationFee')) * 100:.3f}%" if _num(item.get("liquidationFee")) is not None else None),
                ("Market order price band", f"±{_num(item.get('marketTakeBound')) * 100:.0f}%" if _num(item.get("marketTakeBound")) is not None else None),
                ("Funding rate cap", f"{_num(cap.get('adjustedFundingRateCap')) * 100:+.3f}%" if _num(cap.get("adjustedFundingRateCap")) is not None else None),
                ("Funding rate floor", f"{_num(cap.get('adjustedFundingRateFloor')) * 100:+.3f}%" if _num(cap.get("adjustedFundingRateFloor")) is not None else None),
                ("Funding interval (set by Binance)", f"{cap['fundingIntervalHours']}h" if cap.get("fundingIntervalHours") else None),
            ]
            out[str(item.get("symbol")).upper()] = [{"label": label, "value": str(value)} for label, value in rows if value not in (None, "")]
        return out

    async def _delta(self, _: str) -> dict:
        response = await self.client.get("https://api.india.delta.exchange/v2/products", params={"contract_types": "perpetual_futures"}, timeout=30.0)
        response.raise_for_status()
        out: dict[str, list[dict]] = {}
        for item in response.json().get("result", []):
            launch = item.get("launch_time")
            settling = (item.get("settling_asset") or {}).get("symbol")
            rows = [
                ("Status", item.get("state")),
                ("Listed", str(launch)[:10] if launch else None),
                ("Contract size", f"{item.get('contract_value')} {(item.get('underlying_asset') or {}).get('symbol', '')}".strip() if item.get("contract_value") else None),
                ("Tick size", item.get("tick_size")),
                ("Settles in", settling),
                ("Maker fee", f"{_num(item.get('maker_commission_rate')) * 100:.4f}%" if _num(item.get("maker_commission_rate")) is not None else None),
                ("Taker fee", f"{_num(item.get('taker_commission_rate')) * 100:.4f}%" if _num(item.get("taker_commission_rate")) is not None else None),
                ("Initial margin", f"{item.get('initial_margin')}%" if item.get("initial_margin") else None),
                ("Maintenance margin", f"{item.get('maintenance_margin')}%" if item.get("maintenance_margin") else None),
                ("Default leverage", f"{item.get('default_leverage')}x" if item.get("default_leverage") else None),
                ("Position size limit (contracts)", item.get("position_size_limit")),
                ("Funding method", item.get("funding_method")),
            ]
            out[str(item.get("symbol")).upper()] = [{"label": label, "value": str(value)} for label, value in rows if value not in (None, "")]
        return out

    async def _from_adapter(self, exchange: str) -> dict:
        """CoinDCX, WazirX and CoinSwitch: the instrument data their adapters already cache."""
        adapter = next((item for item in self.adapters if getattr(item, "exchange", None) == exchange), None)
        raw = getattr(adapter, "_instrument_metadata", None) or {}
        labels = {
            "status": "Status",
            "max_leverage": "Max leverage",
            "min_quantity": "Minimum quantity",
            "max_quantity": "Maximum quantity",
            "quantity_increment": "Quantity step",
            "price_increment": "Tick size",
            "min_notional": "Minimum order value",
            "maker_fee": "Maker fee (%)",
            "taker_fee": "Taker fee (%)",
            "funding_frequency": "Funding interval (h)",
            "margin_currency_short_name": "Margin currency",
            "unit_contract_value": "Contract size",
            "liquidation_fee": "Liquidation fee (%)",
            "marginAsset": "Margin currency",
            "contractName": "Contract",
            "pricePrecision": "Price precision",
            "quantityPrecision": "Quantity precision",
        }
        out: dict[str, list[dict]] = {}
        for symbol, item in raw.items():
            if not isinstance(item, dict):
                continue
            rows = [{"label": label, "value": str(item[key])} for key, label in labels.items() if item.get(key) not in (None, "")]
            out[str(symbol).upper()] = rows
        return out
