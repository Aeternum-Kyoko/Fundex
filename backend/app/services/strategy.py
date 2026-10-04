"""Strategy lab: a rule-based carry algorithm replayed over the settled funding history the backtest downloads.

The snipe replay (backtest.simulate) pays four taker fills for every settlement it catches. Carry instead holds the
hedged pair (long one exchange, short the other) for as long as the funding spread stays in its favour, so the costs
are paid once per position while funding is collected at every settlement in between.

No look-ahead: the signal at a moment uses only rates that have settled by then, a position opened at a moment
collects from the next settlement onwards, and one closed at a moment has already been paid that moment's funding.
Positions still open at the end of the window are charged their exit cost.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime, timezone

from app.services.backtest import BacktestParams, CoinSeries, cost_percent, simulate

ENTRY_GRID_APR = [25.0, 50.0, 100.0, 150.0, 200.0, 300.0, 400.0]
EXIT_GRID_APR = [-25.0, 0.0, 25.0, 50.0, 100.0]
TRAIN_SHARE = 2 / 3
LONG_DELTA = "long Delta, short Binance"
LONG_BINANCE = "long Binance, short Delta"


@dataclass
class StrategyParams:
    days: int = 30
    notional_usd: float = 1000.0
    binance_taker_bps: float = 5.0
    delta_taker_bps: float = 5.0
    slippage_percent_per_leg: float = 0.1
    lookback: int = 3  # settlements per leg averaged into the signal
    entry_apr_percent: float = 20.0  # open when the expected spread is at least this, annualised
    exit_apr_percent: float = 5.0  # close when it falls below this in the held direction
    max_positions: int = 5


@dataclass
class Event:
    moment: int
    coin: int
    binance: float | None
    delta: float | None
    signal_apr: float | None  # expected carry for long Delta / short Binance, % a year; None until both legs are known


def build_events(series: list[CoinSeries], lookback: int) -> list[Event]:
    """Every settlement of every coin, in time order, with the signal as it stood right after it."""
    events: list[Event] = []
    for index, coin in enumerate(series):
        recent = {"binance": [], "delta": []}  # per leg: recent rates
        daily = {"binance": None, "delta": None}  # per leg: expected funding per day (fraction)
        last = {"binance": None, "delta": None}
        for moment in sorted(set(coin.binance) | set(coin.delta)):
            rates = {"binance": coin.binance.get(moment), "delta": coin.delta.get(moment)}
            for leg, rate in rates.items():
                if rate is None:
                    continue
                recent[leg] = (recent[leg] + [rate])[-max(lookback, 1) :]
                if last[leg] is not None:
                    # Intervals change (Binance moves coins from 8h to 4h or 1h), so read it off the last gap.
                    interval_hours = min(max((moment - last[leg]) / 3600, 1.0), 8.0)
                    daily[leg] = sum(recent[leg]) / len(recent[leg]) * 24 / interval_hours
                last[leg] = moment
            signal = None
            if daily["binance"] is not None and daily["delta"] is not None:
                # Short Binance receives its rate, long Delta pays its rate.
                signal = (daily["binance"] - daily["delta"]) * 365 * 100
            events.append(Event(moment, index, rates["binance"], rates["delta"], signal))
    events.sort(key=lambda event: (event.moment, event.coin))
    return events


def latest_signals(events: list[Event], series: list[CoinSeries], now: int, max_age_hours: float = 9.0) -> dict[str, float]:
    """Each coin's signal as of its most recent settlement, keyed by canonical symbol. Stale coins are left out."""
    signals: dict[str, tuple[int, float]] = {}
    for event in events:
        if event.signal_apr is not None and event.moment <= now:
            signals[series[event.coin].canonical_symbol] = (event.moment, event.signal_apr)
    return {symbol: signal for symbol, (moment, signal) in signals.items() if now - moment <= max_age_hours * 3600}


