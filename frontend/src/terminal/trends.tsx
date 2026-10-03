import { useEffect, useMemo, useState } from "react";
import type { ArbitrageOpportunity, ExchangeFundingLeaders, FundingTrendSeries } from "../lib/types";
import { Empty } from "./states";
import { EXCHANGE_SHORT, ExchangeTag, pct } from "./primitives";

const API_BASE = import.meta.env.VITE_API_URL ?? "/api";

/** Recorded funding-rate history per exchange for the given coins (the backend stores one point a minute). */
export function useFundingTrends(symbols: string[], exchanges: string[], limit = 96, refreshMs = 0) {
  const [series, setSeries] = useState<FundingTrendSeries[]>([]);
  const [loading, setLoading] = useState(false);
  const symbolKey = Array.from(new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))).sort().slice(0, 40).join(",");
  const exchangeKey = exchanges.join(",");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!refreshMs) return;
    const timer = window.setInterval(() => document.visibilityState === "visible" && setTick((value) => value + 1), refreshMs);
    return () => window.clearInterval(timer);
  }, [refreshMs]);

  useEffect(() => {
    if (!symbolKey) {
      setSeries([]);
      return;
    }
    let cancelled = false;
    setLoading((current) => current || tick === 0);
    const params = new URLSearchParams({ symbols: symbolKey, exchanges: exchangeKey, limit: String(limit) });
    fetch(`${API_BASE}/exchanges/funding-trends?${params.toString()}`)
      .then((response) => (response.ok ? response.json() : { series: [] }))
      .then((payload) => !cancelled && setSeries(payload.series ?? []))
      .catch(() => !cancelled && setSeries([]))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [symbolKey, exchangeKey, limit, tick]);

  return { series, loading };
}

interface Plotted {
  exchange: string;
  points: Array<{ t: number; v: number }>;
}

/** Rates are shown as % per 8h so exchanges with 1h, 4h and 8h cycles line up. */
function plot(series: FundingTrendSeries[], intervals: Record<string, number>): Plotted[] {
  return series
    .filter((entry) => entry.points.length > 1)
    .map((entry) => ({
      exchange: entry.exchange,
      points: entry.points
        .map((point) => ({ t: new Date(point.recorded_at).getTime(), v: point.funding_rate * 100 * (8 / (intervals[entry.exchange] || 8)) }))
        .sort((a, b) => a.t - b.t),
    }));
}

function clockLabel(time: number, withDate: boolean) {
  const date = new Date(time);
  const clock = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return withDate ? `${date.toLocaleDateString([], { day: "numeric", month: "short" })} ${clock}` : clock;
}

