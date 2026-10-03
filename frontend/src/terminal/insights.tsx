import { useEffect, useMemo, useState } from "react";
import { formatUsd } from "../lib/monitor";
import type { TradeSessionResponse } from "../lib/trade-types";
import type { ArbitrageOpportunity, OpportunityHistoryPoint } from "../lib/types";
import { Countdown, EXCHANGE_SHORT, ExchangeTag, pct } from "./primitives";

const API_BASE = import.meta.env.VITE_API_URL ?? "/api";

/* ---------- Risk flags ---------- */

export interface RiskFlag {
  label: string;
  tone: "warn" | "fail" | "info";
  detail: string;
}

const FLAG_LABEL: Record<string, string> = {
  freshness: "Stale feed",
  liquidity: "Thin liquidity",
  price_gap: "Price gap",
  persistence: "Short-lived edge",
  quote: "No live quote",
  rate_refresh: "Rate may reset",
  interval: "Mixed cycles",
  schedule: "Odd schedule",
  profit: "Costs eat the edge",
  first_payment: "Slow first payment",
};

/** One-glance summary of the trust checks that are not green. */
export function riskFlags(opportunity: ArbitrageOpportunity): RiskFlag[] {
  const flags: RiskFlag[] = [];
  for (const check of opportunity.trust_checks) {
    if (check.status === "pass") continue;
    // "New edge" is information, not a problem; show it quietly.
    const label = check.key === "persistence" && check.status === "info" ? "New edge" : FLAG_LABEL[check.key] ?? check.label;
    flags.push({ label, tone: check.status === "fail" ? "fail" : check.status === "warn" ? "warn" : "info", detail: check.detail });
  }
  const order = { fail: 0, warn: 1, info: 2 } as const;
  return flags.sort((a, b) => order[a.tone] - order[b.tone]);
}

export function RiskChips({ opportunity, max = 2 }: { opportunity: ArbitrageOpportunity; max?: number }) {
  const flags = riskFlags(opportunity);
  if (!flags.length) return null;
  return (
    <span className="rk-chips">
      {flags.slice(0, max).map((flag) => (
        <span key={flag.label} className="rk-chip" data-tone={flag.tone} title={flag.detail}>
          {flag.label}
        </span>
      ))}
      {flags.length > max ? <span className="rk-chip" data-tone="info" title={flags.slice(max).map((flag) => flag.label).join(", ")}>+{flags.length - max}</span> : null}
    </span>
  );
}

/* ---------- Spread persistence ---------- */

export interface SpreadStats {
  samples: number;
  spanHours: number;
  aboveShare: number;
  streakHours: number;
  average: number;
  trend: "growing" | "steady" | "fading";
  stability: "stable" | "choppy" | "erratic";
  dropouts: number;
  threshold: number;
}

/** Break-even edge per 8h: the spread at which funding over the hold exactly covers costs. */
export function breakEvenSpread(opportunity: ArbitrageOpportunity) {
  return opportunity.estimated_total_cost_percent / Math.max(opportunity.holding_horizon_hours / 8, 1e-9);
}

export function analyseSpread(points: OpportunityHistoryPoint[], threshold: number): SpreadStats | null {
  if (points.length < 5) return null;
  const ordered = [...points].sort((a, b) => a.recorded_at.localeCompare(b.recorded_at));
  const times = ordered.map((point) => new Date(point.recorded_at).getTime());
  const values = ordered.map((point) => point.spread_rate * 100);
  const above = values.map((value) => value >= threshold);
  let streakStart = values.length - 1;
  while (streakStart >= 0 && above[streakStart]) streakStart -= 1;
  const streakHours = above[values.length - 1] ? (times[times.length - 1] - times[streakStart + 1]) / 3_600_000 : 0;
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length;
  const cv = average > 0 ? Math.sqrt(variance) / average : 1;
  const quarter = Math.max(1, Math.floor(values.length / 4));
  const head = values.slice(0, quarter).reduce((sum, value) => sum + value, 0) / quarter;
  const tail = values.slice(-quarter).reduce((sum, value) => sum + value, 0) / quarter;
  let dropouts = 0;
  for (let index = 1; index < above.length; index += 1) if (above[index - 1] && !above[index]) dropouts += 1;
  return {
    samples: values.length,
    spanHours: (times[times.length - 1] - times[0]) / 3_600_000,
    aboveShare: above.filter(Boolean).length / above.length,
    streakHours,
    average,
    trend: tail > head * 1.25 ? "growing" : tail < head * 0.75 ? "fading" : "steady",
    stability: cv < 0.25 ? "stable" : cv < 0.6 ? "choppy" : "erratic",
    dropouts,
    threshold,
  };
}

