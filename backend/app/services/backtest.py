"""Replay next-settlement captures over real settled funding history.

Data: Binance `fundingRate` history and Delta `FUNDING:<symbol>` hourly candles (the candle at a settlement
hour holds the rate that settled then, verified against a live trade). CoinDCX mirrors Binance's funding and
WazirX publishes no history, so the replay covers Binance <-> Delta pairs.

Assumption: the trade decision uses the settled rate. In practice it is made ~30s before settlement on the
predicted rate; Binance's prediction 11s before settlement matched the settled rate exactly for 630 of 787
contracts, so this is close but slightly optimistic.
"""

from __future__ import annotations

import asyncio
import logging
import sqlite3
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

from httpx import AsyncClient

from app.models.market import FundingSnapshot

logger = logging.getLogger(__name__)

FEE_GRID_BPS = [0.0, 1.0, 2.0, 3.5, 5.0]
SLIPPAGE_GRID_PERCENT = [0.0, 0.05, 0.1, 0.2]


@dataclass
class BacktestParams:
    days: int = 30
    notional_usd: float = 1000.0
    binance_taker_bps: float = 5.0
    delta_taker_bps: float = 5.0
    slippage_percent_per_leg: float = 0.1  # entry + exit, % of that leg's notional
    min_net_percent: float = 0.0


@dataclass
class CoinSeries:
    canonical_symbol: str
    base_asset: str
    binance: dict[int, float]  # settlement unix seconds -> rate (fraction)
    delta: dict[int, float]


def capture_at(binance_rate: float | None, delta_rate: float | None) -> tuple[float, str]:
    """Best single-settlement payment (fraction of one leg) and its direction.

    Only legs settling at that moment pay; picking the side means a lone settling leg always pays |rate|.
    """
    long_delta = (-delta_rate if delta_rate is not None else 0.0) + (binance_rate if binance_rate is not None else 0.0)
    long_binance = (-binance_rate if binance_rate is not None else 0.0) + (delta_rate if delta_rate is not None else 0.0)
    if long_delta >= long_binance:
        return long_delta, "long Delta, short Binance"
    return long_binance, "long Binance, short Delta"


def cost_percent(binance_bps: float, delta_bps: float, slippage_percent_per_leg: float) -> float:
    # Taker fee on entry and exit for both legs, plus each leg's round-trip slippage.
    return (binance_bps + delta_bps) * 2 / 100 + 2 * slippage_percent_per_leg


def simulate(series: list[CoinSeries], params: BacktestParams, start: int, end: int) -> dict:
    cost = cost_percent(params.binance_taker_bps, params.delta_taker_bps, params.slippage_percent_per_leg)
    captures: list[tuple[int, str, float, str, str]] = []  # time, coin, gross %, direction, settling
    settlements = 0
    for coin in series:
        for moment in sorted(set(coin.binance) | set(coin.delta)):
            if not start <= moment <= end:
                continue
            settlements += 1
            b = coin.binance.get(moment)
            d = coin.delta.get(moment)
            gross, direction = capture_at(b, d)
            settling = "both" if b is not None and d is not None else "Binance only" if b is not None else "Delta only"
            captures.append((moment, coin.base_asset, gross * 100, direction, settling))

    def run(cost_pct: float) -> list[tuple[int, str, float, float, str, str]]:
        return [
            (moment, coin, gross, gross - cost_pct, direction, settling)
            for moment, coin, gross, direction, settling in captures
            if gross - cost_pct >= params.min_net_percent
        ]

    trades = run(cost)
    notional = params.notional_usd
    total = sum(t[3] for t in trades)  # net % summed over trades
    days = max((end - start) / 86400, 1e-9)

    daily: dict[str, float] = {}
    for moment, coin, gross, net, direction, settling in trades:
        day = datetime.fromtimestamp(moment, timezone.utc).strftime("%Y-%m-%d")
        daily[day] = daily.get(day, 0.0) + net / 100 * notional

    by_coin: dict[str, dict] = {}
    for moment, coin, gross, net, direction, settling in trades:
        entry = by_coin.setdefault(coin, {"coin": coin, "trades": 0, "net_usd": 0.0, "best_gross_percent": 0.0})
        entry["trades"] += 1
        entry["net_usd"] += net / 100 * notional
        entry["best_gross_percent"] = max(entry["best_gross_percent"], gross)

    # Every coin, not just the top few: how often its next-settlement capture would have paid after costs.
    seen: dict[str, int] = {}
    for _, coin, _, _, _ in captures:
        seen[coin] = seen.get(coin, 0) + 1
    coin_stats: dict[str, dict] = {}
    for coin, count in seen.items():
        coin_trades = [t for t in trades if t[1] == coin]
        coin_stats[coin] = {
            "settlements": count,
            "paid": len(coin_trades),
            "hit_rate": len(coin_trades) / count if count else 0.0,
            "avg_net_percent": sum(t[3] for t in coin_trades) / len(coin_trades) if coin_trades else 0.0,
        }

    grid = []
    for bps in FEE_GRID_BPS:
        row = []
        for slip in SLIPPAGE_GRID_PERCENT:
            grid_trades = run(cost_percent(bps, bps, slip))
            row.append(
                {
                    "taker_bps": bps,
                    "slippage_percent": slip,
                    "trades": len(grid_trades),
                    "net_usd": sum(t[3] for t in grid_trades) / 100 * notional,
                }
            )
        grid.append(row)

    gross_values = [gross for _, _, gross, _, _ in captures]
    buckets = [0.0, 0.05, 0.1, 0.2, 0.5, 1.0]
    # Last bucket is open-ended: None, not float("inf"), which is not valid JSON.
    distribution = [
        {"min_percent": low, "max_percent": high, "count": sum(1 for g in gross_values if low <= g and (high is None or g < high))}
        for low, high in zip(buckets, buckets[1:] + [None])
    ]

    best = sorted(trades, key=lambda t: -t[3])[:10]
    return {
        "period_start": datetime.fromtimestamp(start, timezone.utc).isoformat(),
        "period_end": datetime.fromtimestamp(end, timezone.utc).isoformat(),
        "coins": len(series),
        "settlements": settlements,
        "cost_percent": cost,
        "trades": len(trades),
        "trades_per_day": len(trades) / days,
        "total_net_usd": total / 100 * notional,
        "avg_net_usd": (total / len(trades) / 100 * notional) if trades else 0.0,
        "per_month_usd": total / 100 * notional / days * 30,
        "daily": [{"day": day, "net_usd": value} for day, value in sorted(daily.items())],
        "by_coin": sorted(by_coin.values(), key=lambda item: -item["net_usd"])[:12],
        "coin_stats": coin_stats,
        "best_trades": [
            {
                "at": datetime.fromtimestamp(moment, timezone.utc).isoformat(),
                "coin": coin,
                "gross_percent": gross,
                "net_percent": net,
                "direction": direction,
                "settling": settling,
            }
            for moment, coin, gross, net, direction, settling in best
        ],
        "sensitivity": grid,
        "gross_distribution": distribution,
    }


