import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { formatLeverage, formatUsd } from "../lib/monitor";
import type { ArbitrageOpportunity, OpportunityLeg } from "../lib/types";
import { RiskChips } from "./insights";
import { AnimatedPct } from "./motion";
import { MiniSpark, type SparkMap } from "./trends";
import { Countdown, EdgeLine, type EdgeScale, ExchangeTag, hoursLabel, nextPayout, pct, TrustBadge } from "./primitives";

export type SortKey = "net" | "spread" | "breakeven" | "trust" | "next" | "coin" | "oi";
export type Density = "compact" | "detailed";

interface ListProps {
  rows: ArbitrageOpportunity[];
  scale: EdgeScale;
  selected: string | null;
  onSelect: (symbol: string) => void;
  horizonLabel: string;
  exchangesQuery: string;
  sparks?: SparkMap;
}

function useScrollMargin() {
  const ref = useRef<HTMLDivElement>(null);
  const [margin, setMargin] = useState(0);
  useLayoutEffect(() => {
    const measure = () => setMargin((ref.current?.getBoundingClientRect().top ?? 0) + window.scrollY);
    measure();
    const observer = new ResizeObserver(measure);
    if (ref.current?.parentElement) observer.observe(ref.current.parentElement);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);
  return [ref, margin] as const;
}

/** Flashes when the net return moves, like a quote board, so changes are visible without reading every row. */
function useFlash(value: number) {
  const previous = useRef(value);
  const [flash, setFlash] = useState<"" | "t-flash-up" | "t-flash-down">("");
  useEffect(() => {
    const delta = value - previous.current;
    previous.current = value;
    if (Math.abs(delta) < 1e-6) return;
    setFlash(delta > 0 ? "t-flash-up" : "t-flash-down");
    const timer = window.setTimeout(() => setFlash(""), 900);
    return () => window.clearTimeout(timer);
  }, [value]);
  return flash;
}

export function compareHref(symbol: string, exchangesQuery: string) {
  return `/compare/${encodeURIComponent(symbol)}${exchangesQuery}`;
}

export function tradeHref(symbol: string, exchangesQuery: string, strategy: "capture" | "hold" = "capture") {
  const query = new URLSearchParams(exchangesQuery.replace(/^\?/, ""));
  if (strategy === "hold") query.set("strategy", "hold");
  const text = query.toString();
  return `/trade/${encodeURIComponent(symbol)}${text ? `?${text}` : ""}`;
}

function RowActions({ symbol, exchangesQuery }: { symbol: string; exchangesQuery: string }) {
  const stop = (event: React.MouseEvent | React.KeyboardEvent) => event.stopPropagation();
  return (
    <span className="t-row-actions">
      <a href={compareHref(symbol, exchangesQuery)} onClick={stop} onKeyDown={stop} title="Compare this coin across every exchange">
        Compare
      </a>
      <a href={tradeHref(symbol, exchangesQuery, "hold")} onClick={stop} onKeyDown={stop} title="Open the paper or live trade desk for this pair">
        Trade
      </a>
    </span>
  );
}

function LegCell({ leg, fallback }: { leg: OpportunityLeg; fallback: number }) {
  return (
    <span className="t-cell-stack t-right">
      <span className="t-num">
        {pct(leg.funding_rate * 100, 4, true)}
        <span className="t-muted"> /{leg.funding_interval_hours ?? fallback}h</span>
      </span>
      <small>
        <Countdown target={leg.next_funding_time} />
      </small>
    </span>
  );
}

export function PairTable({
  rows,
  scale,
  selected,
  onSelect,
  horizonLabel,
  exchangesQuery,
  sort,
  onSort,
  density,
  sparks,
}: ListProps & { sort: SortKey; onSort: (key: SortKey) => void; density: Density }) {
  const [anchor, scrollMargin] = useScrollMargin();
  const detailed = density === "detailed";
  const virtualizer = useWindowVirtualizer({
    count: rows.length,
    estimateSize: () => 60,
    overscan: 8,
    scrollMargin,
  });

  const head = (key: SortKey, label: string, className = "", title?: string) => (
    <button type="button" className={className} data-active={sort === key} onClick={() => onSort(key)} title={title} aria-pressed={sort === key}>
      {label}
      {sort === key ? " ↓" : ""}
    </button>
  );

  return (
    <div className="t-table" role="table" aria-label="Funding pairs" data-density={density}>
      <div className="t-head" role="row">
        {head("coin", "Pair")}
        <span title="Each leg's funding per hour on a shared axis. Dots are the two exchanges; the line between them is the edge you collect.">
          Edge
        </span>
        {detailed ? <span className="t-right" title="Long leg's predicted rate per settlement, and time to its next settlement">Long rate</span> : null}
        {detailed ? <span className="t-right" title="Short leg's predicted rate per settlement, and time to its next settlement">Short rate</span> : null}
        {head("spread", "Spread /8h", "t-right", "Funding spread after normalising each leg to its own interval, shown per 8 hours")}
        {head("net", `Net over ${horizonLabel}`, "t-right", "Funding collected over the hold minus fees and slippage, paid once")}
        {head("breakeven", "Break-even", "t-right t-col-be", "Time until funding covers fees and slippage")}
        {detailed ? head("oi", "Open interest", "t-right", "Combined open interest where the exchanges publish it") : null}
        {detailed ? <span className="t-right" title="Mark price difference between the two legs">Price gap</span> : null}
        {detailed ? <span className="t-right" title="Maximum leverage on the long / short exchange">Max lev.</span> : null}
        {head("trust", "Trust")}
        {head("next", "Next payout", "t-right")}
        <span className="t-right">Open</span>
      </div>
      <div ref={anchor} style={{ position: "relative", height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          return (
            <PairRow
              key={row.canonical_symbol}
              row={row}
              scale={scale}
              selected={row.canonical_symbol === selected}
              onSelect={onSelect}
              top={item.start - scrollMargin}
              detailed={detailed}
              exchangesQuery={exchangesQuery}
              spark={sparks?.[row.canonical_symbol]}
            />
          );
        })}
      </div>
    </div>
  );
}