function duration(hours: number) {
  if (hours < 1 / 6) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  if (hours < 48) return `${hours.toFixed(hours < 10 ? 1 : 0)}h`;
  return `${(hours / 24).toFixed(1)} days`;
}

export function PersistenceBlock({ opportunity, points }: { opportunity: ArbitrageOpportunity; points: OpportunityHistoryPoint[] }) {
  const threshold = breakEvenSpread(opportunity);
  const stats = useMemo(() => analyseSpread(points, threshold), [points, threshold]);
  if (!stats) return <p className="t-muted">Persistence needs a few minutes of recorded history for this pair.</p>;

  const verdict =
    stats.aboveShare >= 0.85 && stats.stability !== "erratic"
      ? { tone: "good", text: "Looks like a real edge" }
      : stats.aboveShare >= 0.5
        ? { tone: "mid", text: "Holds most of the time" }
        : { tone: "bad", text: "Mostly below break-even: treat as a spike" };

  return (
    <div className="ps-block">
      <p className="ps-verdict" data-tone={verdict.tone}>
        {verdict.text}
      </p>
      <p className="t-soft ps-line">
        {stats.streakHours > 0 ? `Above break-even for ${duration(stats.streakHours)} straight` : "Currently below break-even"}, average{" "}
        <span className="t-num">{pct(stats.average, 4)}</span> /8h, {stats.stability}
        {stats.trend !== "steady" ? `, ${stats.trend}` : ""}.
      </p>
      <dl className="t-kv">
        <div>
          <dt>Time above break-even ({pct(stats.threshold, 4)} /8h)</dt>
          <dd className="t-num">{Math.round(stats.aboveShare * 100)}%</dd>
        </div>
        <div>
          <dt>Dropped below break-even</dt>
          <dd className="t-num">{stats.dropouts} times</dd>
        </div>
        <div>
          <dt>Window observed</dt>
          <dd className="t-num">
            {duration(stats.spanHours)}, {stats.samples} samples
          </dd>
        </div>
      </dl>
    </div>
  );
}

/* ---------- Backtest confidence ---------- */

interface CoinStat {
  settlements: number;
  paid: number;
  hit_rate: number;
  avg_net_percent: number;
}

interface BacktestState {
  status: string;
  result: null | { coin_stats?: Record<string, CoinStat>; period_start: string; period_end: string; cost_percent: number };
}

let backtestCache: { at: number; promise: Promise<BacktestState | null> } | null = null;

function loadBacktest() {
  if (!backtestCache || Date.now() - backtestCache.at > 60_000) {
    backtestCache = {
      at: Date.now(),
      promise: fetch(`${API_BASE}/backtest`)
        .then((response) => (response.ok ? (response.json() as Promise<BacktestState>) : null))
        .catch(() => null),
    };
  }
  return backtestCache.promise;
}

export function BacktestConfidence({ baseAsset }: { baseAsset: string }) {
  const [state, setState] = useState<BacktestState | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void loadBacktest().then((value) => !cancelled && setState(value));
    return () => {
      cancelled = true;
    };
  }, []);
  if (state === undefined) return <p className="t-muted">Checking past results…</p>;
  const stat = state?.result?.coin_stats?.[baseAsset];
  if (!state?.result) {
    return (
      <p className="t-muted">
        No backtest has run yet. <a href="/backtest">Run one</a> to see how often catching this coin's settlement would have paid.
      </p>
    );
  }
  if (!stat) {
    return <p className="t-muted">The backtest covers Binance and Delta pairs, and {baseAsset} wasn't in that set.</p>;
  }
  const days = Math.round((new Date(state.result.period_end).getTime() - new Date(state.result.period_start).getTime()) / 86_400_000);
  return (
    <div className="bt-block">
      <p className="bt-line">
        Would have paid after costs on <strong className="t-num">{stat.paid}</strong> of the last <strong className="t-num">{stat.settlements}</strong> settlements
        <span className="t-muted"> ({Math.round(stat.hit_rate * 100)}%)</span>
      </p>
      <div className="bt-bar" aria-hidden="true">
        <i style={{ width: `${Math.round(stat.hit_rate * 100)}%` }} />
      </div>
      <p className="t-muted" style={{ fontSize: 13, marginTop: 6 }}>
        Next-settlement captures over {days} days, costs {pct(state.result.cost_percent, 3)}.
        {stat.paid ? ` Average net on the wins ${pct(stat.avg_net_percent, 3, true)}.` : ""} Past results don't guarantee the next one.
      </p>
    </div>
  );
}

