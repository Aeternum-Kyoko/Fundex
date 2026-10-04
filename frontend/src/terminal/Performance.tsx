import { useEffect, useMemo, useState } from "react";
import type { TradeSessionResponse } from "../lib/trade-types";
import { EXCHANGE_SHORT, pct } from "./primitives";
import "./design.css";

const API_BASE = import.meta.env.VITE_API_URL ?? "/api";

type ModeFilter = "paper" | "live" | "all";
type RangeFilter = "7" | "30" | "all";

function usd(value: number | null | undefined, signed = true) {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = signed ? (value > 0 ? "+" : value < 0 ? "−" : "") : value < 0 ? "−" : "";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function tone(value: number | null | undefined) {
  if (value == null) return "t-muted";
  return value > 0 ? "t-receive" : value < 0 ? "t-pay" : "t-soft";
}

interface Group {
  key: string;
  trades: number;
  wins: number;
  net: number;
}

function groupBy(trades: TradeSessionResponse[], keyOf: (trade: TradeSessionResponse) => string): Group[] {
  const map = new Map<string, Group>();
  for (const trade of trades) {
    const key = keyOf(trade);
    const group = map.get(key) ?? { key, trades: 0, wins: 0, net: 0 };
    group.trades += 1;
    group.net += trade.realized_net_pnl_usd ?? 0;
    if ((trade.realized_net_pnl_usd ?? 0) > 0) group.wins += 1;
    map.set(key, group);
  }
  return [...map.values()].sort((a, b) => b.net - a.net);
}

function EquityCurve({ trades }: { trades: TradeSessionResponse[] }) {
  const points = useMemo(() => {
    const ordered = [...trades].sort((a, b) => a.updated_at.localeCompare(b.updated_at));
    let running = 0;
    return ordered.map((trade) => {
      running += trade.realized_net_pnl_usd ?? 0;
      return { at: trade.updated_at, value: running };
    });
  }, [trades]);
  if (points.length < 2) {
    return <p className="t-muted">The curve appears after two completed trades.</p>;
  }
  const values = points.map((point) => point.value);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const span = max - min || 1;
  const x = (index: number) => (index / (points.length - 1)) * 100;
  const y = (value: number) => 4 + (1 - (value - min) / span) * 92;
  const line = points.map((point, index) => `${index ? "L" : "M"}${x(index).toFixed(2)},${y(point.value).toFixed(2)}`).join(" ");
  const last = values[values.length - 1];
  return (
    <>
      <svg className="t-equity" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label={`Cumulative net result ${usd(last)}`}>
        <line x1="0" x2="100" y1={y(0)} y2={y(0)} vectorEffect="non-scaling-stroke" />
        <path d={line} data-tone={last >= 0 ? "up" : "down"} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="t-timeline-scale">
        <span>{new Date(points[0].at).toLocaleDateString()}</span>
        <span className="t-num">
          {points.length} trades, ending at <span className={tone(last)}>{usd(last)}</span>
        </span>
        <span>{new Date(points[points.length - 1].at).toLocaleDateString()}</span>
      </div>
    </>
  );
}

function GroupTable({ title, groups, empty }: { title: string; groups: Group[]; empty: string }) {
  return (
    <section className="t-panel">
      <h3>{title}</h3>
      {groups.length ? (
        <ul className="t-list">
          {groups.slice(0, 10).map((group) => (
            <li key={group.key}>
              <span>
                {group.key} <span className="t-muted t-num">{group.trades} trades, {Math.round((group.wins / group.trades) * 100)}% won</span>
              </span>
              <span className={`t-num ${tone(group.net)}`}>{usd(group.net)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="t-muted">{empty}</p>
      )}
    </section>
  );
}

export function Performance() {
  const [trades, setTrades] = useState<TradeSessionResponse[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<ModeFilter>("paper");
  const [range, setRange] = useState<RangeFilter>("30");

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch(`${API_BASE}/trade/journal?limit=2000`)
        .then((response) => {
          if (!response.ok) throw new Error(`The journal answered ${response.status}.`);
          return response.json();
        })
        .then((payload: TradeSessionResponse[]) => {
          if (!cancelled) {
            setTrades(payload);
            setError(null);
          }
        })
        .catch((loadError) => !cancelled && setError(loadError instanceof Error ? loadError.message : "Loading the journal failed."));
    void load();
    const timer = window.setInterval(load, 20_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const scoped = useMemo(() => {
    const since = range === "all" ? 0 : Date.now() - Number(range) * 86_400_000;
    return (trades ?? []).filter((trade) => (mode === "all" || trade.mode === mode) && new Date(trade.created_at).getTime() >= since);
  }, [trades, mode, range]);
  const completed = useMemo(() => scoped.filter((trade) => trade.status === "completed" && trade.realized_net_pnl_usd != null), [scoped]);

  const stats = useMemo(() => {
    const net = completed.reduce((sum, trade) => sum + (trade.realized_net_pnl_usd ?? 0), 0);
    const expected = completed.reduce((sum, trade) => sum + trade.expected_net_pnl_usd, 0);
    const funding = completed.reduce((sum, trade) => sum + (trade.realized_funding_pnl_usd ?? 0), 0);
    const price = completed.reduce((sum, trade) => sum + (trade.realized_price_pnl_usd ?? 0), 0);
    const fees = completed.reduce((sum, trade) => sum + (trade.realized_total_fees_usd ?? 0), 0);
    const slipped = completed.filter((trade) => trade.realized_slippage_usd != null);
    const slippageActual = slipped.reduce((sum, trade) => sum + (trade.realized_slippage_usd ?? 0), 0);
    const slippageExpected = slipped.reduce((sum, trade) => sum + (trade.expected_slippage_usd ?? 0), 0);
    const settledLegs = completed.flatMap((trade) => trade.funding_legs ?? []).filter((leg) => leg.actual_rate != null && leg.source !== "estimate");
    const predictionErrorBp = settledLegs.length
      ? (settledLegs.reduce((sum, leg) => sum + Math.abs((leg.actual_rate ?? 0) - leg.predicted_rate), 0) / settledLegs.length) * 10_000
      : null;
    const wins = completed.filter((trade) => (trade.realized_net_pnl_usd ?? 0) > 0).length;
    return {
      net,
      expected,
      funding,
      price,
      fees,
      slippageActual,
      slippageExpected,
      slippedCount: slipped.length,
      settledLegs: settledLegs.length,
      predictionErrorBp,
      wins,
      failed: scoped.filter((trade) => trade.status === "failed").length,
      pending: scoped.filter((trade) => trade.funding_status === "pending").length,
    };
  }, [completed, scoped]);

  const byCoin = useMemo(() => groupBy(completed, (trade) => trade.canonical_symbol.split("-")[0]), [completed]);
  const byPair = useMemo(
    () => groupBy(completed, (trade) => `${EXCHANGE_SHORT[trade.long_leg.exchange] ?? trade.long_leg.exchange} to ${EXCHANGE_SHORT[trade.short_leg.exchange] ?? trade.short_leg.exchange}`),
    [completed],
  );
  const byHour = useMemo(
    () =>
      groupBy(completed, (trade) => {
        const at = trade.pair_funding_time ? new Date(trade.pair_funding_time) : new Date(trade.created_at);
        return `${String(at.getHours()).padStart(2, "0")}:00 settlement`;
      }),
    [completed],
  );

  return (
    <main className="t-main t-perf" style={{ maxWidth: 1320, margin: "0 auto" }}>
      <div className="t-perf-head">
        <div>
          <h1 className="t-perf-title">Performance</h1>
          <p className="t-soft" style={{ margin: 0, maxWidth: "62ch" }}>
            Every paper and live trade, with fills from real order books and funding replaced by the settled rate once the exchange publishes it.
          </p>
        </div>
        <div className="t-toolbar" style={{ margin: 0 }}>
          <div className="t-segmented" role="group" aria-label="Mode">
            {(["paper", "live", "all"] as const).map((key) => (
              <button key={key} type="button" aria-pressed={mode === key} onClick={() => setMode(key)}>
                {key === "all" ? "Paper + live" : key === "paper" ? "Paper" : "Live"}
              </button>
            ))}
          </div>
          <div className="t-segmented" role="group" aria-label="Range">
            {(["7", "30", "all"] as const).map((key) => (
              <button key={key} type="button" aria-pressed={range === key} onClick={() => setRange(key)}>
                {key === "all" ? "All time" : `${key} days`}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error ? <div className="t-banner" role="alert">{error}</div> : null}

      {trades && !scoped.length ? (
        <div className="t-best-empty" style={{ marginTop: 16 }}>
          <strong>No {mode === "all" ? "" : `${mode} `}trades in this range yet</strong>
          Arm a paper trade from any pair on the dashboard. It fills against the live order book at the real entry and exit seconds, and its result lands here.
          <div className="t-actions">
            <a className="t-btn" data-primary="true" href="/">
              Find a pair
            </a>
          </div>
        </div>
      ) : null}

      {scoped.length ? (
        <>
          <section className="t-perf-kpis" aria-label="Summary">
            <div className="t-perf-lead">
              <span className="t-soft">Net result, {completed.length} completed</span>
              <strong className={`t-num ${tone(stats.net)}`}>{usd(stats.net)}</strong>
              <span className="t-soft t-num">
                planned {usd(stats.expected)}, {completed.length ? Math.round((stats.wins / completed.length) * 100) : 0}% of trades made money
              </span>
            </div>
            <div className="t-perf-kpi">
              <span>Funding collected</span>
              <b className={`t-num ${tone(stats.funding)}`}>{usd(stats.funding)}</b>
            </div>
            <div className="t-perf-kpi">
              <span>Price moves between legs</span>
              <b className={`t-num ${tone(stats.price)}`}>{usd(stats.price)}</b>
            </div>
            <div className="t-perf-kpi">
              <span>Fees paid</span>
              <b className="t-num t-pay">{usd(-stats.fees)}</b>
            </div>
            <div className="t-perf-kpi">
              <span>Slippage, actual vs planned</span>
              <b className="t-num">
                {stats.slippedCount ? `${usd(stats.slippageActual, false)} vs ${usd(stats.slippageExpected, false)}` : "—"}
              </b>
            </div>
            <div className="t-perf-kpi">
              <span>Funding prediction error</span>
              <b className="t-num">{stats.predictionErrorBp != null ? `${stats.predictionErrorBp.toFixed(2)} bp avg` : "—"}</b>
              <small className="t-muted">{stats.settledLegs} settled legs checked</small>
            </div>
            <div className="t-perf-kpi">
              <span>Failed or waiting</span>
              <b className="t-num">
                {stats.failed} failed, {stats.pending} awaiting settled rate
              </b>
            </div>
          </section>

          <section className="t-panel" style={{ marginTop: 14 }}>
            <h3>Cumulative result</h3>
            <EquityCurve trades={completed} />
          </section>

          <div className="t-grid-leaders" style={{ marginTop: 14 }}>
            <GroupTable title="By coin" groups={byCoin} empty="No completed trades yet." />
            <GroupTable title="By exchange pair (long to short)" groups={byPair} empty="No completed trades yet." />
            <GroupTable title="By settlement hour (your time)" groups={byHour} empty="No completed trades yet." />
          </div>

          <section className="t-panel" style={{ marginTop: 14, padding: 0 }}>
            <h3 style={{ padding: "14px 16px 0" }}>Trades</h3>
            <div className="t-perf-table" role="table">
              <div className="t-perf-row t-perf-headrow" role="row">
                <span>When</span>
                <span>Trade</span>
                <span>Status</span>
                <span className="t-right">Planned</span>
                <span className="t-right">Result</span>
                <span>Funding</span>
              </div>
              {scoped.map((trade) => (
                <a key={trade.id} className="t-perf-row" role="row" href={`/trade/${encodeURIComponent(trade.canonical_symbol)}`}>
                  <span className="t-num t-soft">
                    {new Date(trade.created_at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                  </span>
                  <span>
                    <strong>{trade.canonical_symbol.split("-")[0]}</strong>{" "}
                    <span className="t-muted">
                      {trade.mode}, {trade.strategy === "capture" ? "next funding" : trade.strategy === "carry" ? "strategy bot" : "hold"}, long {EXCHANGE_SHORT[trade.long_leg.exchange]}, short {EXCHANGE_SHORT[trade.short_leg.exchange]}
                    </span>
                  </span>
                  <span className={trade.status === "failed" ? "t-pay" : trade.status === "completed" ? "t-soft" : "t-muted"}>{trade.status}</span>
                  <span className={`t-num t-right ${tone(trade.expected_net_pnl_usd)}`}>{usd(trade.expected_net_pnl_usd)}</span>
                  <span className={`t-num t-right ${tone(trade.realized_net_pnl_usd)}`}>{usd(trade.realized_net_pnl_usd)}</span>
                  <span className="t-muted">
                    {(trade.funding_legs ?? []).length
                      ? (trade.funding_legs ?? [])
                          .map((leg) => `${EXCHANGE_SHORT[leg.exchange]} ${pct(leg.predicted_rate * 100, 4, true)} → ${leg.actual_rate != null ? pct(leg.actual_rate * 100, 4, true) : "…"}`)
                          .join(", ")
                      : "no settlement inside"}
                  </span>
                </a>
              ))}
            </div>
          </section>
        </>
      ) : null}
      {!trades && !error ? <div className="t-skel" style={{ borderRadius: 14, marginTop: 16 }} /> : null}
    </main>
  );
}
