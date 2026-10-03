import { useEffect, useMemo, useRef, useState } from "react";
import "./design.css";

const API_BASE = import.meta.env.VITE_API_URL ?? "/api";

interface Cell {
  taker_bps: number;
  slippage_percent: number;
  trades: number;
  net_usd: number;
}

interface Result {
  period_start: string;
  period_end: string;
  coins: number;
  settlements: number;
  cost_percent: number;
  trades: number;
  trades_per_day: number;
  total_net_usd: number;
  avg_net_usd: number;
  per_month_usd: number;
  daily: Array<{ day: string; net_usd: number }>;
  by_coin: Array<{ coin: string; trades: number; net_usd: number; best_gross_percent: number }>;
  best_trades: Array<{ at: string; coin: string; gross_percent: number; net_percent: number; direction: string; settling: string }>;
  sensitivity: Cell[][];
  gross_distribution: Array<{ min_percent: number; max_percent: number | null; count: number }>;
}

interface State {
  status: "idle" | "running" | "done" | "error";
  progress: number;
  total: number;
  message: string;
  params?: Record<string, number>;
  result: Result | null;
}

interface Params {
  days: number;
  notional_usd: number;
  binance_taker_bps: number;
  delta_taker_bps: number;
  slippage_percent_per_leg: number;
  min_net_percent: number;
}

const DEFAULTS: Params = { days: 30, notional_usd: 1000, binance_taker_bps: 5, delta_taker_bps: 5, slippage_percent_per_leg: 0.1, min_net_percent: 0 };