export function TrendChart({ series, intervals = {}, height = 180 }: { series: FundingTrendSeries[]; intervals?: Record<string, number>; height?: number }) {
  const lines = useMemo(() => plot(series, intervals), [series, intervals]);
  const [hover, setHover] = useState<number | null>(null);
  if (!lines.length) {
    return <p className="t-muted">Rate history builds up as the backend records each exchange once a minute. Check back in a few minutes.</p>;
  }

  const all = lines.flatMap((line) => line.points);
  const t0 = Math.min(...all.map((point) => point.t));
  const t1 = Math.max(...all.map((point) => point.t));
  const lo = Math.min(0, ...all.map((point) => point.v));
  const hi = Math.max(0, ...all.map((point) => point.v));
  const span = hi - lo || 1e-9;
  const x = (t: number) => ((t - t0) / (t1 - t0 || 1)) * 100;
  const y = (v: number) => 96 - ((v - lo) / span) * 92;
  const multiDay = t1 - t0 > 20 * 3600_000;
  const at = hover != null ? t0 + (hover / 100) * (t1 - t0) : null;

  const valueAt = (line: Plotted, time: number) => {
    let best = line.points[0];
    for (const point of line.points) if (Math.abs(point.t - time) < Math.abs(best.t - time)) best = point;
    return best.v;
  };

  return (
    <div className="tr-chart">
      <div
        className="tr-plot"
        style={{ height }}
        onPointerMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          setHover(Math.max(0, Math.min(100, ((event.clientX - box.left) / box.width) * 100)));
        }}
        onPointerLeave={() => setHover(null)}
      >
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Funding rate history by exchange">
          <line className="tr-zero" x1="0" x2="100" y1={y(0)} y2={y(0)} vectorEffect="non-scaling-stroke" />
          {lines.map((line) => (
            <path
              key={line.exchange}
              className="tr-line"
              style={{ stroke: `var(--x-${line.exchange})` }}
              d={line.points.map((point, index) => `${index ? "L" : "M"}${x(point.t).toFixed(2)},${y(point.v).toFixed(2)}`).join(" ")}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {hover != null ? <line className="tr-cursor" x1={hover} x2={hover} y1="0" y2="100" vectorEffect="non-scaling-stroke" /> : null}
        </svg>
        <span className="tr-axis t-num" style={{ top: 0 }}>{pct(hi, 4)}</span>
        <span className="tr-axis t-num" style={{ bottom: 0 }}>{pct(lo, 4)}</span>
        {hover != null && at != null ? (
          <div className="tr-tip t-num" style={{ left: `${Math.min(hover, 70)}%` }}>
            <strong>{clockLabel(at, multiDay)}</strong>
            {lines.map((line) => (
              <span key={line.exchange}>
                <i style={{ background: `var(--x-${line.exchange})` }} />
                {EXCHANGE_SHORT[line.exchange] ?? line.exchange} {pct(valueAt(line, at), 4, true)}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <div className="t-timeline-scale">
        <span>{clockLabel(t0, multiDay)}</span>
        <span>% per 8h, above zero longs pay shorts</span>
        <span>{clockLabel(t1, multiDay)}</span>
      </div>
      <div className="tr-legend">
        {lines.map((line) => (
          <span key={line.exchange} className="t-num">
            <i style={{ background: `var(--x-${line.exchange})` }} />
            {EXCHANGE_SHORT[line.exchange] ?? line.exchange} {pct(line.points[line.points.length - 1].v, 4, true)}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Self-contained block for the detail panel and compare page. */
export function TrendBlock({ symbol, exchanges, intervals }: { symbol: string; exchanges: string[]; intervals?: Record<string, number> }) {
  const { series, loading } = useFundingTrends([symbol], exchanges, 96);
  if (loading && !series.length) return <p className="t-muted">Loading rate history…</p>;
  return <TrendChart series={series} intervals={intervals} />;
}

const WINDOWS = [
  { label: "1h", points: 60 },
  { label: "3h", points: 180 },
  { label: "8h", points: 480 },
  { label: "24h", points: 1440 },
] as const;

function stats(points: Array<{ v: number }>) {
  const values = points.map((point) => point.v);
  return {
    now: values[values.length - 1],
    avg: values.reduce((sum, value) => sum + value, 0) / values.length,
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

/** Rate history for any coin, across every exchange in scope. */
export function TrendsView({
  opportunities,
  leaders,
  exchanges,
  onOpen,
}: {
  opportunities: ArbitrageOpportunity[];
  leaders: ExchangeFundingLeaders[];
  exchanges: string[];
  onOpen: (symbol: string) => void;
}) {
  const coins = useMemo(() => {
    const ranked = new Map<string, number>();
    for (const row of opportunities) ranked.set(row.canonical_symbol, Math.max(ranked.get(row.canonical_symbol) ?? 0, Math.abs(row.spread_rate)));
    for (const group of leaders) {
      for (const leader of [...group.top_positive, ...group.top_negative]) {
        if (!ranked.has(leader.canonical_symbol)) ranked.set(leader.canonical_symbol, Math.abs(leader.funding_rate));
      }
    }
    return [...ranked.entries()].sort((a, b) => b[1] - a[1]).map(([symbol]) => symbol);
  }, [opportunities, leaders]);

  const intervals = useMemo(() => {
    const map: Record<string, number> = {};
    for (const group of leaders) {
      const first = [...group.top_positive, ...group.top_negative][0];
      if (first?.funding_interval_hours) map[group.exchange] = first.funding_interval_hours;
    }
    return map;
  }, [leaders]);

  const [symbol, setSymbol] = useState<string>("");
  const [windowKey, setWindowKey] = useState<(typeof WINDOWS)[number]["label"]>("3h");
  const chosen = symbol || coins[0] || "";
  const points = WINDOWS.find((item) => item.label === windowKey)?.points ?? 180;
  const { series, loading } = useFundingTrends(chosen ? [chosen] : [], exchanges, points);
  const lines = useMemo(() => plot(series, intervals), [series, intervals]);

  if (!coins.length) return <Empty title="No funding data yet" body="Pick a coin here once the first exchanges report their rates." />;

  return (
    <div className="t-panel">
      <h3>Funding rate history</h3>
      <div className="t-form-row" style={{ marginBottom: 14 }}>
        <label className="t-field">
          Coin
          <select value={chosen} onChange={(event) => setSymbol(event.target.value)}>
            {coins.map((coin) => (
              <option key={coin} value={coin}>
                {coin.split("-")[0]}
              </option>
            ))}
          </select>
        </label>
        <div className="t-segmented" role="group" aria-label="Window">
          {WINDOWS.map((item) => (
            <button key={item.label} type="button" aria-pressed={windowKey === item.label} onClick={() => setWindowKey(item.label)}>
              {item.label}
            </button>
          ))}
        </div>
        <button type="button" className="t-text-btn" style={{ height: 32 }} onClick={() => onOpen(chosen)}>
          Open pair details
        </button>
      </div>
      {loading && !series.length ? <p className="t-muted">Loading rate history…</p> : <TrendChart series={series} intervals={intervals} height={240} />}
      {lines.length ? (
        <div className="tr-stats" role="table">
          <div className="tr-stat-row tr-stat-head" role="row">
            <span>Exchange</span>
            <span className="t-right">Now</span>
            <span className="t-right">Average</span>
            <span className="t-right t-hide-phone">Low</span>
            <span className="t-right t-hide-phone">High</span>
          </div>
          {lines.map((line) => {
            const s = stats(line.points);
            return (
              <div key={line.exchange} className="tr-stat-row t-num" role="row">
                <span>
                  <ExchangeTag exchange={line.exchange} />
                </span>
                <span className="t-right">{pct(s.now, 4, true)}</span>
                <span className="t-right">{pct(s.avg, 4, true)}</span>
                <span className="t-right t-hide-phone">{pct(s.min, 4, true)}</span>
                <span className="t-right t-hide-phone">{pct(s.max, 4, true)}</span>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/* ---------- Sparklines ---------- */

/** Tiny trend line with no axes: direction at a glance. Green when the last value is above the first. */
export function MiniSpark({ values, width = 64, height = 22, label = "Recent trend" }: { values: number[]; width?: number; height?: number; label?: string }) {
  if (values.length < 3) return <span className="sp-empty" style={{ width, height }} aria-hidden="true" />;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const path = values.map((value, index) => `${index ? "L" : "M"}${((index / (values.length - 1)) * 100).toFixed(1)},${(92 - ((value - lo) / span) * 84).toFixed(1)}`).join(" ");
  const rising = values[values.length - 1] >= values[0];
  return (
    <svg className="sp" data-dir={rising ? "up" : "down"} viewBox="0 0 100 100" preserveAspectRatio="none" style={{ width, height }} role="img" aria-label={label}>
      <path d={path} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export type SparkMap = Record<string, number[]>;

const per8 = (point: { funding_rate: number }, interval: number) => point.funding_rate * 100 * (8 / (interval || 8));

/** Rate trend for each (coin, exchange), keyed "SYMBOL|exchange". */
export function rateSparks(series: FundingTrendSeries[], intervals: Record<string, number>): SparkMap {
  const out: SparkMap = {};
  for (const entry of series) out[`${entry.canonical_symbol}|${entry.exchange}`] = entry.points.map((point) => per8(point, intervals[entry.exchange] ?? 8));
  return out;
}

/** Short-minus-long rate gap over time for each pair, joined on the minute both legs were recorded. */
export function pairSparks(series: FundingTrendSeries[], pairs: Array<{ symbol: string; long: string; short: string; longInterval: number; shortInterval: number }>): SparkMap {
  const bySeries = new Map(series.map((entry) => [`${entry.canonical_symbol}|${entry.exchange}`, entry.points]));
  const out: SparkMap = {};
  for (const pair of pairs) {
    const longPoints = bySeries.get(`${pair.symbol}|${pair.long}`);
    const shortPoints = bySeries.get(`${pair.symbol}|${pair.short}`);
    if (!longPoints || !shortPoints) continue;
    const minute = (value: string) => Math.floor(new Date(value).getTime() / 60_000);
    const shortByMinute = new Map(shortPoints.map((point) => [minute(point.recorded_at), per8(point, pair.shortInterval)]));
    const values: number[] = [];
    for (const point of longPoints) {
      const match = shortByMinute.get(minute(point.recorded_at));
      if (match != null) values.push(match - per8(point, pair.longInterval));
    }
    out[pair.symbol] = values;
  }
  return out;
}