/* ---------- Liquidity depth ---------- */

interface DepthRow {
  exchange: string;
  display_name: string;
  max_size_usd: number;
  limit_percent: number;
  top_of_book_spread_percent: number;
  sizes: Array<{ size_usd: number; buy_percent: number | null; sell_percent: number | null }>;
}

function impactTone(value: number | null) {
  if (value == null) return "none";
  return value <= 0.05 ? "good" : value <= 0.1 ? "ok" : value <= 0.3 ? "warn" : "bad";
}

function sizeLabel(usd: number) {
  return usd >= 1000 ? `$${usd / 1000}k` : `$${usd}`;
}

export function DepthBlock({ symbol, longExchange, shortExchange }: { symbol: string; longExchange: string; shortExchange: string }) {
  const [rows, setRows] = useState<DepthRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setFailed(false);
    fetch(`${API_BASE}/symbols/${encodeURIComponent(symbol)}/depth`)
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("depth"))))
      .then((payload) => !cancelled && setRows(payload.exchanges ?? []))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  if (failed) return <p className="t-muted">Couldn't read the order books just now. Try again in a moment.</p>;
  if (!rows) return <div className="t-skel" style={{ height: 96, borderRadius: 10 }} aria-busy="true" />;
  if (!rows.length) return <p className="t-muted">No exchange shares a public order book for this coin.</p>;

  const legs = rows.filter((row) => row.exchange === longExchange || row.exchange === shortExchange);
  const tradeLimit = legs.length === 2 ? Math.min(...legs.map((row) => row.max_size_usd)) : null;
  const sizes = rows[0].sizes.map((entry) => entry.size_usd);
  return (
    <div className="dp-block">
      {tradeLimit != null ? (
        <p className="dp-headline">
          Biggest trade this pair takes under 0.1% slippage per side: <strong className="t-num">{formatUsd(tradeLimit)}</strong>
        </p>
      ) : null}
      <div className="dp-grid" role="table" style={{ gridTemplateColumns: `minmax(86px, 1.1fr) repeat(${sizes.length}, minmax(34px, 1fr))` }}>
        <span className="dp-head" role="columnheader">Exchange</span>
        {sizes.map((size) => (
          <span key={size} className="dp-head t-num" role="columnheader">
            {sizeLabel(size)}
          </span>
        ))}
        {rows.map((row) => (
          <DepthRowView key={row.exchange} row={row} mark={row.exchange === longExchange ? "L" : row.exchange === shortExchange ? "S" : ""} />
        ))}
      </div>
      <p className="t-muted" style={{ fontSize: 12.5, marginTop: 8 }}>
        Slippage to buy or sell each size right now, worse side shown. Green is 0.05% or less, "–" means the visible book can't fill it. Max under 0.1%:{" "}
        {rows.map((row) => `${EXCHANGE_SHORT[row.exchange] ?? row.exchange} ${formatUsd(row.max_size_usd)}`).join(", ")}.
      </p>
    </div>
  );
}

function DepthRowView({ row, mark }: { row: DepthRow; mark: string }) {
  return (
    <>
      <span className="dp-name" role="rowheader">
        <ExchangeTag exchange={row.exchange} />
        {mark ? <em>{mark === "L" ? "long" : "short"}</em> : null}
      </span>
      {row.sizes.map((entry) => {
        const worst = entry.buy_percent == null || entry.sell_percent == null ? null : Math.max(entry.buy_percent, entry.sell_percent);
        return (
          <span key={entry.size_usd} className="dp-cell t-num" data-tone={impactTone(worst)} role="cell" title={`${sizeLabel(entry.size_usd)}: buy ${entry.buy_percent == null ? "can't fill" : pct(entry.buy_percent, 3)}, sell ${entry.sell_percent == null ? "can't fill" : pct(entry.sell_percent, 3)}`}>
            {worst == null ? "–" : worst < 0.01 ? "0.01" : worst.toFixed(2)}
          </span>
        );
      })}
    </>
  );
}