function usd(value: number) {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}$${Math.abs(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function tone(value: number) {
  return value > 0 ? "t-receive" : value < 0 ? "t-pay" : "t-soft";
}

function Curve({ daily }: { daily: Result["daily"] }) {
  if (daily.length < 2) return <p className="t-muted">Not enough trading days to draw a curve.</p>;
  let running = 0;
  const points = daily.map((day) => (running += day.net_usd));
  const min = Math.min(0, ...points);
  const max = Math.max(0, ...points);
  const span = max - min || 1;
  const x = (index: number) => (index / (points.length - 1)) * 100;
  const y = (value: number) => 4 + (1 - (value - min) / span) * 92;
  const line = points.map((value, index) => `${index ? "L" : "M"}${x(index).toFixed(2)},${y(value).toFixed(2)}`).join(" ");
  return (
    <>
      <svg className="t-equity" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Cumulative backtest result">
        <line x1="0" x2="100" y1={y(0)} y2={y(0)} vectorEffect="non-scaling-stroke" />
        <path d={line} data-tone={points[points.length - 1] >= 0 ? "up" : "down"} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="t-timeline-scale">
        <span>{daily[0].day}</span>
        <span>{daily.length} days with trades</span>
        <span>{daily[daily.length - 1].day}</span>
      </div>
    </>
  );
}

export function Backtest() {
  const [state, setState] = useState<State | null>(null);
  const [params, setParams] = useState<Params>(DEFAULTS);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const debounce = useRef<number | null>(null);
  const resultSeen = useRef(false);

  // Poll the job while it runs.
  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    const poll = async () => {
      try {
        const next = (await fetch(`${API_BASE}/backtest`).then((response) => response.json())) as State;
        if (cancelled) return;
        setState(next);
        if (next.result && next.status === "done") {
          // First load after a run: show the settings that produced this result, not the form defaults.
          if (!resultSeen.current && next.params && Object.keys(next.params).length) setParams({ ...DEFAULTS, ...(next.params as Partial<Params>) });
          resultSeen.current = true;
          setResult((current) => current ?? next.result);
        }
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
  }, [state?.status === "running"]);

  const run = async () => {
    setError(null);
    const response = await fetch(`${API_BASE}/backtest/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    const payload = await response.json();
    if (!response.ok) {
      setError(payload.detail ?? "Could not start the backtest.");
      return;
    }
    setResult(null);
    setState(payload);
  };

  // Cost changes re-run instantly on the downloaded history.
  const update = (patch: Partial<Params>) => {
    const next = { ...params, ...patch };
    setParams(next);
    if (!state?.result) return;
    if (debounce.current) window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(async () => {
      const response = await fetch(`${API_BASE}/backtest/resimulate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      if (response.ok) setResult((await response.json()).result);
    }, 250);
  };

  const running = state?.status === "running";
  const maxCell = useMemo(() => Math.max(1, ...(result?.sensitivity.flat().map((cell) => Math.abs(cell.net_usd)) ?? [1])), [result]);

  return (
    <main className="t-main td-page">
      <header className="td-head">
        <div>
          <a className="td-back" href="/">Dashboard</a>
          <h1 className="td-title">Backtest</h1>
          <p className="t-soft td-sub">
            Replays every Binance and Delta settlement over real settled funding: would catching each one (in just before, out right after) have paid after fees and
            slippage?
          </p>
        </div>
        <div className="td-switches">
          <button type="button" className="t-btn" data-primary="true" onClick={() => void run()} disabled={running}>
            {running ? "Downloading history…" : result ? "Re-download and run" : "Run backtest"}
          </button>
        </div>
      </header>

      {error ? <div className="t-banner" role="alert">{error}</div> : null}

      <section className="t-panel td-section">
        <div className="td-fields">
          <label className="t-field">
            Period
            <select value={params.days} onChange={(event) => setParams({ ...params, days: Number(event.target.value) })} disabled={running}>
              {[7, 30, 60, 90].map((days) => (
                <option key={days} value={days}>
                  Last {days} days
                </option>
              ))}
            </select>
          </label>
          <label className="t-field">
            Size per leg (USD)
            <input type="number" min="1" value={params.notional_usd} onChange={(event) => update({ notional_usd: Number(event.target.value) || 1000 })} />
          </label>
          <label className="t-field">
            Binance taker fee (bp)
            <input type="number" step="0.5" min="0" value={params.binance_taker_bps} onChange={(event) => update({ binance_taker_bps: Number(event.target.value) })} />
          </label>
          <label className="t-field">
            Delta taker fee (bp)
            <input type="number" step="0.5" min="0" value={params.delta_taker_bps} onChange={(event) => update({ delta_taker_bps: Number(event.target.value) })} />
          </label>
          <label className="t-field">
            Slippage per leg, in + out (%)
            <input type="number" step="0.01" min="0" value={params.slippage_percent_per_leg} onChange={(event) => update({ slippage_percent_per_leg: Number(event.target.value) })} />
          </label>
          <label className="t-field">
            Only trade if net at least (%)
            <input type="number" step="0.05" value={params.min_net_percent} onChange={(event) => update({ min_net_percent: Number(event.target.value) })} />
          </label>
        </div>
        {running ? (
          <div className="bt-progress" role="status">
            <i style={{ width: `${state && state.total ? (state.progress / state.total) * 100 : 5}%` }} />
            <span>{state?.message}</span>
          </div>
        ) : null}
        {state?.status === "error" ? <p className="t-pay">{state.message}</p> : null}
      </section>

      {!result && !running ? (
        <div className="t-best-empty" style={{ marginTop: 16 }}>
          <strong>No backtest yet</strong>
          Run it once to download about a month of settled funding for every coin listed on both Binance and Delta (it is cached afterwards, and fee changes re-run
          instantly).
        </div>
      ) : null}

      {result ? (
        <>
          <section className="t-perf-kpis" style={{ marginTop: 16 }} aria-label="Result">
            <div className="t-perf-lead">
              <span className="t-soft">
                Net over {Math.max(1, Math.round((new Date(result.period_end).getTime() - new Date(result.period_start).getTime()) / 86_400_000))} days at ${params.notional_usd.toLocaleString()} per leg
              </span>
              <strong className={`t-num ${tone(result.total_net_usd)}`}>{usd(result.total_net_usd)}</strong>
              <span className="t-soft t-num">
                {result.trades} trades, {result.trades_per_day.toFixed(1)} a day, about {usd(result.per_month_usd)} a month
              </span>
            </div>
            <div className="t-perf-kpi">
              <span>Costs per trade</span>
              <b className="t-num">{result.cost_percent.toFixed(3)}%</b>
              <small className="t-muted">4 taker fills + slippage on both legs</small>
            </div>
            <div className="t-perf-kpi">
              <span>Average trade</span>
              <b className={`t-num ${tone(result.avg_net_usd)}`}>{usd(result.avg_net_usd)}</b>
            </div>
            <div className="t-perf-kpi">
              <span>Settlements checked</span>
              <b className="t-num">{result.settlements.toLocaleString()}</b>
              <small className="t-muted">{result.coins} coins</small>
            </div>
            <div className="t-perf-kpi">
              <span>Paid over 0.1% gross</span>
              <b className="t-num">
                {result.gross_distribution.filter((bucket) => bucket.min_percent >= 0.1).reduce((sum, bucket) => sum + bucket.count, 0).toLocaleString()}
              </b>
              <small className="t-muted">of {result.settlements.toLocaleString()}</small>
            </div>
            <div className="t-perf-kpi">
              <span>Best coin</span>
              <b className="t-num">{result.by_coin[0] ? `${result.by_coin[0].coin} ${usd(result.by_coin[0].net_usd)}` : "—"}</b>
            </div>
            <div className="t-perf-kpi">
              <span>Period</span>
              <b className="t-num">
                {result.period_start.slice(5, 10)} to {result.period_end.slice(5, 10)}
              </b>
            </div>
          </section>

          <section className="t-panel td-section" style={{ marginTop: 16 }}>
            <h3>What fees and slippage make it pay</h3>
            <p className="t-muted" style={{ margin: "0 0 12px", fontSize: 13.5 }}>
              Net result over the period if you take every settlement that clears costs. Rows: taker fee per fill on both exchanges. Columns: slippage per leg.
            </p>
            <div className="bt-grid" role="table">
              <div className="bt-cell bt-head" role="columnheader">Fee / slippage</div>
              {result.sensitivity[0].map((cell) => (
                <div key={`h-${cell.slippage_percent}`} className="bt-cell bt-head" role="columnheader">
                  {cell.slippage_percent}%
                </div>
              ))}
              {result.sensitivity.map((row) => (
                <div key={`r-${row[0].taker_bps}`} style={{ display: "contents" }} role="row">
                  <div className="bt-cell bt-head" role="rowheader">{row[0].taker_bps} bp</div>
                  {row.map((cell) => {
                    const strength = Math.min(1, Math.abs(cell.net_usd) / maxCell);
                    const active = cell.taker_bps === params.binance_taker_bps && cell.slippage_percent === params.slippage_percent_per_leg;
                    return (
                      <div
                        key={`${cell.taker_bps}-${cell.slippage_percent}`}
                        className="bt-cell"
                        data-active={active}
                        style={{ background: `color-mix(in srgb, ${cell.net_usd >= 0 ? "var(--t-receive)" : "var(--t-pay)"} ${Math.round(8 + strength * 30)}%, transparent)` }}
                        title={`${cell.trades} trades`}
                      >
                        <b className="t-num">{usd(cell.net_usd)}</b>
                        <small className="t-num">{cell.trades} trades</small>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
            <p className="t-muted" style={{ margin: "10px 0 0", fontSize: 13 }}>
              Zero slippage is unrealistic (crossing the spread alone cost ~0.07% per side on the live paper trade); treat that column as a ceiling.
            </p>
          </section>

          <section className="t-panel td-section" style={{ marginTop: 16 }}>
            <h3>Cumulative result</h3>
            <Curve daily={result.daily} />
          </section>

          <div className="t-grid-leaders" style={{ marginTop: 16 }}>
            <section className="t-panel">
              <h3>Coins that paid</h3>
              {result.by_coin.length ? (
                <ul className="t-list">
                  {result.by_coin.map((coin) => (
                    <li key={coin.coin}>
                      <span>
                        {coin.coin} <span className="t-muted">{coin.trades} trades, best {coin.best_gross_percent.toFixed(2)}%</span>
                      </span>
                      <span className={`t-num ${tone(coin.net_usd)}`}>{usd(coin.net_usd)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="t-muted">No settlement cleared these costs.</p>
              )}
            </section>
            <section className="t-panel">
              <h3>Biggest captures</h3>
              <ul className="t-list">
                {result.best_trades.map((trade) => (
                  <li key={`${trade.at}-${trade.coin}`}>
                    <span>
                      {trade.coin}{" "}
                      <span className="t-muted">
                        {new Date(trade.at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}, {trade.settling}
                      </span>
                    </span>
                    <span className="t-num t-receive">{trade.gross_percent.toFixed(3)}%</span>
                  </li>
                ))}
              </ul>
            </section>
            <section className="t-panel">
              <h3>How big settlements get</h3>
              <ul className="t-list">
                {result.gross_distribution.map((bucket) => (
                  <li key={bucket.min_percent}>
                    <span>
                      {bucket.min_percent}% {bucket.max_percent == null ? "and up" : `to ${bucket.max_percent}%`}
                    </span>
                    <span className="t-num">{bucket.count.toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            </section>
          </div>

          <section className="t-panel td-section" style={{ marginTop: 16 }}>
            <h3>Read this before trusting the number</h3>
            <ul className="t-checks">
              <li className="t-check" data-status="warn">
                <span aria-hidden="true">!</span>
                <span>
                  Decisions use the settled rate. Live trading decides ~30s before on the prediction (Binance matched exactly for 630 of 787 contracts in a check), so
                  results are slightly optimistic.
                </span>
              </li>
              <li className="t-check" data-status="warn">
                <span aria-hidden="true">!</span>
                <span>
                  The biggest wins come from rare spikes on thin, volatile coins, where real slippage can be far above the setting here. Paper-trade these before going
                  live.
                </span>
              </li>
              <li className="t-check" data-status="info">
                <span aria-hidden="true">i</span>
                <span>Binance and Delta only: CoinDCX mirrors Binance's funding, and WazirX publishes no history.</span>
              </li>
            </ul>
          </section>
        </>
      ) : null}
    </main>
  );
}
