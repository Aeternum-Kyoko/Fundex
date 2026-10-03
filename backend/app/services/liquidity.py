from __future__ import annotations

import asyncio
import logging
from collections import defaultdict, deque
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from httpx import AsyncClient, HTTPStatusError

from app.models.market import ArbitrageOpportunity, ExchangeName

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class DepthQuote:
    """Cost of trading `notional_usd` through one venue's live book, as % of notional."""

    exchange: ExchangeName
    exchange_symbol: str
    measured_at: datetime
    notional_usd: float
    mid_price: float
    buy_impact_percent: float | None  # None = book too thin to fill the size
    sell_impact_percent: float | None
    top_of_book_spread_percent: float

    @property
    def fillable(self) -> bool:
        return self.buy_impact_percent is not None and self.sell_impact_percent is not None

    @property
    def round_trip_percent(self) -> float | None:
        # Entering and later exiting crosses the book once each way.
        if not self.fillable:
            return None
        return (self.buy_impact_percent or 0.0) + (self.sell_impact_percent or 0.0)

    def age_seconds(self, now: datetime) -> float:
        return (now - self.measured_at).total_seconds()


def impact_percent(levels: list[tuple[float, float]], notional_usd: float, mid_price: float) -> float | None:
    """Average fill price distance from mid for `notional_usd`, walking price levels best-first.

    `levels` are (price, base quantity). Returns None when the visible book cannot fill the size.
    """
    if mid_price <= 0 or notional_usd <= 0:
        return None
    remaining = notional_usd
    cost = 0.0
    quantity = 0.0
    for price, size in levels:
        if price <= 0 or size <= 0:
            continue
        level_notional = price * size
        take = min(remaining, level_notional)
        cost += take
        quantity += take / price
        remaining -= take
        if remaining <= 1e-9:
            break
    if remaining > 1e-9 or quantity <= 0:
        return None
    average_price = cost / quantity
    return abs(average_price - mid_price) / mid_price * 100


def build_depth_quote(
    exchange: ExchangeName,
    exchange_symbol: str,
    bids: list[tuple[float, float]],
    asks: list[tuple[float, float]],
    notional_usd: float,
    now: datetime,
) -> DepthQuote | None:
    bids = sorted(((p, q) for p, q in bids if p > 0 and q > 0), key=lambda level: -level[0])
    asks = sorted(((p, q) for p, q in asks if p > 0 and q > 0), key=lambda level: level[0])
    if not bids or not asks or asks[0][0] <= bids[0][0] * 0.5:
        return None
    mid = (bids[0][0] + asks[0][0]) / 2
    return DepthQuote(
        exchange=exchange,
        exchange_symbol=exchange_symbol,
        measured_at=now,
        notional_usd=notional_usd,
        mid_price=mid,
        buy_impact_percent=impact_percent(asks, notional_usd, mid),
        sell_impact_percent=impact_percent(bids, notional_usd, mid),
        top_of_book_spread_percent=(asks[0][0] - bids[0][0]) / mid * 100,
    )


