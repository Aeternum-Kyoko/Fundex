import { useMemo } from "react";
import type { ArbitrageOpportunity } from "../lib/types";
import { EXCHANGE_SHORT, pct } from "./primitives";

/** A slow marquee of the widest spreads right now. Hover pauses it; reduced-motion users get a static, scrollable row. */
export function Ticker({ rows, onOpen }: { rows: ArbitrageOpportunity[]; onOpen: (symbol: string) => void }) {
  const items = useMemo(() => [...rows].filter((row) => row.trust_level !== "low").sort((a, b) => b.spread_rate - a.spread_rate).slice(0, 14), [rows]);
  if (items.length < 4) return null;
  const render = (suffix: string) =>
    items.map((row) => (
      <button key={`${row.canonical_symbol}-${suffix}`} type="button" className="tk-item" tabIndex={suffix === "b" ? -1 : 0} aria-hidden={suffix === "b" || undefined} onClick={() => onOpen(row.canonical_symbol)}>
        <strong>{row.base_asset}</strong>
        <span className="t-num t-receive">{pct(row.spread_rate * 100, 3, true)}</span>
        <span className="t-muted">
          {EXCHANGE_SHORT[row.long_leg.exchange]} to {EXCHANGE_SHORT[row.short_leg.exchange]}
        </span>
      </button>
    ));
  return (
    <div className="tk" role="region" aria-label="Widest spreads right now">
      <span className="tk-label">Widest /8h</span>
      <div className="tk-window">
        <div className="tk-track">
          {render("a")}
          {render("b")}
        </div>
      </div>
    </div>
  );
}
