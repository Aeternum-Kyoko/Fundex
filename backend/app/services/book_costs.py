"""Measured trading cost per coin from the live order books, for the Strategy lab.

The lab's flat slippage setting treats every coin alike, but most of the carry profit comes from thin coins where
crossing the book costs far more. This walks each leg's live book at the trade size (in and out) and caches the
result, so a replay can charge each coin what it would cost today. Today's depth applied to past trades is an
approximation, but a much better one than a single number for 190 coins.
"""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timezone

from app.services.liquidity import OrderBookFetcher, build_depth_quote

logger = logging.getLogger(__name__)

CACHE_SECONDS = 30 * 60
THIN_BOOK_SLIPPAGE_PERCENT = 2.0  # a leg the visible book can't fill is charged as if it were very expensive


class BookCostCache:
    def __init__(self, fetcher: OrderBookFetcher) -> None:
        self.fetcher = fetcher
        self._cache: dict[tuple[str, str, float], tuple[float, float]] = {}  # key -> (measured at, round trip %)

    async def leg_round_trip(self, exchange: str, symbol: str, notional_usd: float) -> float | None:
        key = (exchange, symbol, round(notional_usd, 2))
        cached = self._cache.get(key)
        if cached and time.time() - cached[0] < CACHE_SECONDS:
            return cached[1]
        try:
            book = await self.fetcher.fetch(exchange, symbol)  # type: ignore[arg-type]
        except Exception:  # noqa: BLE001
            logger.info("Book unavailable for %s %s", exchange, symbol, exc_info=True)
            return None
        if not book:
            return None
        quote = build_depth_quote(exchange, symbol, book[0], book[1], notional_usd, datetime.now(timezone.utc))  # type: ignore[arg-type]
        if quote is None:
            return None
        value = quote.round_trip_percent if quote.round_trip_percent is not None else THIN_BOOK_SLIPPAGE_PERCENT
        self._cache[key] = (time.time(), value)
        return value

    async def coin_slippage(self, legs: dict[str, tuple[str, str]], notional_usd: float) -> dict[str, float]:
        """legs: canonical symbol -> (Binance symbol, Delta symbol). Returns slippage per leg, in + out (%)."""
        semaphore = asyncio.Semaphore(8)

        async def measure(canonical: str, binance_symbol: str, delta_symbol: str) -> tuple[str, float | None]:
            async with semaphore:
                binance, delta = await asyncio.gather(
                    self.leg_round_trip("binance", binance_symbol, notional_usd), self.leg_round_trip("delta", delta_symbol, notional_usd)
                )
            if binance is None or delta is None:
                return canonical, None
            # The lab's setting is per leg; the two legs are charged separately, so use their average.
            return canonical, (binance + delta) / 2

        results = await asyncio.gather(*(measure(canonical, *pair) for canonical, pair in legs.items()))
        return {canonical: value for canonical, value in results if value is not None}