class OrderBookFetcher:
    """Public L2 books, normalised to (price, base quantity)."""

    def __init__(self, client: AsyncClient) -> None:
        self.client = client
        self._delta_contract_values: dict[str, float] = {}

    async def fetch(self, exchange: ExchangeName, symbol: str) -> tuple[list[tuple[float, float]], list[tuple[float, float]]] | None:
        if exchange == "binance":
            payload = await self._get("https://fapi.binance.com/fapi/v1/depth", {"symbol": symbol, "limit": 50})
            return self._pairs(payload.get("bids")), self._pairs(payload.get("asks"))
        if exchange == "wazirx":
            payload = await self._get("https://api.wazirx.com/fapi/v1/depth", {"symbol": symbol, "limit": 50})
            return self._pairs(payload.get("bids")), self._pairs(payload.get("asks"))
        if exchange == "coindcx":
            payload = await self._get(f"https://public.coindcx.com/market_data/v3/orderbook/{symbol}-futures/50", None)
            return self._dict_levels(payload.get("bids")), self._dict_levels(payload.get("asks"))
        if exchange == "delta":
            contract_value = await self._delta_contract_value(symbol)
            payload = (await self._get(f"https://api.india.delta.exchange/v2/l2orderbook/{symbol}", None)).get("result") or {}
            # Delta sizes are in contracts; one contract is `contract_value` units of the base asset.
            to_levels = lambda rows: [(float(row["price"]), float(row["size"]) * contract_value) for row in rows or []]  # noqa: E731
            return to_levels(payload.get("buy")), to_levels(payload.get("sell"))
        return None

    async def _delta_contract_value(self, symbol: str) -> float:
        if symbol not in self._delta_contract_values:
            product = (await self._get(f"https://api.india.delta.exchange/v2/products/{symbol}", None)).get("result") or {}
            self._delta_contract_values[symbol] = float(product.get("contract_value") or 1.0)
        return self._delta_contract_values[symbol]

    async def _get(self, url: str, params: dict | None) -> dict:
        response = await self.client.get(url, params=params, headers={"User-Agent": "Mozilla/5.0 Fundex/1.0"}, timeout=15.0)
        response.raise_for_status()
        return response.json()

    @staticmethod
    def _pairs(rows) -> list[tuple[float, float]]:
        return [(float(price), float(size)) for price, size, *_ in rows or []]

    @staticmethod
    def _dict_levels(rows) -> list[tuple[float, float]]:
        return [(float(price), float(size)) for price, size in (rows or {}).items()]


class LiquidityService:
    """Keeps order-book cost measurements for the legs of the most interesting opportunities."""

    # Per refresh cycle; WazirX rate-limits aggressively, the others are generous.
    _per_exchange_budget: dict[str, int] = {"binance": 40, "delta": 40, "coindcx": 40, "wazirx": 8, "coinswitch": 0}
    # WazirX returns 429 on bursts, so its books are fetched one at a time with a pause.
    _per_exchange_concurrency: dict[str, int] = {"wazirx": 1}
    _per_exchange_pause_seconds: dict[str, float] = {"wazirx": 0.6}

    def __init__(self, client: AsyncClient, notional_usd: float, top_n: int, max_age_seconds: float) -> None:
        self.notional_usd = notional_usd
        self.top_n = top_n
        self.max_age_seconds = max_age_seconds
        self._fetcher = OrderBookFetcher(client)
        self._quotes: dict[tuple[str, str], DepthQuote] = {}
        self._backoff_until: dict[str, datetime] = {}
        self._lock = asyncio.Lock()

    def quote(self, exchange: str, symbol: str, now: datetime | None = None) -> DepthQuote | None:
        quote = self._quotes.get((exchange, symbol))
        if quote is None or quote.notional_usd != self.notional_usd:
            return None
        if quote.age_seconds(now or datetime.now(timezone.utc)) > self.max_age_seconds:
            return None
        return quote

    async def refresh(self, opportunities: list[ArbitrageOpportunity]) -> int:
        if self._lock.locked():
            return 0
        async with self._lock:
            now = datetime.now(timezone.utc)
            ranked = sorted(opportunities, key=lambda item: item.gross_apr_percent, reverse=True)[: self.top_n]
            wanted: list[tuple[str, str]] = []
            budget = dict(self._per_exchange_budget)
            for opportunity in ranked:
                for leg in (opportunity.long_leg, opportunity.short_leg):
                    key = (leg.exchange, leg.exchange_symbol)
                    existing = self._quotes.get(key)
                    fresh = existing and existing.notional_usd == self.notional_usd and existing.age_seconds(now) < self.max_age_seconds / 2
                    if fresh or key in wanted or budget.get(leg.exchange, 0) <= 0:
                        continue
                    if self._backoff_until.get(leg.exchange, now) > now:
                        continue
                    budget[leg.exchange] -= 1
                    wanted.append(key)

            semaphores = {
                exchange: asyncio.Semaphore(self._per_exchange_concurrency.get(exchange, 4)) for exchange, _ in wanted
            }
            results = await asyncio.gather(*(self._measure(exchange, symbol, semaphores[exchange]) for exchange, symbol in wanted))
            return sum(1 for result in results if result)

    async def _measure(self, exchange: str, symbol: str, semaphore: asyncio.Semaphore) -> bool:
        async with semaphore:
            if self._backoff_until.get(exchange, datetime.min.replace(tzinfo=timezone.utc)) > datetime.now(timezone.utc):
                return False
            pause = self._per_exchange_pause_seconds.get(exchange)
            if pause:
                await asyncio.sleep(pause)
            try:
                book = await self._fetcher.fetch(exchange, symbol)  # type: ignore[arg-type]
            except HTTPStatusError as exc:
                if exc.response.status_code == 429:
                    self._backoff_until[exchange] = datetime.now(timezone.utc) + timedelta(minutes=2)
                    logger.warning("%s order book rate-limited; backing off for 2 minutes", exchange)
                return False
            except Exception:
                logger.debug("Order book fetch failed for %s %s", exchange, symbol, exc_info=True)
                return False
            if book is None:
                return False
            quote = build_depth_quote(exchange, symbol, book[0], book[1], self.notional_usd, datetime.now(timezone.utc))  # type: ignore[arg-type]
            if quote is None:
                return False
            self._quotes[(exchange, symbol)] = quote
            return True


