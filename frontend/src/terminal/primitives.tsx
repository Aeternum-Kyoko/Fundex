import { memo } from "react";
import type { ArbitrageOpportunity, OpportunityLeg, TrustLevel } from "../lib/types";
import { useClock } from "./clock";

export const EXCHANGE_SHORT: Record<string, string> = {
  binance: "Binance",
  delta: "Delta",
  coindcx: "CoinDCX",
  wazirx: "WazirX",
  coinswitch: "CoinSwitch",
};

export function exchangeVar(exchange: string) {
  return { "--x": `var(--x-${exchange})` } as React.CSSProperties;
}

export function ExchangeTag({ exchange }: { exchange: string }) {
  return (
    <span className="t-x" style={exchangeVar(exchange)}>
      {EXCHANGE_SHORT[exchange] ?? exchange}
    </span>
  );
}

const TRUST_COPY: Record<TrustLevel, string> = { high: "High", medium: "Medium", low: "Low" };

export function TrustBadge({ level, compact = false }: { level: TrustLevel; compact?: boolean }) {
  const filled = level === "high" ? 3 : level === "medium" ? 2 : 1;
  return (
    <span className="t-trust" data-level={level} title={`${TRUST_COPY[level]} trust`}>
      <span className="t-trust-bars" aria-hidden="true">
        {[1, 2, 3].map((bar) => (
          <i key={bar} data-on={bar <= filled} />
        ))}
      </span>
      {compact ? TRUST_COPY[level] : `${TRUST_COPY[level]} trust`}
    </span>
  );
}