def decide(held: dict[str, int], signals: dict[str, float], params: StrategyParams) -> tuple[list[str], list[tuple[str, int, float]]]:
    """The carry rules for one moment, shared by the live bot and checked against the replay.

    held: coin -> side (+1 long Delta / short Binance, -1 the reverse). signals: coin -> expected carry, % a year.
    Returns (coins to close, [(coin, side, |signal|) to open]), strongest spreads first.
    """
    exits = [coin for coin, side in held.items() if coin in signals and side * signals[coin] < params.exit_apr_percent]
    remaining = {coin for coin in held if coin not in exits}
    free = params.max_positions - len(remaining)
    if free <= 0:
        return exits, []
    # A coin closed on a flip can reopen on the other side straight away, as in the replay.
    candidates = sorted(
        (coin for coin, signal in signals.items() if abs(signal) >= params.entry_apr_percent and coin not in remaining),
        key=lambda coin: -abs(signals[coin]),
    )
    return exits, [(coin, 1 if signals[coin] > 0 else -1, abs(signals[coin])) for coin in candidates[:free]]


def _day(moment: int) -> str:
    return datetime.fromtimestamp(moment, timezone.utc).strftime("%Y-%m-%d")


def run_carry(series: list[CoinSeries], events: list[Event], params: StrategyParams, start: int, end: int, detail: bool = True) -> dict:
    """Replay the carry rules over [start, end]. With detail=False only the totals are returned (for the optimizer)."""
    half_cost = cost_percent(params.binance_taker_bps, params.delta_taker_bps, params.slippage_percent_per_leg) / 2 / 100
    notional = params.notional_usd
    held: dict[int, dict] = {}
    qualifying: dict[int, float] = {}
    closed: list[dict] = []
    daily: dict[str, float] = {}
    funding_total = 0.0
    cost_total = 0.0
    slot_seconds = 0.0
    previous_moment = start

    def book(moment: int, usd: float) -> None:
        if detail:
            day = _day(moment)
            daily[day] = daily.get(day, 0.0) + usd

    def close(coin: int, moment: int, open_at_end: bool = False) -> None:
        nonlocal cost_total
        position = held.pop(coin)
        cost_total += half_cost * notional
        book(moment, -half_cost * notional)
        closed.append({**position, "exited": moment, "open_at_end": open_at_end})

    index = 0
    total = len(events)
    while index < total:
        moment = events[index].moment
        group_end = index
        while group_end < total and events[group_end].moment == moment:
            group_end += 1
        group = events[index:group_end]
        index = group_end
        if moment > end:
            break

        # Signals keep warming up before the window opens; nothing is traded or paid there.
        in_window = moment >= start
        if in_window:
            slot_seconds += len(held) * (moment - previous_moment)
            previous_moment = moment

        # 1. Held positions collect this settlement.
        if in_window:
            for event in group:
                position = held.get(event.coin)
                if position is None:
                    continue
                side = position["side"]
                paid = (side * event.binance if event.binance is not None else 0.0) - (side * event.delta if event.delta is not None else 0.0)
                usd = paid * notional
                position["funding_usd"] += usd
                position["settlements"] += 1
                funding_total += usd
                book(moment, usd)

        # 2. Update what the signal now says.
        changed = []
        for event in group:
            if event.signal_apr is None:
                continue
            changed.append(event)
            if abs(event.signal_apr) >= params.entry_apr_percent:
                qualifying[event.coin] = event.signal_apr
            else:
                qualifying.pop(event.coin, None)
        if not in_window:
            continue

        # 3. Exit positions whose spread has faded (or flipped).
        for event in changed:
            position = held.get(event.coin)
            if position is not None and position["side"] * event.signal_apr < params.exit_apr_percent:
                close(event.coin, moment)

        # 4. Fill free slots with the strongest spreads.
        free = params.max_positions - len(held)
        if free > 0 and qualifying:
            candidates = sorted((coin for coin in qualifying if coin not in held), key=lambda coin: -abs(qualifying[coin]))
            for coin in candidates[:free]:
                signal = qualifying[coin]
                held[coin] = {
                    "coin": coin,
                    "side": 1 if signal > 0 else -1,
                    "entered": moment,
                    "entry_apr": abs(signal),
                    "funding_usd": 0.0,
                    "settlements": 0,
                }
                cost_total += half_cost * notional
                book(moment, -half_cost * notional)

    slot_seconds += len(held) * max(end - previous_moment, 0)
    for coin in list(held):
        close(coin, end, open_at_end=True)

    net = funding_total - cost_total
    days = max((end - start) / 86400, 1e-9)
    capital = notional * 2 * params.max_positions
    summary = {
        "net_usd": net,
        "funding_usd": funding_total,
        "costs_usd": cost_total,
        "trades": len(closed),
        "capital_usd": capital,
        "return_percent": net / capital * 100 if capital else 0.0,
        "apr_percent": net / capital * 100 * 365 / days if capital else 0.0,
    }
    if not detail:
        return summary

    cost_per_trade = 2 * half_cost * notional
    wins = sum(1 for trade in closed if trade["funding_usd"] - cost_per_trade > 0)
    hours = [(trade["exited"] - trade["entered"]) / 3600 for trade in closed]

    running = peak = drawdown = 0.0
    curve = []
    for day, value in sorted(daily.items()):
        running += value
        peak = max(peak, running)
        drawdown = max(drawdown, peak - running)
        curve.append({"day": day, "net_usd": value})

    by_coin: dict[str, dict] = {}
    for trade in closed:
        name = series[trade["coin"]].base_asset
        entry = by_coin.setdefault(name, {"coin": name, "trades": 0, "net_usd": 0.0, "funding_usd": 0.0, "hours": 0.0})
        entry["trades"] += 1
        entry["funding_usd"] += trade["funding_usd"]
        entry["net_usd"] += trade["funding_usd"] - cost_per_trade
        entry["hours"] += (trade["exited"] - trade["entered"]) / 3600

    def trade_row(trade: dict) -> dict:
        return {
            "coin": series[trade["coin"]].base_asset,
            "direction": LONG_DELTA if trade["side"] > 0 else LONG_BINANCE,
            "entered": datetime.fromtimestamp(trade["entered"], timezone.utc).isoformat(),
            "exited": datetime.fromtimestamp(trade["exited"], timezone.utc).isoformat(),
            "hours": (trade["exited"] - trade["entered"]) / 3600,
            "settlements": trade["settlements"],
            "entry_apr": trade["entry_apr"],
            "funding_usd": trade["funding_usd"],
            "net_usd": trade["funding_usd"] - cost_per_trade,
            "open_at_end": trade["open_at_end"],
        }

    return {
        **summary,
        "period_start": datetime.fromtimestamp(start, timezone.utc).isoformat(),
        "period_end": datetime.fromtimestamp(end, timezone.utc).isoformat(),
        "cost_per_trade_usd": cost_per_trade,
        "win_rate": wins / len(closed) if closed else 0.0,
        "avg_hold_hours": sum(hours) / len(hours) if hours else 0.0,
        "avg_settlements": sum(trade["settlements"] for trade in closed) / len(closed) if closed else 0.0,
        "exposure_percent": slot_seconds / (params.max_positions * (end - start)) * 100 if end > start and params.max_positions else 0.0,
        "max_drawdown_usd": drawdown,
        "open_at_end": sum(1 for trade in closed if trade["open_at_end"]),
        "daily": curve,
        "by_coin": sorted(by_coin.values(), key=lambda item: -item["net_usd"])[:12],
        "trades_list": [trade_row(trade) for trade in sorted(closed, key=lambda trade: -trade["entered"])[:40]],
    }


