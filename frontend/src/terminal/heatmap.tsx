import { useMemo, useState } from "react";
import { Empty } from "./states";
import { EXCHANGE_SHORT, pct } from "./primitives";
import type { RateRow } from "./useDashboard";

type RateMap = Record<string, RateRow[]>;

const perEight = (row: RateRow) => (row.rate / Math.max(row.interval_hours || 8, 1)) * 8 * 100;

/** Coins down the side, exchanges across the top: the widest gap in a row is the pair worth trading. */
export function HeatmapView({ rates, exchanges, onOpen }: { rates: RateMap; exchanges: string[]; onOpen: (symbol: string) => void }) {
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(40);

  const { rows, scale } = useMemo(() => {
    const built = Object.entries(rates)
      .map(([symbol, entries]) => {
        const inScope = entries.filter((entry) => exchanges.includes(entry.exchange));
        const values = inScope.map(perEight);
        return { symbol, entries: inScope, gap: values.length > 1 ? Math.max(...values) - Math.min(...values) : 0 };
      })
      .filter((row) => row.entries.length > 1)
      .sort((a, b) => b.gap - a.gap);
    const magnitudes = built.flatMap((row) => row.entries.map((entry) => Math.abs(perEight(entry)))).sort((a, b) => a - b);
    // Colour intensity saturates at the 90th percentile so one outlier doesn't wash out the rest.
    return { rows: built, scale: magnitudes[Math.floor(magnitudes.length * 0.9)] || 0.01 };
  }, [rates, exchanges]);

  const shown = rows.filter((row) => !query.trim() || row.symbol.toUpperCase().includes(query.trim().toUpperCase())).slice(0, limit);
  if (!rows.length) return <Empty title="No overlapping coins yet" body="The heatmap fills in once at least two exchanges list the same coin." />;

  const columns = exchanges;
  return (
    <div className="t-panel hm-panel">
      <h3>Funding heatmap</h3>
      <p className="t-subhead">Rate per 8 hours. Green: shorts collect. Red: longs collect. Ringed cells are the best long and best short for that coin.</p>
      <div className="t-form-row" style={{ margin: "10px 0 14px" }}>
        <label className="t-field">
          Find a coin
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="BTC, SOL…" />
        </label>
        <label className="t-field">
          Rows
          <select value={limit} onChange={(event) => setLimit(Number(event.target.value))}>
            {[20, 40, 80, 200].map((count) => (
              <option key={count} value={count}>
                Top {count} by gap
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="hm-legend" aria-hidden="true">
        <span>Longs collect</span>
        <i />
        <span>Shorts collect</span>
      </div>
      <div className="hm-scroll">
        <div className="hm-grid" role="table" style={{ gridTemplateColumns: `minmax(72px, 0.9fr) repeat(${columns.length}, minmax(64px, 1fr)) minmax(64px, 0.8fr)` }}>
          <span className="hm-head hm-sticky" role="columnheader">Coin</span>
          {columns.map((exchange) => (
            <span key={exchange} className="hm-head" role="columnheader" style={{ color: `var(--x-${exchange})` }}>
              {EXCHANGE_SHORT[exchange] ?? exchange}
            </span>
          ))}
          <span className="hm-head hm-right" role="columnheader">Gap</span>
          {shown.map((row) => {
            const values = row.entries.map(perEight);
            const hi = Math.max(...values);
            const lo = Math.min(...values);
            return (
              <HeatRow key={row.symbol} symbol={row.symbol} entries={row.entries} columns={columns} hi={hi} lo={lo} gap={row.gap} scale={scale} onOpen={onOpen} />
            );
          })}
        </div>
      </div>
      {!shown.length ? <p className="t-muted">No coin matches "{query}".</p> : null}
    </div>
  );
}

function HeatRow({
  symbol,
  entries,
  columns,
  hi,
  lo,
  gap,
  scale,
  onOpen,
}: {
  symbol: string;
  entries: RateRow[];
  columns: string[];
  hi: number;
  lo: number;
  gap: number;
  scale: number;
  onOpen: (symbol: string) => void;
}) {
  return (
    <>
      <button type="button" className="hm-coin hm-sticky" onClick={() => onOpen(symbol)}>
        {symbol.split("-")[0]}
      </button>
      {columns.map((exchange) => {
        const entry = entries.find((item) => item.exchange === exchange);
        if (!entry) return <span key={exchange} className="hm-cell hm-empty">·</span>;
        const value = perEight(entry);
        const strength = Math.min(1, Math.abs(value) / scale);
        const colour = value >= 0 ? "var(--t-receive)" : "var(--t-pay)";
        return (
          <button
            key={exchange}
            type="button"
            className="hm-cell t-num"
            data-edge={value === hi ? "short" : value === lo ? "long" : undefined}
            style={{ background: `color-mix(in srgb, ${colour} ${Math.round(strength * 55)}%, transparent)` }}
            title={`${symbol.split("-")[0]} on ${EXCHANGE_SHORT[exchange]}: ${pct(entry.rate * 100, 4, true)} every ${entry.interval_hours}h`}
            onClick={() => onOpen(symbol)}
          >
            {pct(value, 3, true)}
          </button>
        );
      })}
      <span className="hm-cell hm-gap t-num">{pct(gap, 3)}</span>
    </>
  );
}