class FundingHistoryCache:
    def __init__(self, database_path: Path) -> None:
        self.database_path = database_path
        with sqlite3.connect(database_path) as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS funding_history (
                    exchange TEXT NOT NULL,
                    symbol TEXT NOT NULL,
                    funding_time INTEGER NOT NULL,
                    rate REAL NOT NULL,
                    PRIMARY KEY (exchange, symbol, funding_time)
                )
                """
            )

    def save(self, exchange: str, symbol: str, rows: dict[int, float]) -> None:
        with sqlite3.connect(self.database_path) as connection:
            connection.executemany(
                "INSERT OR REPLACE INTO funding_history (exchange, symbol, funding_time, rate) VALUES (?, ?, ?, ?)",
                [(exchange, symbol, moment, rate) for moment, rate in rows.items()],
            )

    def load(self, exchange: str, symbol: str, start: int) -> dict[int, float]:
        with sqlite3.connect(self.database_path) as connection:
            rows = connection.execute(
                "SELECT funding_time, rate FROM funding_history WHERE exchange = ? AND symbol = ? AND funding_time >= ?",
                (exchange, symbol, start),
            ).fetchall()
        return {moment: rate for moment, rate in rows}

    def span(self, exchange: str, symbol: str) -> tuple[int, int] | None:
        with sqlite3.connect(self.database_path) as connection:
            row = connection.execute(
                "SELECT MIN(funding_time), MAX(funding_time) FROM funding_history WHERE exchange = ? AND symbol = ?", (exchange, symbol)
            ).fetchone()
        return (row[0], row[1]) if row and row[1] else None

    def fetch_from(self, exchange: str, symbol: str, start: int) -> int:
        """Only fetch what's missing: after the cached rows, or from the start if a longer period needs older ones."""
        cached = self.span(exchange, symbol)
        # A day of slack, so a coin listed after `start` doesn't refetch its whole history on every run.
        if cached is None or cached[0] > start + 86400:
            return start
        return max(start, cached[1] + 1)


@dataclass
class BacktestJob:
    status: str = "idle"  # idle | running | done | error
    progress: int = 0
    total: int = 0
    message: str = ""
    params: dict = field(default_factory=dict)
    result: dict | None = None
    finished_at: str | None = None