def run_lab(series: list[CoinSeries], params: StrategyParams, start: int, end: int) -> dict:
    """Your rules, the snipe baseline, a walk-forward threshold search and the levers that move the result most."""
    events_cache: dict[int, list[Event]] = {}

    def events_for(lookback: int) -> list[Event]:
        if lookback not in events_cache:
            events_cache[lookback] = build_events(series, lookback)
        return events_cache[lookback]

    def quick(changed: StrategyParams, window_start: int = start, window_end: int = end) -> dict:
        return run_carry(series, events_for(changed.lookback), changed, window_start, window_end, detail=False)

    yours = run_carry(series, events_for(params.lookback), params, start, end)

    snipe = simulate(
        series,
        BacktestParams(
            days=params.days,
            notional_usd=params.notional_usd,
            binance_taker_bps=params.binance_taker_bps,
            delta_taker_bps=params.delta_taker_bps,
            slippage_percent_per_leg=params.slippage_percent_per_leg,
        ),
        start,
        end,
    )

    # Walk-forward: choose thresholds on the first two thirds, score them on the last third they never saw.
    split = start + int((end - start) * TRAIN_SHARE)
    grid = []
    for entry in ENTRY_GRID_APR:
        for exit_apr in EXIT_GRID_APR:
            if exit_apr >= entry:
                continue
            candidate = replace(params, entry_apr_percent=entry, exit_apr_percent=exit_apr)
            train = quick(candidate, start, split)
            test = quick(candidate, split, end)
            grid.append(
                {
                    "entry_apr": entry,
                    "exit_apr": exit_apr,
                    "train_net_usd": train["net_usd"],
                    "test_net_usd": test["net_usd"],
                    "net_usd": train["net_usd"] + test["net_usd"],
                    "trades": train["trades"] + test["trades"],
                }
            )
    best = max(grid, key=lambda cell: cell["train_net_usd"])
    yours_train = quick(params, start, split)
    yours_test = quick(params, split, end)

    def lever(key: str, label: str, detail: str, changed: StrategyParams) -> dict:
        result = quick(changed)
        return {
            "key": key,
            "label": label,
            "detail": detail,
            "net_usd": result["net_usd"],
            "delta_usd": result["net_usd"] - yours["net_usd"],
            "apr_percent": result["apr_percent"],
            "params": changed.__dict__.copy(),
        }

    maker_bps = 2.0
    levers = [
        lever(
            "tuned",
            "Tuned thresholds",
            f"Enter at {best['entry_apr']:g}% a year, exit below {best['exit_apr']:g}%: the best on the first {round(TRAIN_SHARE * 100)}% of the period",
            replace(params, entry_apr_percent=best["entry_apr"], exit_apr_percent=best["exit_apr"]),
        ),
        lever(
            "maker",
            "Maker orders",
            f"Post limit orders instead of crossing the book: {maker_bps:g} bp a fill on both exchanges",
            replace(params, binance_taker_bps=min(maker_bps, params.binance_taker_bps), delta_taker_bps=min(maker_bps, params.delta_taker_bps)),
        ),
        lever(
            "slippage",
            "Half the slippage",
            "Stick to deeper books or split entries into smaller clips",
            replace(params, slippage_percent_per_leg=params.slippage_percent_per_leg / 2),
        ),
        lever(
            "slots",
            "Twice the slots",
            f"Hold up to {params.max_positions * 2} pairs at once (needs twice the capital)",
            replace(params, max_positions=params.max_positions * 2),
        ),
    ]
    for lookback in (1, 6):
        if lookback != params.lookback:
            speed = "Faster" if lookback < params.lookback else "Slower"
            levers.append(
                lever(
                    f"lookback-{lookback}",
                    f"{speed} signal",
                    f"Average the last {lookback} settlement{'s' if lookback > 1 else ''} per leg instead of {params.lookback}",
                    replace(params, lookback=lookback),
                )
            )
    levers.sort(key=lambda item: -item["delta_usd"])

    return {
        "params": params.__dict__.copy(),
        "coins": len(series),
        "strategy": yours,
        "snipe": {
            "net_usd": snipe["total_net_usd"],
            "trades": snipe["trades"],
            "cost_percent": snipe["cost_percent"],
            "daily": snipe["daily"],
        },
        "optimizer": {
            "split_at": datetime.fromtimestamp(split, timezone.utc).isoformat(),
            "entry_grid": ENTRY_GRID_APR,
            "exit_grid": EXIT_GRID_APR,
            "grid": grid,
            "best": best,
            "yours": {"train_net_usd": yours_train["net_usd"], "test_net_usd": yours_test["net_usd"]},
        },
        "levers": levers,
    }
