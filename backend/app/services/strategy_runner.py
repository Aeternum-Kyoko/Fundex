"""The strategy bot: runs the Strategy lab's carry rules on live settled funding and trades them on paper.

Shortly after every hour (when settlements have landed) it refreshes settled history for every Binance/Delta coin
through the backtest's cache, computes the same signal as the replay, credits settled funding to open positions,
then applies `decide`: close the pairs whose spread faded, open the strongest new ones. The decision code is the
one the replay is tested against, so paper results are directly comparable to the backtest.

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

from app.services.strategy import StrategyParams, build_events, decide, latest_signals

logger = logging.getLogger(__name__)

BOT_ID = "carry-bot"
TICK_OFFSET_SECONDS = 120  # after the hour, so the exchanges have published the settlement
WALL_CLOCK_STEP_SECONDS = 5.0


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def next_tick_after(now: datetime) -> datetime:
    hour = now.replace(minute=0, second=0, microsecond=0)
    candidate = hour + timedelta(seconds=TICK_OFFSET_SECONDS)
    return candidate if candidate > now else candidate + timedelta(hours=1)


@dataclass
class BotConfig:
    enabled: bool = False
    mode: str = "paper"
    leverage: float = 2.0
    params: StrategyParams = field(default_factory=StrategyParams)

    def to_dict(self) -> dict:
        return {"enabled": self.enabled, "mode": self.mode, "leverage": self.leverage, "params": asdict(self.params)}

    @classmethod
    def from_dict(cls, payload: dict) -> "BotConfig":
        known = StrategyParams.__dataclass_fields__
        params = StrategyParams(**{key: value for key, value in (payload.get("params") or {}).items() if key in known})
        return cls(enabled=bool(payload.get("enabled")), mode=payload.get("mode", "paper"), leverage=float(payload.get("leverage", 2.0)), params=params)


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
        self._task: asyncio.Task | None = None
        self._wake = asyncio.Event()
        self._tick_lock = asyncio.Lock()
        with sqlite3.connect(database_path) as connection:
            connection.execute("CREATE TABLE IF NOT EXISTS strategy_bot (id TEXT PRIMARY KEY, payload TEXT NOT NULL)")

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

    async def configure(self, *, enabled: bool, mode: str, leverage: float, params: StrategyParams) -> None:
        if mode != "paper":
            raise ValueError("Automatic live trading is a later stage; the bot trades on paper for now.")
        was_enabled = self.config.enabled
        self.config = BotConfig(enabled=enabled, mode=mode, leverage=leverage, params=params)
        await asyncio.to_thread(self._save_config)
        if enabled and not was_enabled:
            self._note("start", f"Started on paper: enter at {params.entry_apr_percent:g}% a year, exit below {params.exit_apr_percent:g}%, up to {params.max_positions} pairs of ${params.notional_usd:,.0f}.")
            self._wake.set()  # first decisions now, not at the next hour
        elif was_enabled and not enabled:
            self._note("stop", "Stopped opening new positions. Open ones keep collecting funding and still close on the exit rule.")
        elif enabled:
            self._note("config", "Rules updated; they apply from the next check.")

    async def _loop(self) -> None:
        while True:
            try:
                if self.config.enabled or await self.trade_manager.open_carry_positions(BOT_ID):
                    await self.tick()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                logger.exception("Strategy bot tick failed")
                self.last_error = str(exc)
            self.next_tick_at = next_tick_after(_utcnow())
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
            series = await self.backtest.load_series(snapshots, now - window_days * 86400, now)
            if not series:
                raise RuntimeError("No Binance/Delta funding history could be loaded.")
            events = build_events(series, params.lookback)
            signals = latest_signals(events, series, now)
            by_symbol = {coin.canonical_symbol: coin for coin in series}
            self.coins_tracked = len(series)
            self.signals = signals

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
            closed = 0
            for position in positions:
                if position.canonical_symbol not in exits:
                    continue
                signal = signals[position.canonical_symbol]
                side = held[position.canonical_symbol]
                why = "the spread flipped" if side * signal < 0 else f"the spread fell to {side * signal:.0f}% a year, below the exit level of {params.exit_apr_percent:g}%"
                result = await self.trade_manager.close_carry(position.id, why)
                closed += 1
                self._note("exit", f"Closed {_base(position.canonical_symbol)}: {why}. Net {result.realized_net_pnl_usd:+.2f} USD.", _base(position.canonical_symbol))

            opened_count = 0
            if config.enabled:
                remaining = {coin: side for coin, side in held.items() if coin not in exits}
                free = params.max_positions - len(remaining)
                # Rank every qualifying coin, so a book too thin to fill hands its slot to the next one.
                _, ranked = decide(remaining, signals, replace(params, max_positions=len(remaining) + len(signals)))
                for coin, side, strength in ranked:
                    if opened_count >= free:
                        break
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
                        )
                    except Exception as exc:  # noqa: BLE001
                        detail = getattr(exc, "detail", None) or str(exc)
                        self._note("skip", f"Skipped {_base(coin)}: {detail}", _base(coin))
                        continue
                    opened_count += 1
                    direction = "long Delta, short Binance" if side > 0 else "long Binance, short Delta"
                    self._note("entry", f"Opened {_base(coin)} ({direction}) at a {strength:.0f}% a year spread.", _base(coin))

            self.last_tick_at = _utcnow()
            self.last_error = None
            summary = {"coins": len(series), "signals": len(signals), "credited_usd": credited, "closed": closed, "opened": opened_count}
            if closed or opened_count or credited:
                self._note("check", f"Checked {len(series)} coins: opened {opened_count}, closed {closed}, funding credited {credited:+.2f} USD.")
            return summary

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
        return {
            "config": self.config.to_dict(),
            "last_tick_at": self.last_tick_at.isoformat() if self.last_tick_at else None,
            "next_tick_at": self.next_tick_at.isoformat() if self.next_tick_at else None,
            "last_error": self.last_error,
            "coins_tracked": self.coins_tracked,
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
