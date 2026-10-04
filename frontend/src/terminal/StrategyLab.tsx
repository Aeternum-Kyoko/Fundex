import { useEffect, useMemo, useRef, useState } from "react";
import "./design.css";
import { StrategyBot } from "./StrategyBot";

const API_BASE = import.meta.env.VITE_API_URL ?? "/api";

interface Params {
  days: number;
  notional_usd: number;
  binance_taker_bps: number;
  delta_taker_bps: number;
  slippage_percent_per_leg: number;
  lookback: number;
  entry_apr_percent: number;
  exit_apr_percent: number;
  max_positions: number;
  use_predicted: boolean;
  book_slippage: boolean;
}

interface Trade {
  coin: string;
  direction: string;
  entered: string;
  exited: string;
  hours: number;
  settlements: number;
  entry_apr: number;
  funding_usd: number;
  net_usd: number;
  open_at_end: boolean;
}

interface Strategy {
  net_usd: number;
  funding_usd: number;
  costs_usd: number;
  trades: number;
  capital_usd: number;
  return_percent: number;
  apr_percent: number;
  period_start: string;
  period_end: string;
  cost_per_trade_usd: number;
  win_rate: number;
  avg_hold_hours: number;
  avg_settlements: number;
  exposure_percent: number;
  max_drawdown_usd: number;
  open_at_end: number;
  daily: Array<{ day: string; net_usd: number }>;
  by_coin: Array<{ coin: string; trades: number; net_usd: number; funding_usd: number; hours: number }>;
  trades_list: Trade[];
}

interface GridCell {
  entry_apr: number;
  exit_apr: number;
  train_net_usd: number;
  test_net_usd: number;
  net_usd: number;
  trades: number;
}

interface Lever {
  key: string;
  label: string;
  detail: string;
  net_usd: number;
  delta_usd: number;
  apr_percent: number;
  params: Params;
}

interface Lab {
  params: Params;
  coins: number;
  measured_slippage_coins: number;
  strategy: Strategy;
  snipe: { net_usd: number; trades: number; cost_percent: number; daily: Array<{ day: string; net_usd: number }> };
  optimizer: {
    split_at: string;
    entry_grid: number[];
    exit_grid: number[];
    grid: GridCell[];
    best: GridCell;
    yours: { train_net_usd: number; test_net_usd: number };
  };
  levers: Lever[];
}

interface JobState {
  status: "idle" | "running" | "done" | "error";
  progress: number;
  total: number;
  message: string;
  history_coins?: number;
  history_days?: number;
}

const DEFAULTS: Params = {
  days: 90,
  notional_usd: 1000,
  binance_taker_bps: 5,
  delta_taker_bps: 5,
  slippage_percent_per_leg: 0.1,
  lookback: 3,
  entry_apr_percent: 20,
  exit_apr_percent: 5,
  max_positions: 5,
  use_predicted: true,
  book_slippage: false,
};

const PARAMS_KEY = "fundex-strategy-params";

function loadParams(): Params {
  try {
    const stored = window.localStorage.getItem(PARAMS_KEY);
    if (stored) return { ...DEFAULTS, ...(JSON.parse(stored) as Partial<Params>) };
  } catch {
    // ignore
  }
  return DEFAULTS;
}

