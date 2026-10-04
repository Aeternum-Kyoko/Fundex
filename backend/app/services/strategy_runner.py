"""The strategy bot: runs the Strategy lab's carry rules on live settled funding and trades them on paper.

Once an hour it refreshes settled history for every Binance/Delta coin through the backtest's cache, computes the
same signal as the replay, credits settled funding to open positions, then applies `decide`: close the pairs whose
spread faded, open the strongest new ones. The decision code is the one the replay is tested against, so paper
results are directly comparable to the backtest.

With predicted rates on (the default), the check runs a few minutes BEFORE the hour and adds each exchange's
predicted rate for the coming settlement to the signal, so a big payment is caught and a bad one avoided. Every
prediction is stored and later scored against the settled rate, so the edge this relies on is measured, not assumed.

Turning the bot off stops new entries only: open positions keep collecting funding and still close on the exit
rule (or by hand), so nothing is ever left unmanaged.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import sqlite3
from collections import deque
from dataclasses import asdict, dataclass, field, replace
from datetime import datetime, timedelta, timezone
from pathlib import Path

from app.services.backtest import CoinSeries, cost_percent
from app.services.strategy import StrategyParams, build_events, decide, latest_signals

logger = logging.getLogger(__name__)

BOT_ID = "carry-bot"
AFTER_SETTLEMENT_SECONDS = 120  # settled-only mode: the exchanges have published the settlement by then
BEFORE_SETTLEMENT_SECONDS = 240  # predicted mode: room for maker orders to rest before the hour
PREDICTION_HORIZON_SECONDS = 600  # predicted rates for settlements this close are used
WALL_CLOCK_STEP_SECONDS = 5.0
RETRY_SECONDS = 60  # a failed check (feeds still loading after a restart, a network blip) retries soon, not next hour
EXACT_PREDICTION = 1e-7  # 0.00001%: the prediction was the settled rate
CLOSE_PREDICTION = 5e-5  # 0.005%


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def next_tick_after(now: datetime, before_settlement: bool = False) -> datetime:
    hour = now.replace(minute=0, second=0, microsecond=0)
    offset = timedelta(hours=1) - timedelta(seconds=BEFORE_SETTLEMENT_SECONDS) if before_settlement else timedelta(seconds=AFTER_SETTLEMENT_SECONDS)
    candidate = hour + offset
    return candidate if candidate > now else candidate + timedelta(hours=1)


def upcoming_predictions(snapshots, now: int, horizon: int = PREDICTION_HORIZON_SECONDS) -> dict[tuple[str, str], tuple[int, float]]:
    """(exchange, canonical symbol) -> (settles at, predicted rate) for Binance/Delta settlements due within `horizon`."""
    found: dict[tuple[str, str], tuple[int, float]] = {}
    for snapshot in snapshots:
        if snapshot.exchange not in ("binance", "delta") or snapshot.next_funding_time is None:
            continue
        moment = int(round(snapshot.next_funding_time.timestamp()))
        if now < moment <= now + horizon:
            found[(snapshot.exchange, snapshot.canonical_symbol)] = (moment, snapshot.funding_rate)
    return found


def with_predictions(series: list[CoinSeries], predictions: dict[tuple[str, str], tuple[int, float]]) -> list[CoinSeries]:
    """Copies of `series` with each predicted settlement appended, as if it had already settled at that rate."""
    out = []
    for coin in series:
        legs = {"binance": dict(coin.binance), "delta": dict(coin.delta)}
        for exchange, rates in legs.items():
            item = predictions.get((exchange, coin.canonical_symbol))
            if item and item[0] > max(rates, default=0):
                rates[item[0]] = item[1]
        out.append(CoinSeries(coin.canonical_symbol, coin.base_asset, legs["binance"], legs["delta"]))
    return out


@dataclass
class BotConfig:
    enabled: bool = False
    mode: str = "paper"
    leverage: float = 2.0
    params: StrategyParams = field(default_factory=lambda: StrategyParams(use_predicted=True))
    execution: str = "maker_first"  # or "taker"
    maker_wait_seconds: float = 30.0

    def to_dict(self) -> dict:
        return {
            "enabled": self.enabled,
            "mode": self.mode,
            "leverage": self.leverage,
            "params": asdict(self.params),
            "execution": self.execution,
            "maker_wait_seconds": self.maker_wait_seconds,
        }

    @classmethod
    def from_dict(cls, payload: dict) -> "BotConfig":
        known = StrategyParams.__dataclass_fields__
        params = StrategyParams(**{key: value for key, value in (payload.get("params") or {}).items() if key in known})
        return cls(
            enabled=bool(payload.get("enabled")),
            mode=payload.get("mode", "paper"),
            leverage=float(payload.get("leverage", 2.0)),
            params=params,
            execution=payload.get("execution", "taker"),  # bots saved before maker-first existed keep crossing
            maker_wait_seconds=float(payload.get("maker_wait_seconds", 30.0)),
        )


class StrategyRunner:
    def __init__(self, backtest, trade_manager, market_store, database_path: Path) -> None:
        self.backtest = backtest
        self.trade_manager = trade_manager
        self.market_store = market_store
        self.database_path = database_path
        self.config = BotConfig()
        self.log: deque[dict] = deque(maxlen=80)
        self.last_tick_at: datetime | None = None
        self.next_tick_at: datetime | None = None
        self.last_error: str | None = None
        self.coins_tracked = 0
        self.signals: dict[str, float] = {}
        self.predicted_coins = 0
        self._task: asyncio.Task | None = None
        self._wake = asyncio.Event()
        self._tick_lock = asyncio.Lock()
        with sqlite3.connect(database_path) as connection:
            connection.execute("CREATE TABLE IF NOT EXISTS strategy_bot (id TEXT PRIMARY KEY, payload TEXT NOT NULL)")
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS strategy_predictions (
                    exchange TEXT NOT NULL,
                    canonical_symbol TEXT NOT NULL,
                    settles_at INTEGER NOT NULL,
                    predicted REAL NOT NULL,
                    actual REAL,
                    PRIMARY KEY (exchange, canonical_symbol, settles_at)
                )
                """
            )

    # ---------- lifecycle ----------

    async def start(self) -> None:
        self.config = await asyncio.to_thread(self._load_config)
        self._task = asyncio.create_task(self._loop(), name="strategy-bot")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    def _load_config(self) -> BotConfig:
        with sqlite3.connect(self.database_path) as connection:
            row = connection.execute("SELECT payload FROM strategy_bot WHERE id = ?", (BOT_ID,)).fetchone()
        try:
            return BotConfig.from_dict(json.loads(row[0])) if row else BotConfig()
        except Exception:  # noqa: BLE001
            logger.warning("Strategy bot config unreadable; starting switched off", exc_info=True)
            return BotConfig()

    def _save_config(self) -> None:
        with sqlite3.connect(self.database_path) as connection:
            connection.execute(
                "INSERT INTO strategy_bot (id, payload) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload",
                (BOT_ID, json.dumps(self.config.to_dict())),
            )

    async def configure(
        self,
        *,
        enabled: bool,
        mode: str,
        leverage: float,
        params: StrategyParams,
        execution: str = "maker_first",
        maker_wait_seconds: float = 30.0,
    ) -> None:
        if mode != "paper":
            raise ValueError("Automatic live trading is a later stage; the bot trades on paper for now.")
        if execution not in ("maker_first", "taker"):
            raise ValueError("Execution must be maker_first or taker.")
        was_enabled = self.config.enabled
        self.config = BotConfig(enabled=enabled, mode=mode, leverage=leverage, params=params, execution=execution, maker_wait_seconds=maker_wait_seconds)
        await asyncio.to_thread(self._save_config)
        # The loop re-reads this while waiting, so switching between settled and predicted timing applies at once.
        self.next_tick_at = next_tick_after(_utcnow(), params.use_predicted)
        if enabled and not was_enabled:
            self._note("start", f"Started on paper: enter at {params.entry_apr_percent:g}% a year, exit below {params.exit_apr_percent:g}%, up to {params.max_positions} pairs of ${params.notional_usd:,.0f}.")
            self._wake.set()  # first decisions now, not at the next hour
        elif was_enabled and not enabled:
            self._note("stop", "Stopped opening new positions. Open ones keep collecting funding and still close on the exit rule.")
        elif enabled:
            self._note("config", "Rules updated; they apply from the next check.")

    async def _loop(self) -> None:
        while True:
            failed = False
            try:
                if self.config.enabled or await self.trade_manager.open_carry_positions(BOT_ID):
                    await self.tick()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                logger.warning("Strategy bot check failed; retrying in %ss: %s", RETRY_SECONDS, exc)
                self.last_error = str(exc)
                failed = True
            self.next_tick_at = (
                _utcnow() + timedelta(seconds=RETRY_SECONDS) if failed else next_tick_after(_utcnow(), self.config.params.use_predicted)
            )
            self._wake.clear()
            # Wall-clock steps: a laptop that sleeps must not wake hours late on one long monotonic sleep.
            while _utcnow() < self.next_tick_at and not self._wake.is_set():
                try:
                    await asyncio.wait_for(self._wake.wait(), timeout=WALL_CLOCK_STEP_SECONDS)
                except asyncio.TimeoutError:
                    pass

    def wake(self) -> None:
        self._wake.set()

    def _note(self, kind: str, message: str, coin: str | None = None) -> None:
        self.log.appendleft({"at": _utcnow().isoformat(), "kind": kind, "coin": coin, "message": message})

    # ---------- one decision round ----------

    async def tick(self) -> dict:
        async with self._tick_lock:
            config = self.config
            params = config.params
            now_dt = _utcnow()
            now = int(now_dt.timestamp())
            # Enough history for the lookback even on 8h coins, plus slack.
            window_days = math.ceil(params.lookback * 8 / 24) + 2
            snapshots = await self.market_store.get_snapshots()
            if not {"binance", "delta"} <= {snapshot.exchange for snapshot in snapshots}:
                raise RuntimeError("Waiting for Binance and Delta market data (the feeds are still loading).")
            series = await self.backtest.load_series(snapshots, now - window_days * 86400, now)
            if not series:
                raise RuntimeError("No Binance/Delta funding history could be loaded.")
            by_symbol = {coin.canonical_symbol: coin for coin in series}
            await asyncio.to_thread(self._score_predictions, by_symbol, now)

            predictions = upcoming_predictions(snapshots, now) if params.use_predicted else {}
            predictions = {key: value for key, value in predictions.items() if key[1] in by_symbol}
            if predictions:
                await asyncio.to_thread(self._record_predictions, predictions)
            decision_series = with_predictions(series, predictions) if predictions else series
            events = build_events(decision_series, params.lookback)
            signals = latest_signals(events, decision_series, now + (PREDICTION_HORIZON_SECONDS if predictions else 0))
            self.coins_tracked = len(series)
            self.predicted_coins = len({symbol for _, symbol in predictions})
            self.signals = signals

            # Funding is only ever credited from settled rates, never predictions.
            positions = await self.trade_manager.open_carry_positions(BOT_ID)
            credited = 0.0
            for position in positions:
                coin = by_symbol.get(position.canonical_symbol)
                if coin is None:
                    continue
                opened = int(position.created_at.timestamp())
                payments = [
                    (exchange, datetime.fromtimestamp(moment, timezone.utc), rate)
                    for exchange, rates in (("binance", coin.binance), ("delta", coin.delta))
                    for moment, rate in rates.items()
                    if opened < moment <= now
                ]
                credited += await self.trade_manager.credit_carry_funding(position.id, payments)

            held = {position.canonical_symbol: 1 if position.long_leg.exchange == "delta" else -1 for position in positions}
            exits, _ = decide(held, signals, params)
            leaving = [position for position in positions if position.canonical_symbol in exits]

            async def close(position) -> None:
                signal = signals[position.canonical_symbol]
                side = held[position.canonical_symbol]
                basis = "predicted" if (("binance", position.canonical_symbol) in predictions or ("delta", position.canonical_symbol) in predictions) else "settled"
                why = (
                    f"the {basis} spread flipped"
                    if side * signal < 0
                    else f"the {basis} spread fell to {side * signal:.0f}% a year, below the exit level of {params.exit_apr_percent:g}%"
                )
                result = await self.trade_manager.close_carry(position.id, why, config.execution, config.maker_wait_seconds)
                self._note("exit", f"Closed {_base(position.canonical_symbol)}: {why}. Net {result.realized_net_pnl_usd:+.2f} USD.", _base(position.canonical_symbol))

            # Legs and coins go out together so maker orders can rest without running past the settlement.
            await asyncio.gather(*(close(position) for position in leaving))

            opened_count = 0
            if config.enabled:
                remaining = {coin: side for coin, side in held.items() if coin not in exits}
                free = params.max_positions - len(remaining)
                # Rank every qualifying coin, so a book too thin to fill hands its slot to the next one.
                _, ranked = decide(remaining, signals, replace(params, max_positions=len(remaining) + len(signals)))

                async def open_one(coin: str, side: int, strength: float) -> bool:
                    try:
                        await self.trade_manager.open_carry(
                            canonical_symbol=coin,
                            long_exchange="delta" if side > 0 else "binance",
                            short_exchange="binance" if side > 0 else "delta",
                            notional_usd=params.notional_usd,
                            leverage=config.leverage,
                            signal_apr=strength,
                            opened_by=BOT_ID,
                            mode=config.mode,  # type: ignore[arg-type]
                            execution=config.execution,
                            maker_wait_seconds=config.maker_wait_seconds,
                        )
                    except Exception as exc:  # noqa: BLE001
                        detail = getattr(exc, "detail", None) or str(exc)
                        self._note("skip", f"Skipped {_base(coin)}: {detail}", _base(coin))
                        return False
                    direction = "long Delta, short Binance" if side > 0 else "long Binance, short Delta"
                    self._note("entry", f"Opened {_base(coin)} ({direction}) at a {strength:.0f}% a year spread.", _base(coin))
                    return True

                cursor = 0
                while opened_count < free and cursor < len(ranked):
                    batch = ranked[cursor : cursor + free - opened_count]
                    cursor += len(batch)
                    opened_count += sum(await asyncio.gather(*(open_one(*candidate) for candidate in batch)))

            self.last_tick_at = _utcnow()
            self.last_error = None
            summary = {
                "coins": len(series),
                "signals": len(signals),
                "predicted": self.predicted_coins,
                "credited_usd": credited,
                "closed": len(leaving),
                "opened": opened_count,
            }
            if leaving or opened_count or credited:
                self._note(
                    "check",
                    f"Checked {len(series)} coins ({self.predicted_coins} with a predicted rate): opened {opened_count}, closed {len(leaving)}, funding credited {credited:+.2f} USD.",
                )
            return summary

    # ---------- prediction scoring ----------

    def _record_predictions(self, predictions: dict[tuple[str, str], tuple[int, float]]) -> None:
        with sqlite3.connect(self.database_path) as connection:
            # The latest prediction before a settlement wins.
            connection.executemany(
                """
                INSERT INTO strategy_predictions (exchange, canonical_symbol, settles_at, predicted) VALUES (?, ?, ?, ?)
                ON CONFLICT(exchange, canonical_symbol, settles_at) DO UPDATE SET predicted = excluded.predicted
                """,
                [(exchange, symbol, moment, rate) for (exchange, symbol), (moment, rate) in predictions.items()],
            )

    def _score_predictions(self, by_symbol: dict[str, CoinSeries], now: int) -> None:
        with sqlite3.connect(self.database_path) as connection:
            pending = connection.execute(
                "SELECT exchange, canonical_symbol, settles_at FROM strategy_predictions WHERE actual IS NULL AND settles_at <= ?", (now,)
            ).fetchall()
            updates = []
            for exchange, symbol, moment in pending:
                coin = by_symbol.get(symbol)
                rate = (coin.binance if exchange == "binance" else coin.delta).get(moment) if coin else None
                if rate is not None:
                    updates.append((rate, exchange, symbol, moment))
            connection.executemany("UPDATE strategy_predictions SET actual = ? WHERE exchange = ? AND canonical_symbol = ? AND settles_at = ?", updates)

    def prediction_stats(self, days: int = 7) -> dict:
        since = int(_utcnow().timestamp()) - days * 86400
        with sqlite3.connect(self.database_path) as connection:
            rows = connection.execute(
                "SELECT exchange, predicted, actual FROM strategy_predictions WHERE actual IS NOT NULL AND settles_at >= ?", (since,)
            ).fetchall()
            waiting = connection.execute("SELECT COUNT(*) FROM strategy_predictions WHERE actual IS NULL").fetchone()[0]

        def summarise(items: list[tuple[str, float, float]]) -> dict:
            if not items:
                return {"checked": 0}
            errors = [abs(predicted - actual) for _, predicted, actual in items]
            signed = [(predicted, actual) for _, predicted, actual in items if abs(actual) >= 1e-5]
            return {
                "checked": len(items),
                "exact_share": sum(1 for error in errors if error <= EXACT_PREDICTION) / len(items),
                "close_share": sum(1 for error in errors if error <= CLOSE_PREDICTION) / len(items),
                "mean_error_percent": sum(errors) / len(errors) * 100,
                "right_side_share": sum(1 for predicted, actual in signed if predicted * actual > 0) / len(signed) if signed else None,
            }

        return {
            "days": days,
            "waiting": waiting,
            "all": summarise(rows),
            "binance": summarise([row for row in rows if row[0] == "binance"]),
            "delta": summarise([row for row in rows if row[0] == "delta"]),
        }

    # ---------- what the page shows ----------

    async def state(self) -> dict:
        positions = await self.trade_manager.open_carry_positions(BOT_ID)
        journal = await self.trade_manager.list_journal(limit=2000, mode="paper")
        closed = [item for item in journal if item.opened_by == BOT_ID and item.status == "completed"]
        open_rows = []
        for position in sorted(positions, key=lambda item: item.created_at, reverse=True):
            side = 1 if position.long_leg.exchange == "delta" else -1
            signal = self.signals.get(position.canonical_symbol)
            open_rows.append(
                {
                    "id": position.id,
                    "coin": _base(position.canonical_symbol),
                    "canonical_symbol": position.canonical_symbol,
                    "direction": "long Delta, short Binance" if side > 0 else "long Binance, short Delta",
                    "opened_at": position.created_at.isoformat(),
                    "entry_signal_apr": position.entry_signal_apr,
                    "current_signal_apr": side * signal if signal is not None else None,
                    "settlements": len(position.funding_legs),
                    "funding_usd": position.realized_funding_pnl_usd or 0.0,
                    "fees_usd": position.realized_total_fees_usd or 0.0,
                    "net_usd": position.realized_net_pnl_usd or 0.0,
                    "notional_usd": position.long_leg.notional_usd,
                }
            )
        top = sorted(self.signals.items(), key=lambda item: -abs(item[1]))[:8]
        params = self.config.params
        # Paper reality vs the lab's flat assumptions, per round trip on closed positions.
        assumed_cost = cost_percent(params.binance_taker_bps, params.delta_taker_bps, params.slippage_percent_per_leg) / 100 * params.notional_usd
        measured = [item for item in closed if item.realized_total_fees_usd is not None]
        fills = [
            (raw or {}).get("note", "")
            for item in [*closed, *positions]
            for leg in (item.long_leg, item.short_leg)
            for raw in (leg.raw_entry_response, leg.raw_exit_response)
            if raw
        ]
        reality = {
            "trades": len(measured),
            "assumed_cost_usd": assumed_cost,
            "fees_usd": sum(item.realized_total_fees_usd or 0.0 for item in measured) / len(measured) if measured else None,
            "slippage_usd": sum(item.realized_slippage_usd or 0.0 for item in measured) / len(measured) if measured else None,
            "price_drift_usd": sum(item.realized_price_pnl_usd or 0.0 for item in measured) / len(measured) if measured else None,
            "maker_fill_share": sum(1 for note in fills if "(maker)" in note) / len(fills) if fills else None,
        }
        return {
            "config": self.config.to_dict(),
            "last_tick_at": self.last_tick_at.isoformat() if self.last_tick_at else None,
            "next_tick_at": self.next_tick_at.isoformat() if self.next_tick_at else None,
            "last_error": self.last_error,
            "coins_tracked": self.coins_tracked,
            "predicted_coins": self.predicted_coins,
            "predictions": await asyncio.to_thread(self.prediction_stats),
            "reality": reality,
            "top_signals": [{"coin": _base(symbol), "signal_apr": value} for symbol, value in top],
            "positions": open_rows,
            "totals": {
                "open_count": len(open_rows),
                "open_net_usd": sum(row["net_usd"] for row in open_rows),
                "open_funding_usd": sum(row["funding_usd"] for row in open_rows),
                "closed_count": len(closed),
                "closed_net_usd": sum(item.realized_net_pnl_usd or 0.0 for item in closed),
                "closed_wins": sum(1 for item in closed if (item.realized_net_pnl_usd or 0.0) > 0),
                "first_trade_at": min((item.created_at for item in [*closed, *positions]), default=None),
            },
            "recent_closed": [
                {
                    "id": item.id,
                    "coin": _base(item.canonical_symbol),
                    "opened_at": item.created_at.isoformat(),
                    "closed_at": (item.scheduled_exit_at or item.updated_at).isoformat(),
                    "settlements": len(item.funding_legs),
                    "net_usd": item.realized_net_pnl_usd or 0.0,
                    "reason": item.exit_reason,
                }
                for item in closed[:12]
            ],
            "log": list(self.log)[:30],
        }


def _base(canonical_symbol: str) -> str:
    return canonical_symbol.split("-")[0]