const PairRow = memo(function PairRow({
  row,
  scale,
  selected,
  onSelect,
  top,
  detailed,
  exchangesQuery,
  spark,
}: {
  row: ArbitrageOpportunity;
  scale: EdgeScale;
  selected: boolean;
  onSelect: (symbol: string) => void;
  top: number;
  detailed: boolean;
  exchangesQuery: string;
  spark?: number[];
}) {
  const flash = useFlash(row.net_return_percent);
  const profitable = row.net_return_percent > 0;
  return (
    <div
      role="row"
      tabIndex={0}
      className={`t-row ${flash}`}
      data-selected={selected}
      style={{ transform: `translateY(${top}px)` }}
      onClick={() => onSelect(row.canonical_symbol)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(row.canonical_symbol);
        }
      }}
      aria-label={`${row.base_asset}: long ${row.long_leg.display_name}, short ${row.short_leg.display_name}`}
    >
      <span className="t-coin">
        <strong>{row.base_asset}</strong>
        <span className="t-legs">
          <ExchangeTag exchange={row.long_leg.exchange} />
          <span aria-hidden="true">to</span>
          <ExchangeTag exchange={row.short_leg.exchange} />
        </span>
      </span>
      <EdgeLine opportunity={row} scale={scale} />
      {detailed ? <LegCell leg={row.long_leg} fallback={row.funding_interval_hours} /> : null}
      {detailed ? <LegCell leg={row.short_leg} fallback={row.funding_interval_hours} /> : null}
      <span className="t-num t-right t-spread-cell">
        {spark ? <MiniSpark values={spark} width={44} height={18} label={`${row.base_asset} spread trend`} /> : null}
        <AnimatedPct value={row.spread_rate * 100} digits={4} />
      </span>
      <span className="t-cell-stack t-right">
        <span className={`t-num ${profitable ? "t-receive" : "t-pay"}`}><AnimatedPct value={row.net_return_percent} digits={3} signed /></span>
        <small className="t-num">{pct(row.net_apr_percent, 1)} APR</small>
      </span>
      <span className="t-num t-right t-col-be t-soft">{hoursLabel(row.break_even_hours)}</span>
      {detailed ? <span className="t-num t-right t-soft">{formatUsd(row.combined_open_interest_usd)}</span> : null}
      {detailed ? <span className="t-num t-right t-soft">{row.price_dislocation_percent != null ? pct(row.price_dislocation_percent, 3) : "—"}</span> : null}
      {detailed ? (
        <span className="t-num t-right t-soft">
          {formatLeverage(row.long_leg.max_leverage)} / {formatLeverage(row.short_leg.max_leverage)}
        </span>
      ) : null}
      <span className="t-cell-stack">
        <TrustBadge level={row.trust_level} compact />
        <RiskChips opportunity={row} max={1} />
      </span>
      <span className="t-right t-soft">
        <Countdown target={nextPayout(row)} />
      </span>
      <RowActions symbol={row.canonical_symbol} exchangesQuery={exchangesQuery} />
    </div>
  );
});