export function formatCountdownShort(target: string | null | undefined, now: number, doneLabel = "settling") {
  if (!target) return "—";
  const ms = new Date(target).getTime() - now;
  if (!Number.isFinite(ms)) return "—";
  if (ms <= 0) return doneLabel;
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** Re-renders on its own every second; the rest of the screen stays still. */
export const Countdown = memo(function Countdown({ target, doneLabel }: { target: string | null | undefined; doneLabel?: string }) {
  const now = useClock();
  return <span className="t-num">{formatCountdownShort(target, now, doneLabel)}</span>;
});

/** Compact 24-hour time with seconds, e.g. 16:29:30. Short enough for narrow timeline columns. */
export function clockTime(value: string | null | undefined) {
  if (!value) return "";
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function pct(value: number | null | undefined, digits = 2, signed = false) {
  if (value == null || !Number.isFinite(value)) return "—";
  const text = `${Math.abs(value).toFixed(digits)}%`;
  if (!signed) return value < 0 ? `-${text}` : text;
  return value > 0 ? `+${text}` : value < 0 ? `−${text}` : text;
}

export function legRateLabel(leg: OpportunityLeg, fallbackInterval: number) {
  const interval = leg.funding_interval_hours ?? fallbackInterval;
  return `${pct(leg.funding_rate * 100, 4, true)} / ${interval}h`;
}

export function hoursLabel(hours: number | null | undefined) {
  if (hours == null || !Number.isFinite(hours)) return "over 30d";
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 48) return `${hours < 10 ? hours.toFixed(1) : hours.toFixed(0)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

export function nextPayout(opportunity: ArbitrageOpportunity) {
  const times = [opportunity.long_leg.next_funding_time, opportunity.short_leg.next_funding_time]
    .filter((value): value is string => Boolean(value))
    .map((value) => new Date(value).getTime());
  return times.length ? new Date(Math.min(...times)).toISOString() : null;
}

export interface EdgeScale {
  max: number;
}

/** Shared axis so every row's edge line can be compared at a glance (square-root compressed). */
export function makeEdgeScale(opportunities: ArbitrageOpportunity[]): EdgeScale {
  const values = opportunities
    .flatMap((item) => [item.long_leg.funding_rate_hourly ?? 0, item.short_leg.funding_rate_hourly ?? 0])
    .map(Math.abs)
    .sort((a, b) => a - b);
  const p95 = values[Math.floor(values.length * 0.95)] ?? 0;
  return { max: Math.max(p95, 1e-6) };
}

function edgeX(rate: number, scale: EdgeScale) {
  const magnitude = Math.sqrt(Math.min(Math.abs(rate) / scale.max, 1.15));
  return 50 + Math.sign(rate) * magnitude * 46;
}

/** The signature: each leg's hourly funding as a dot on one axis; the gap is the edge you collect. */
export const EdgeLine = memo(function EdgeLine({
  opportunity,
  scale,
  height = 26,
}: {
  opportunity: ArbitrageOpportunity;
  scale: EdgeScale;
  height?: number;
}) {
  const longX = edgeX(opportunity.long_leg.funding_rate_hourly ?? 0, scale);
  const shortX = edgeX(opportunity.short_leg.funding_rate_hourly ?? 0, scale);
  const mid = height / 2;
  return (
    <svg
      className="t-edge"
      viewBox={`0 0 100 ${height}`}
      preserveAspectRatio="none"
      data-trust={opportunity.trust_level}
      style={{ height }}
      role="img"
      aria-label={`Long ${EXCHANGE_SHORT[opportunity.long_leg.exchange]} ${pct((opportunity.long_leg.funding_rate_hourly ?? 0) * 100, 4)} per hour, short ${EXCHANGE_SHORT[opportunity.short_leg.exchange]} ${pct((opportunity.short_leg.funding_rate_hourly ?? 0) * 100, 4)} per hour`}
    >
      <line className="t-edge-axis" x1="0" x2="100" y1={mid} y2={mid} vectorEffect="non-scaling-stroke" />
      <line className="t-edge-zero" x1="50" x2="50" y1={mid - 5} y2={mid + 5} vectorEffect="non-scaling-stroke" />
      <line className="t-edge-gap" x1={longX} x2={shortX} y1={mid} y2={mid} vectorEffect="non-scaling-stroke" />
      <EdgeDot x={longX} y={mid} exchange={opportunity.long_leg.exchange} />
      <EdgeDot x={shortX} y={mid} exchange={opportunity.short_leg.exchange} />
    </svg>
  );
});

function EdgeDot({ x, y, exchange }: { x: number; y: number; exchange: string }) {
  // Drawn as a tiny vertical line with round caps so it stays circular inside a non-uniform viewBox.
  return (
    <line
      x1={x}
      x2={x}
      y1={y}
      y2={y + 0.01}
      stroke={`var(--x-${exchange})`}
      strokeWidth={11}
      strokeLinecap="round"
      vectorEffect="non-scaling-stroke"
    />
  );
}

export function BrandMark() {
  return (
    <svg className="t-brand-mark" viewBox="0 0 26 26" aria-hidden="true">
      <circle cx="13" cy="13" r="11.5" fill="none" stroke="var(--t-line-strong)" strokeWidth="1.5" />
      <circle cx="13" cy="13" r="6.5" fill="none" stroke="var(--t-line-strong)" strokeWidth="1.5" />
      <line x1="5" y1="17" x2="21" y2="9" stroke="var(--t-receive)" strokeWidth="2.6" strokeLinecap="round" />
      <circle cx="5" cy="17" r="2.6" fill="var(--t-pay)" />
      <circle cx="21" cy="9" r="2.6" fill="var(--t-receive)" />
    </svg>
  );
}

export const Icon = {
  help: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </svg>
  ),
  search: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  ),
  sun: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  ),
  moon: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" />
    </svg>
  ),
  key: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="8" cy="15" r="4" />
      <path d="m10.8 12.2 8.7-8.7M17 6l2.5 2.5M14.5 8.5 17 11" />
    </svg>
  ),
  close: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  ),
  pairs: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M4 12h16" />
      <circle cx="6" cy="12" r="2.5" />
      <circle cx="18" cy="12" r="2.5" />
      <path d="M4 6h9M11 18h9" opacity=".5" />
    </svg>
  ),
  leaders: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M5 20V10M12 20V4M19 20v-7" />
    </svg>
  ),
  clock: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  ),
  bell: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15Z" />
      <path d="M10 20.5a2 2 0 0 0 4 0" />
    </svg>
  ),
  trade: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M7 4v16M17 4v16" />
      <path d="M4 9l3-3 3 3M14 15l3 3 3-3" />
    </svg>
  ),
  more: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M4 7h16M4 12h16M4 17h10" />
    </svg>
  ),
  pass: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="m3.5 8.5 3 3 6-7" />
    </svg>
  ),
  warn: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M8 3.5v5.5M8 12v.5" />
    </svg>
  ),
  fail: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="m4 4 8 8M12 4l-8 8" />
    </svg>
  ),
  info: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" />
    </svg>
  ),
};