function usd(value: number) {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}$${Math.abs(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function pct(value: number, digits = 1) {
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(digits)}%`;
}

function tone(value: number) {
  return value > 0 ? "t-receive" : value < 0 ? "t-pay" : "t-soft";
}

function hoursLabel(hours: number) {
  return hours >= 48 ? `${(hours / 24).toFixed(1)} days` : `${Math.round(hours)}h`;
}

export function StrategyTabs({ active }: { active: "replay" | "lab" }) {
  return (
    <nav className="t-segmented sl-tabs" aria-label="Backtest views">
      <a href="/backtest" aria-current={active === "replay" ? "page" : undefined}>
        Settlement replay
      </a>
      <a href="/strategy" aria-current={active === "lab" ? "page" : undefined}>
        Strategy lab
      </a>
    </nav>
  );
}

/** Cumulative carry vs snipe, one shared $ axis, with a crosshair. */
function Comparison({ lab }: { lab: Lab }) {
  const [hover, setHover] = useState<number | null>(null);
  const days = useMemo(() => {
    const all = new Set([...lab.strategy.daily.map((d) => d.day), ...lab.snipe.daily.map((d) => d.day)]);
    return [...all].sort();
  }, [lab]);
  if (days.length < 2) return <p className="t-muted">Not enough days to draw a curve.</p>;

  const cumulative = (daily: Array<{ day: string; net_usd: number }>) => {
    const byDay = new Map(daily.map((d) => [d.day, d.net_usd]));
    let running = 0;
    return days.map((day) => (running += byDay.get(day) ?? 0));
  };
  const carry = cumulative(lab.strategy.daily);
  const snipe = cumulative(lab.snipe.daily);
  const min = Math.min(0, ...carry, ...snipe);
  const max = Math.max(0, ...carry, ...snipe);
  const span = max - min || 1;
  const x = (index: number) => (index / (days.length - 1)) * 100;
  const y = (value: number) => 6 + (1 - (value - min) / span) * 88;
  const line = (points: number[]) => points.map((value, index) => `${index ? "L" : "M"}${x(index).toFixed(2)},${y(value).toFixed(2)}`).join(" ");

  const onMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    setHover(Math.round(ratio * (days.length - 1)));
  };

  return (
    <>
      <div className="sl-legend">
        <span>
          <i data-series="carry" /> Your carry rules <b className={`t-num ${tone(carry[carry.length - 1])}`}>{usd(carry[carry.length - 1])}</b>
        </span>
        <span>
          <i data-series="snipe" /> Snipe every settlement <b className={`t-num ${tone(snipe[snipe.length - 1])}`}>{usd(snipe[snipe.length - 1])}</b>
        </span>
      </div>
      <div className="sl-chart" onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        <svg className="sl-curve" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Cumulative net result: your carry rules against sniping every settlement">
          <line className="sl-zero" x1="0" x2="100" y1={y(0)} y2={y(0)} vectorEffect="non-scaling-stroke" />
          <path d={line(snipe)} data-series="snipe" vectorEffect="non-scaling-stroke" />
          <path d={line(carry)} data-series="carry" vectorEffect="non-scaling-stroke" />
          {hover != null ? <line className="sl-cross" x1={x(hover)} x2={x(hover)} y1="0" y2="100" vectorEffect="non-scaling-stroke" /> : null}
        </svg>
        {hover != null ? (
          <div className="sl-tip" style={{ left: `${x(hover)}%` }} data-flip={x(hover) > 60}>
            <strong>{days[hover]}</strong>
            <span>
              <i data-series="carry" /> Carry <b className="t-num">{usd(carry[hover])}</b>
            </span>
            <span>
              <i data-series="snipe" /> Snipe <b className="t-num">{usd(snipe[hover])}</b>
            </span>
          </div>
        ) : null}
      </div>
      <div className="t-timeline-scale">
        <span>{days[0]}</span>
        <span>Cumulative net, same size per leg</span>
        <span>{days[days.length - 1]}</span>
      </div>
    </>
  );
}

function Heatmap({ lab, params, onPick }: { lab: Lab; params: Params; onPick: (entry: number, exit: number) => void }) {
  const { entry_grid, exit_grid, grid, best } = lab.optimizer;
  const cells = new Map(grid.map((cell) => [`${cell.entry_apr}|${cell.exit_apr}`, cell]));
  // Tint by where a cell sits between the worst and best result, so close calls still show a gradient.
  const values = grid.map((cell) => cell.net_usd);
  const low = Math.min(...values);
  const high = Math.max(...values);
  return (
    <div className="bt-grid sl-grid" role="table" style={{ gridTemplateColumns: `96px repeat(${exit_grid.length}, minmax(0, 1fr))` }}>
      <div className="bt-cell bt-head" role="columnheader">Enter ≥ / exit &lt;</div>
      {exit_grid.map((exit) => (
        <div key={`h-${exit}`} className="bt-cell bt-head" role="columnheader">
          {exit}%
        </div>
      ))}
      {entry_grid.map((entry) => (
        <div key={`r-${entry}`} style={{ display: "contents" }} role="row">
          <div className="bt-cell bt-head" role="rowheader">{entry}% a year</div>
          {exit_grid.map((exit) => {
            const cell = cells.get(`${entry}|${exit}`);
            if (!cell) return <div key={exit} className="bt-cell sl-void" aria-hidden="true" />;
            const strength = high > low ? (cell.net_usd - low) / (high - low) : 1;
            const isBest = cell.entry_apr === best.entry_apr && cell.exit_apr === best.exit_apr;
            return (
              <button
                key={exit}
                type="button"
                className="bt-cell sl-cell"
                role="cell"
                data-active={entry === params.entry_apr_percent && exit === params.exit_apr_percent}
                style={{ background: `color-mix(in srgb, ${cell.net_usd >= 0 ? "var(--t-receive)" : "var(--t-pay)"} ${Math.round(cell.net_usd >= 0 ? 6 + strength * 34 : 40 - strength * 34)}%, transparent)` }}
                title={`Enter at ${entry}%, exit below ${exit}%\nWhole period ${usd(cell.net_usd)} (${cell.trades} positions)\nFirst ⅔ ${usd(cell.train_net_usd)}, last ⅓ ${usd(cell.test_net_usd)}\nClick to use these`}
                onClick={() => onPick(entry, exit)}
              >
                <b className="t-num">{usd(cell.net_usd)}</b>
                <small className="t-num">{isBest ? "★ best on first ⅔" : `${cell.trades} positions`}</small>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export function StrategyLab() {
  const [job, setJob] = useState<JobState | null>(null);
  const [params, setParams] = useState<Params>(loadParams);
  const [lab, setLab] = useState<Lab | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const request = useRef(0);

  const historyReady = (job?.history_coins ?? 0) > 0;
  const running = job?.status === "running";
  const maxDays = job?.history_days || 90;

  // Follow the history download, if one is running.
  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    const poll = async () => {
      try {
        const next = (await fetch(`${API_BASE}/backtest`).then((response) => response.json())) as JobState;
        if (cancelled) return;
        setJob(next);
        if (next.status === "running") timer = window.setTimeout(poll, 1500);
      } catch {
        if (!cancelled) setError("Can't reach the backtest service.");
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [running]);

  // Re-run the lab whenever the rules change (debounced); stale replies are dropped.
  useEffect(() => {
    try {
      window.localStorage.setItem(PARAMS_KEY, JSON.stringify(params));
    } catch {
      // ignore
    }
    if (!historyReady || running) return;
    if (params.exit_apr_percent >= params.entry_apr_percent) {
      setError("The exit level has to be below the entry level.");
      return;
    }
    const id = ++request.current;
    const timer = window.setTimeout(async () => {
      setBusy(true);
      setError(null);
      try {
        const response = await fetch(`${API_BASE}/backtest/strategy`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...params, days: Math.min(params.days, maxDays) }),
        });
        const payload = await response.json();
        if (id !== request.current) return;
        if (!response.ok) setError(typeof payload.detail === "string" ? payload.detail : "Could not run the strategy.");
        else setLab(payload as Lab);
      } catch {
        if (id === request.current) setError("Can't reach the backtest service.");
      } finally {
        if (id === request.current) setBusy(false);
      }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [params, historyReady, running, maxDays]);

  const download = async () => {
    setError(null);
    const response = await fetch(`${API_BASE}/backtest/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ days: 90, notional_usd: params.notional_usd }),
    });
    const payload = await response.json();
    if (!response.ok) setError(payload.detail ?? "Could not start the download.");
    else setJob(payload);
  };

  const update = (patch: Partial<Params>) => setParams((current) => ({ ...current, ...patch }));
  const number = (key: keyof Params, fallback?: number) => (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = Number(event.target.value);
    update({ [key]: Number.isFinite(value) && event.target.value !== "" ? value : fallback ?? DEFAULTS[key] } as Partial<Params>);
  };

  const strategy = lab?.strategy;
  const optimizer = lab?.optimizer;
  const beatsSnipe = lab ? lab.strategy.net_usd - lab.snipe.net_usd : 0;
  const maxLever = Math.max(1, ...(lab?.levers.map((lever) => Math.abs(lever.delta_usd)) ?? [1]));

  return (
    <main className="t-main td-page">
      <header className="td-head">
        <div>
          <a className="td-back" href="/">Dashboard</a>
          <h1 className="td-title">Strategy lab</h1>
          <p className="t-soft td-sub">
            Build a carry algorithm: hold the hedged pair (long one exchange, short the other) while the funding spread pays, and pay fees once per position instead
            of on every settlement. Every change replays the real settled history.
          </p>
        </div>
        <div className="td-switches">
          <StrategyTabs active="lab" />
        </div>
      </header>

      {error ? <div className="t-banner" role="alert">{error}</div> : null}

      <section className="t-panel td-section">
        <h3>
          Your rules
          {busy ? <span className="t-muted sl-busy">Replaying…</span> : null}
        </h3>
        <div className="td-fields">
          <label className="t-field">
            Enter at spread ≥ (% a year)
            <input type="number" step="5" min="0" value={params.entry_apr_percent} onChange={number("entry_apr_percent")} />
          </label>
          <label className="t-field">
            Exit at spread &lt; (% a year)
            <input type="number" step="5" value={params.exit_apr_percent} onChange={number("exit_apr_percent", 0)} />
          </label>
          <label className="t-field">
            Signal lookback (settlements)
            <input type="number" step="1" min="1" max="24" value={params.lookback} onChange={number("lookback")} />
          </label>
          <label className="t-field">
            Pairs held at once
            <input type="number" step="1" min="1" max="50" value={params.max_positions} onChange={number("max_positions")} />
          </label>
          <label className="t-field">
            Size per leg (USD)
            <input type="number" min="1" value={params.notional_usd} onChange={number("notional_usd")} />
          </label>
          <label className="t-field">
            Period
            <select value={Math.min(params.days, maxDays)} onChange={(event) => update({ days: Number(event.target.value) })}>
              {[7, 30, 60, 90]
                .filter((days) => days <= maxDays)
                .map((days) => (
                  <option key={days} value={days}>
                    Last {days} days
                  </option>
                ))}
            </select>
          </label>
          <label className="t-field">
            Binance fee per fill (bp)
            <input type="number" step="0.5" min="0" value={params.binance_taker_bps} onChange={number("binance_taker_bps", 0)} />
          </label>
          <label className="t-field">
            Delta fee per fill (bp)
            <input type="number" step="0.5" min="0" value={params.delta_taker_bps} onChange={number("delta_taker_bps", 0)} />
          </label>
          <label className="t-field">
            Slippage per leg (%)
            <input type="number" step="0.01" min="0" value={params.slippage_percent_per_leg} onChange={number("slippage_percent_per_leg", 0)} />
          </label>
        </div>
        <div className="sl-modes">
          <div className="t-segmented" role="group" aria-label="Decide on">
            <button type="button" aria-pressed={params.use_predicted} onClick={() => update({ use_predicted: true })} title="Decide a few minutes before each settlement, on the exchanges' predicted rate">
              Predicted rates
            </button>
            <button type="button" aria-pressed={!params.use_predicted} onClick={() => update({ use_predicted: false })} title="Decide right after each settlement, on rates that have already settled">
              Settled rates
            </button>
          </div>
          <div className="t-segmented" role="group" aria-label="Slippage">
            <button type="button" aria-pressed={!params.book_slippage} onClick={() => update({ book_slippage: false })}>
              Flat slippage
            </button>
            <button type="button" aria-pressed={params.book_slippage} onClick={() => update({ book_slippage: true })} title="Charge each coin what its live order books cost at this size">
              Live order books
            </button>
          </div>
        </div>
        <p className="t-muted sl-rule">
          In words: {params.use_predicted ? "a few minutes before each settlement, add the exchanges' predicted rate," : "after each settlement,"} average the last {params.lookback} rate{params.lookback > 1 ? "s" : ""} on each exchange, annualise the gap, and open the{" "}
          {params.max_positions} widest pairs above {params.entry_apr_percent}% a year on the side that receives. Close a pair once its gap drops below{" "}
          {params.exit_apr_percent}% or flips.
        </p>
        {running ? (
          <div className="bt-progress" role="status">
            <i style={{ width: `${job && job.total ? (job.progress / job.total) * 100 : 5}%` }} />
            <span>{job?.message}</span>
          </div>
        ) : null}
      </section>

      <StrategyBot params={{ ...params, days: Math.min(params.days, maxDays) }} />

      {!historyReady && !running ? (
        <div className="t-best-empty" style={{ marginTop: 16 }}>
          <strong>No funding history yet</strong>
          The lab replays the same settled Binance and Delta history as the backtest. Download 90 days once (cached afterwards) and every change re-runs in
          seconds.
          <div style={{ marginTop: 12 }}>
            <button type="button" className="t-btn" data-primary="true" onClick={() => void download()}>
              Download history
            </button>
          </div>
        </div>
      ) : null}

      {lab && strategy && optimizer ? (
        <div data-busy={busy} className="sl-results">
          <section className="t-perf-kpis" style={{ marginTop: 16 }} aria-label="Result">
            <div className="t-perf-lead">
              <span className="t-soft">
                Net over {lab.params.days} days, {lab.coins} coins, ${lab.params.notional_usd.toLocaleString()} per leg
              </span>
              <strong className={`t-num ${tone(strategy.net_usd)}`}>{usd(strategy.net_usd)}</strong>
              <span className="t-soft t-num">
                {pct(strategy.return_percent, 2)} on ${strategy.capital_usd.toLocaleString()} capital, about {pct(strategy.apr_percent)} a year
              </span>
            </div>
            <div className="t-perf-kpi">
              <span>vs sniping every settlement</span>
              <b className={`t-num ${tone(beatsSnipe)}`}>{usd(beatsSnipe)}</b>
              <small className="t-muted">snipe made {usd(lab.snipe.net_usd)} in {lab.snipe.trades} trades</small>
            </div>
            <div className="t-perf-kpi">
              <span>Funding collected</span>
              <b className="t-num t-receive">{usd(strategy.funding_usd)}</b>
              <small className="t-muted">fees and slippage {usd(-strategy.costs_usd)}</small>
            </div>
            <div className="t-perf-kpi">
              <span>Positions</span>
              <b className="t-num">{strategy.trades}</b>
              <small className="t-muted">
                {Math.round(strategy.win_rate * 100)}% paid off, {strategy.open_at_end} still open
              </small>
            </div>
            <div className="t-perf-kpi">
              <span>Average hold</span>
              <b className="t-num">{hoursLabel(strategy.avg_hold_hours)}</b>
              <small className="t-muted">{strategy.avg_settlements.toFixed(1)} settlements each</small>
            </div>
            <div className="t-perf-kpi">
              <span>Slots in use</span>
              <b className="t-num">{Math.round(strategy.exposure_percent)}%</b>
              <small className="t-muted">of the time, on average</small>
            </div>
            <div className="t-perf-kpi">
              <span>Worst dip</span>
              <b className={`t-num ${strategy.max_drawdown_usd > 0 ? "t-pay" : ""}`}>{usd(-strategy.max_drawdown_usd)}</b>
              <small className="t-muted">peak to trough, daily</small>
            </div>
          </section>

          <section className="t-panel td-section" style={{ marginTop: 16 }}>
            <h3>Carry against the current snipe approach</h3>
            <Comparison lab={lab} />
          </section>

          <section className="t-panel td-section" style={{ marginTop: 16 }}>
            <h3>How to earn more</h3>
            <p className="t-muted sl-note">Each row changes one thing about your rules and replays the same history. Apply one to make it your rules.</p>
            <ul className="t-list sl-levers">
              {lab.levers.map((lever) => (
                <li key={lever.key}>
                  <span className="sl-lever-text">
                    <strong>{lever.label}</strong>
                    <span className="t-muted">{lever.detail}</span>
                  </span>
                  <span className="sl-bar" aria-hidden="true">
                    <i data-sign={lever.delta_usd >= 0 ? "up" : "down"} style={{ width: `${(Math.abs(lever.delta_usd) / maxLever) * 50}%` }} />
                  </span>
                  <span className="sl-lever-num">
                    <b className={`t-num ${tone(lever.delta_usd)}`}>{usd(lever.delta_usd)}</b>
                    <small className="t-muted t-num">{pct(lever.apr_percent)} a year</small>
                  </span>
                  <button type="button" className="t-btn" onClick={() => setParams({ ...params, ...lever.params, days: params.days })}>
                    Apply
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section className="t-panel td-section" style={{ marginTop: 16 }}>
            <h3>Entry and exit levels, tested</h3>
            <p className="t-muted sl-note">
              Net over the whole period for each pair of levels. Your current pair is outlined; click any cell to use it.
            </p>
            <Heatmap lab={lab} params={params} onPick={(entry, exit) => update({ entry_apr_percent: entry, exit_apr_percent: exit })} />
            <div className="t-check sl-verdict" data-status={optimizer.best.test_net_usd >= optimizer.yours.test_net_usd ? "pass" : "warn"}>
              <span aria-hidden="true">{optimizer.best.test_net_usd >= optimizer.yours.test_net_usd ? "✓" : "!"}</span>
              <span>
                Walk-forward check: picked only on data up to {optimizer.split_at.slice(0, 10)}, the best levels (enter {optimizer.best.entry_apr}%, exit{" "}
                {optimizer.best.exit_apr}%) made {usd(optimizer.best.train_net_usd)} there and then <b>{usd(optimizer.best.test_net_usd)}</b> on the unseen last
                third, against {usd(optimizer.yours.test_net_usd)} for your levels.{" "}
                {optimizer.best.test_net_usd >= optimizer.yours.test_net_usd
                  ? "The edge held up out of sample."
                  : "It didn't hold up out of sample, so the best-looking cell is probably overfit."}
              </span>
            </div>
          </section>

          <div className="sl-bottom">
            <section className="t-panel">
              <h3>Coins that carried</h3>
              {strategy.by_coin.length ? (
                <ul className="t-list">
                  {strategy.by_coin.map((coin) => (
                    <li key={coin.coin}>
                      <span>
                        {coin.coin}{" "}
                        <span className="t-muted">
                          {coin.trades} position{coin.trades > 1 ? "s" : ""}, {hoursLabel(coin.hours)} held
                        </span>
                      </span>
                      <span className={`t-num ${tone(coin.net_usd)}`}>{usd(coin.net_usd)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="t-muted">No pair cleared the entry level.</p>
              )}
            </section>
            <section className="t-panel">
              <h3>Latest positions</h3>
              {strategy.trades_list.length ? (
                <div className="sl-table-wrap">
                  <table className="sl-table">
                    <thead>
                      <tr>
                        <th>Coin</th>
                        <th>Side</th>
                        <th>Opened</th>
                        <th>Held</th>
                        <th>Entry gap</th>
                        <th>Funding</th>
                        <th>Net</th>
                      </tr>
                    </thead>
                    <tbody>
                      {strategy.trades_list.map((trade) => (
                        <tr key={`${trade.coin}-${trade.entered}`}>
                          <td>{trade.coin}</td>
                          <td className="t-muted">{trade.direction.replace(", ", " / ")}</td>
                          <td className="t-num">{new Date(trade.entered).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td>
                          <td className="t-num">
                            {hoursLabel(trade.hours)}
                            {trade.open_at_end ? <span className="t-muted"> open</span> : null}
                          </td>
                          <td className="t-num">{trade.entry_apr.toFixed(0)}%</td>
                          <td className="t-num t-receive">{usd(trade.funding_usd)}</td>
                          <td className={`t-num ${tone(trade.net_usd)}`}>{usd(trade.net_usd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="t-muted">No positions in this period.</p>
              )}
            </section>
          </div>

          <section className="t-panel td-section" style={{ marginTop: 16 }}>
            <h3>Read this before trusting the number</h3>
            <ul className="t-checks">
              {lab.params.use_predicted ? (
                <li className="t-check" data-status="warn">
                  <span aria-hidden="true">!</span>
                  <span>
                    Predicted-rate mode assumes each exchange's prediction a few minutes before settlement equals the settled rate. Binance's matched exactly for about
                    80% of contracts in a check, so treat this as a ceiling. The paper bot scores every prediction it makes, so check its accuracy there.
                  </span>
                </li>
              ) : null}
              <li className="t-check" data-status={lab.measured_slippage_coins ? "pass" : "info"}>
                <span aria-hidden="true">{lab.measured_slippage_coins ? "✓" : "i"}</span>
                <span>
                  {lab.measured_slippage_coins
                    ? `Slippage for the ${lab.measured_slippage_coins} coins these rules trade comes from their live order books at $${lab.params.notional_usd.toLocaleString()} a leg (today's depth applied to past trades); other coins use the flat setting.`
                    : "Slippage is the flat setting for every coin. Switch to live order books to charge thin coins what they really cost."}
                </span>
              </li>
              <li className="t-check" data-status="info">
                <span aria-hidden="true">i</span>
                <span>
                  {lab.params.use_predicted
                    ? "Decisions see only settled rates plus the coming settlement's (predicted) rate, never anything later."
                    : "No look-ahead: decisions use only rates that had already settled."}{" "}
                  New positions are paid from the next settlement, and positions still open at the end are charged their exit cost.
                </span>
              </li>
              <li className="t-check" data-status="warn">
                <span aria-hidden="true">!</span>
                <span>
                  Holding for days carries risks a snipe doesn't: the two prices can drift apart (basis), a leg can be liquidated on a big move, and margin sits
                  idle. Size by your margin, not just the notional.
                </span>
              </li>
              <li className="t-check" data-status="warn">
                <span aria-hidden="true">!</span>
                <span>A cell that looks best over the whole period is fitted to it. Trust the walk-forward line above more than the brightest cell.</span>
              </li>
              <li className="t-check" data-status="info">
                <span aria-hidden="true">i</span>
                <span>Binance and Delta only: CoinDCX mirrors Binance's funding, and WazirX publishes no history.</span>
              </li>
            </ul>
          </section>
        </div>
      ) : null}
    </main>
  );
}