/* ---------- Open positions ---------- */

const FINAL = new Set(["completed", "failed", "cancelled"]);

export function usePositions() {
  const [trades, setTrades] = useState<TradeSessionResponse[]>([]);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch(`${API_BASE}/trade/journal?limit=40`)
        .then((response) => (response.ok ? response.json() : []))
        .then((payload: TradeSessionResponse[]) => !cancelled && setTrades(payload.filter((trade) => !FINAL.has(trade.status))))
        .catch(() => undefined);
    void load();
    const timer = window.setInterval(() => document.visibilityState === "visible" && void load(), 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);
  return trades;
}

function collected(trade: TradeSessionResponse) {
  if (trade.realized_funding_pnl_usd != null) return trade.realized_funding_pnl_usd;
  return (trade.funding_legs ?? []).reduce((sum, leg) => sum + (leg.payment_usd ?? 0), 0);
}

function nextSettlement(trade: TradeSessionResponse) {
  const pending = (trade.funding_legs ?? []).filter((leg) => leg.actual_rate == null).map((leg) => leg.settles_at).sort();
  return pending[0] ?? trade.pair_funding_time;
}

/** Why the live market no longer matches the trade, or null while it still does. */
export function positionWarning(trade: TradeSessionResponse, live: ArbitrageOpportunity | undefined) {
  if (trade.status === "armed") return null;
  if (!live) return "This pair has no live spread right now";
  if (live.long_leg.exchange !== trade.long_leg.exchange || live.short_leg.exchange !== trade.short_leg.exchange) return "The best pair has flipped to different exchanges";
  if (live.spread_rate_hourly <= 0) return "The spread has closed";
  return null;
}

export function PositionsStrip({ trades, opportunities, onOpen }: { trades: TradeSessionResponse[]; opportunities: ArbitrageOpportunity[]; onOpen: (symbol: string) => void }) {
  const live = useMemo(() => new Map(opportunities.map((row) => [row.canonical_symbol, row])), [opportunities]);
  if (!trades.length) return null;
  return (
    <section className="ps-positions" aria-label="Open trades">
      <h3 className="t-subhead">Your open trades</h3>
      <div className="ps-pos-grid">
        {trades.map((trade) => {
          const warning = positionWarning(trade, live.get(trade.canonical_symbol));
          const money = collected(trade);
          return (
            <button key={trade.id} type="button" className="ps-pos" data-warn={warning ? "true" : undefined} onClick={() => onOpen(trade.canonical_symbol)}>
              <span className="ps-pos-top">
                <strong>{trade.canonical_symbol.split("-")[0]}</strong>
                <span className="ps-pos-mode">{trade.mode}</span>
                <span className="t-muted">{trade.current_phase}</span>
              </span>
              <span className="ps-pos-meta t-num">
                <span>
                  {EXCHANGE_SHORT[trade.long_leg.exchange]} to {EXCHANGE_SHORT[trade.short_leg.exchange]}
                </span>
                <span className={money >= 0 ? "t-receive" : "t-pay"}>
                  {money >= 0 ? "+" : "−"}${Math.abs(money).toFixed(2)} funding
                </span>
                <span>
                  next <Countdown target={nextSettlement(trade)} />
                </span>
              </span>
              {warning ? <span className="ps-pos-warn">{warning}</span> : null}
            </button>
          );
        })}
      </div>
    </section>
  );
}

export function PositionNote({ trades, symbol }: { trades: TradeSessionResponse[]; symbol: string }) {
  const mine = trades.filter((trade) => trade.canonical_symbol === symbol);
  if (!mine.length) return null;
  return (
    <p className="ps-note">
      You have {mine.length} open {mine[0].mode} trade{mine.length > 1 ? "s" : ""} on this coin: {EXCHANGE_SHORT[mine[0].long_leg.exchange]} long, {EXCHANGE_SHORT[mine[0].short_leg.exchange]} short,{" "}
      {mine[0].current_phase}. <a href={`/trade/${encodeURIComponent(symbol)}`}>Open the trade</a>
    </p>
  );
}