export function PairCards({ rows, scale, selected, onSelect, horizonLabel, exchangesQuery, sparks }: ListProps) {
  const [anchor, scrollMargin] = useScrollMargin();
  const virtualizer = useWindowVirtualizer({
    count: rows.length,
    estimateSize: () => 194,
    overscan: 5,
    scrollMargin,
  });

  return (
    <div ref={anchor} className="t-cards" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((item) => {
        const row = rows[item.index];
        return (
          <PairCard
            key={row.canonical_symbol}
            row={row}
            scale={scale}
            selected={row.canonical_symbol === selected}
            onSelect={onSelect}
            top={item.start - scrollMargin}
            horizonLabel={horizonLabel}
            exchangesQuery={exchangesQuery}
            spark={sparks?.[row.canonical_symbol]}
          />
        );
      })}
    </div>
  );
}

const PairCard = memo(function PairCard({
  row,
  scale,
  onSelect,
  top,
  horizonLabel,
  exchangesQuery,
  spark,
}: {
  row: ArbitrageOpportunity;
  scale: EdgeScale;
  selected: boolean;
  onSelect: (symbol: string) => void;
  top: number;
  horizonLabel: string;
  exchangesQuery: string;
  spark?: number[];
}) {
  const flash = useFlash(row.net_return_percent);
  const profitable = row.net_return_percent > 0;
  return (
    <div
      role="button"
      tabIndex={0}
      className={`t-card ${flash}`}
      style={{ transform: `translateY(${top}px)`, height: 182 }}
      onClick={() => onSelect(row.canonical_symbol)}
      onKeyDown={(event) => {
        if (event.key === "Enter") onSelect(row.canonical_symbol);
      }}
    >
      <span className="t-card-top">
        <strong>{row.base_asset}</strong>
        <span className={`t-card-money t-num ${profitable ? "t-receive" : "t-pay"}`}>{pct(row.net_return_percent, 2, true)}</span>
      </span>
      <span className="t-card-meta">
        <span className="t-legs">
          <ExchangeTag exchange={row.long_leg.exchange} />
          <span aria-hidden="true">to</span>
          <ExchangeTag exchange={row.short_leg.exchange} />
        </span>
        <span>over {horizonLabel}</span>
      </span>
      <EdgeLine opportunity={row} scale={scale} height={22} />
      <span className="t-card-meta">
        <TrustBadge level={row.trust_level} compact />
        <RiskChips opportunity={row} max={1} />
        <span className="t-num">Break-even {hoursLabel(row.break_even_hours)}</span>
        <span>
          Pays in <Countdown target={nextPayout(row)} />
        </span>
      </span>
      <span className="t-card-meta">
        <span className="t-num t-spread-cell">
          {spark ? <MiniSpark values={spark} width={44} height={18} label={`${row.base_asset} spread trend`} /> : null}
          Spread {pct(row.spread_rate * 100, 4)} /8h
        </span>
        <RowActions symbol={row.canonical_symbol} exchangesQuery={exchangesQuery} />
      </span>
    </div>
  );
});