@dataclass
class _PairSamples:
    samples: deque = field(default_factory=lambda: deque(maxlen=240))


class SpreadTracker:
    """In-memory record of each symbol's best-pair hourly spread, to tell lasting edges from spikes."""

    def __init__(self, window: timedelta = timedelta(hours=2), sample_every: timedelta = timedelta(seconds=30)) -> None:
        self.window = window
        self.sample_every = sample_every
        self._samples: dict[str, deque] = defaultdict(lambda: deque(maxlen=int(window / sample_every) + 8))

    def record(self, opportunities: list[ArbitrageOpportunity], now: datetime | None = None) -> None:
        now = now or datetime.now(timezone.utc)
        for opportunity in opportunities:
            samples = self._samples[opportunity.canonical_symbol]
            if samples and now - samples[-1][0] < self.sample_every:
                continue
            samples.append((now, opportunity.long_leg.exchange, opportunity.short_leg.exchange, opportunity.spread_rate_hourly))
            while samples and now - samples[0][0] > self.window:
                samples.popleft()

    def persistence(
        self,
        canonical_symbol: str,
        long_exchange: str,
        short_exchange: str,
        current_spread_hourly: float,
        now: datetime | None = None,
    ) -> tuple[float, float, int] | None:
        """(observed minutes, share of samples where this pair held >= half the current edge, sample count)."""
        now = now or datetime.now(timezone.utc)
        samples = [sample for sample in self._samples.get(canonical_symbol, ()) if now - sample[0] <= self.window]
        if not samples:
            return None
        threshold = current_spread_hourly * 0.5
        held = sum(
            1
            for _, long_exchange_seen, short_exchange_seen, spread in samples
            if long_exchange_seen == long_exchange and short_exchange_seen == short_exchange and spread >= threshold
        )
        observed_minutes = (now - samples[0][0]).total_seconds() / 60
        return observed_minutes, held / len(samples), len(samples)


@dataclass
class RankingContext:
    """Live extras the ranker can use when present: measured liquidity, persistence and account fee tiers."""

    liquidity: LiquidityService | None = None
    spreads: SpreadTracker | None = None
    taker_fee_overrides_bps: dict[str, float] = field(default_factory=dict)
    # Exchanges switched on at runtime (e.g. CoinSwitch after keys are saved in the admin page).
    runtime_exchanges: set[str] = field(default_factory=set)


def enabled_exchange_names(settings, context: RankingContext | None) -> list[str]:
    names = list(settings.enabled_exchange_names)
    for exchange in sorted(context.runtime_exchanges if context else ()):
        if exchange not in names:
            names.append(exchange)
    return names