class BacktestService:
    def __init__(self, client: AsyncClient, database_path: Path) -> None:
        self.client = client
        self.cache = FundingHistoryCache(database_path)
        self.job = BacktestJob()
        self._task: asyncio.Task | None = None
        self._series: dict[str, CoinSeries] = {}
        self._history_days = 0

    def state(self) -> dict:
        return {
            "status": self.job.status,
            "progress": self.job.progress,
            "total": self.job.total,
            "message": self.job.message,
            "params": self.job.params,
            "result": self.job.result,
            "finished_at": self.job.finished_at,
            "history_coins": len(self._series),
            "history_days": self._history_days,
        }

    def start(self, params: BacktestParams, snapshots: list[FundingSnapshot]) -> bool:
        if self._task and not self._task.done():
            return False
        # Mark running before the task starts so the first status poll is accurate.
        self.job = BacktestJob(status="running", params=params.__dict__.copy(), message="Finding Binance and Delta pairs")
        self._task = asyncio.create_task(self._run(params, snapshots))
        return True

    def resimulate(self, params: BacktestParams) -> dict | None:
        """Instant re-run with new costs on already-downloaded history."""
        if not self._series:
            return None
        end = int(datetime.now(timezone.utc).timestamp())
        start = end - params.days * 86400
        return simulate(list(self._series.values()), params, start, end)

    def series(self) -> list[CoinSeries]:
        return list(self._series.values())

    @property
    def history_days(self) -> int:
        return self._history_days

    async def load_series(self, snapshots: list[FundingSnapshot], start: int, end: int, on_progress=None) -> list[CoinSeries]:
        """Settled history from `start` for every coin listed on both Binance and Delta, through the cache."""
        binance = {s.canonical_symbol: s for s in snapshots if s.exchange == "binance"}
        delta = {s.canonical_symbol: s for s in snapshots if s.exchange == "delta"}
        pairs = sorted(set(binance) & set(delta))
        semaphore = asyncio.Semaphore(4)
        done = 0

        async def load(symbol: str) -> CoinSeries | None:
            nonlocal done
            async with semaphore:
                try:
                    b = await self._binance_history(binance[symbol].exchange_symbol, start)
                    d = await self._delta_history(delta[symbol].exchange_symbol, delta[symbol].funding_interval_hours, start, end)
                except Exception:
                    logger.warning("Funding history failed for %s", symbol, exc_info=True)
                    return None
                finally:
                    done += 1
                    if on_progress:
                        on_progress(done, len(pairs))
                if not b or not d:
                    return None
                return CoinSeries(symbol, binance[symbol].base_asset, b, d)

        return [item for item in await asyncio.gather(*(load(symbol) for symbol in pairs)) if item]

    async def _run(self, params: BacktestParams, snapshots: list[FundingSnapshot]) -> None:
        try:
            end = int(datetime.now(timezone.utc).timestamp())
            start = end - params.days * 86400

            def progress(done: int, total: int) -> None:
                self.job.progress, self.job.total = done, total
                self.job.message = f"Downloaded {done} of {total} coins"

            loaded = await self.load_series(snapshots, start, end, progress)
            self._series = {item.canonical_symbol: item for item in loaded}
            self._history_days = params.days
            self.job.result = simulate(loaded, params, start, end)
            self.job.status = "done"
            self.job.message = f"Replayed {len(loaded)} coins"
            self.job.finished_at = datetime.now(timezone.utc).isoformat()
        except Exception as exc:  # pragma: no cover
            logger.exception("Backtest failed")
            self.job.status = "error"
            self.job.message = str(exc)

    async def _binance_history(self, symbol: str, start: int) -> dict[int, float]:
        fetch_from = await asyncio.to_thread(self.cache.fetch_from, "binance", symbol, start)
        rows: dict[int, float] = {}
        cursor = fetch_from * 1000
        while True:
            response = await self.client.get(
                "https://fapi.binance.com/fapi/v1/fundingRate",
                params={"symbol": symbol, "startTime": cursor, "limit": 1000},
                timeout=20.0,
            )
            response.raise_for_status()
            batch = response.json()
            for item in batch:
                # Funding times can carry a few stray milliseconds; snap to the second.
                rows[int(round(int(item["fundingTime"]) / 1000))] = float(item["fundingRate"])
            if len(batch) < 1000:
                break
            cursor = int(batch[-1]["fundingTime"]) + 1
        if rows:
            await asyncio.to_thread(self.cache.save, "binance", symbol, rows)
        return await asyncio.to_thread(self.cache.load, "binance", symbol, start)

    async def _delta_history(self, symbol: str, interval_hours: int, start: int, end: int) -> dict[int, float]:
        fetch_from = await asyncio.to_thread(self.cache.fetch_from, "delta", symbol, start)
        step = max(interval_hours, 1) * 3600
        rows: dict[int, float] = {}
        chunk = 1500 * 3600
        cursor = fetch_from - fetch_from % 3600
        while cursor < end:
            response = await self.client.get(
                "https://api.india.delta.exchange/v2/history/candles",
                params={"resolution": "1h", "symbol": f"FUNDING:{symbol}", "start": cursor, "end": min(cursor + chunk, end)},
                timeout=20.0,
            )
            response.raise_for_status()
            for candle in response.json().get("result") or []:
                moment = int(candle["time"])
                # Delta settles on interval boundaries; the candle at that hour holds the settled rate (in %).
                if moment % step == 0:
                    rows[moment] = float(candle["close"]) / 100
            cursor += chunk
            await asyncio.sleep(0.2)
        if rows:
            await asyncio.to_thread(self.cache.save, "delta", symbol, rows)
        return await asyncio.to_thread(self.cache.load, "delta", symbol, start)
