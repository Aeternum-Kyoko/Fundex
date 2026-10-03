import { useEffect, useMemo, useState } from "react";
import { useSymbolComparison } from "../hooks/useSymbolComparison";
import { formatLeverage, formatPrice, formatUsd } from "../lib/monitor";
import type { ArbitrageOpportunity, OpportunityHistoryPoint, OpportunityLeg, SymbolComparisonExchangeSnapshot } from "../lib/types";
import { CaptureBlock, type CaptureRow } from "./capture";
import { tradeHref } from "./pairs";
import { useClock } from "./clock";
import type { TradeSessionResponse } from "../lib/trade-types";
import { BacktestConfidence, DepthBlock, PersistenceBlock, PositionNote, RiskChips, riskFlags } from "./insights";
import { TrendBlock } from "./trends";
import { ExchangeTag, Countdown, EdgeLine, type EdgeScale, EXCHANGE_SHORT, hoursLabel, Icon, legRateLabel, pct, TrustBadge } from "./primitives";

const API_BASE = import.meta.env.VITE_API_URL ?? "/api";

function useHistory(symbol: string) {
  const [points, setPoints] = useState<OpportunityHistoryPoint[]>([]);
  useEffect(() => {
    let cancelled = false;
    setPoints([]);
    fetch(`${API_BASE}/opportunities/${encodeURIComponent(symbol)}/history?limit=180`)
      .then((response) => (response.ok ? response.json() : { points: [] }))
      .then((payload) => !cancelled && setPoints(payload.points ?? []))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [symbol]);
  return points;
}

function Sparkline({ points }: { points: OpportunityHistoryPoint[] }) {
  if (points.length < 3) {
    return <p className="t-muted">History builds up as the backend records this pair once a minute.</p>;
  }
  const ordered = [...points].sort((a, b) => a.recorded_at.localeCompare(b.recorded_at));
  const values = ordered.map((point) => point.spread_rate * 100);
  const min = Math.min(0, ...values);
  const max = Math.max(...values, min + 1e-9);
  const x = (index: number) => (index / (values.length - 1)) * 100;
  const y = (value: number) => 60 - ((value - min) / (max - min)) * 56 - 2;
  const line = values.map((value, index) => `${index ? "L" : "M"}${x(index).toFixed(2)},${y(value).toFixed(2)}`).join(" ");
  const first = new Date(ordered[0].recorded_at);
  return (
    <>
      <svg className="t-spark" viewBox="0 0 100 64" preserveAspectRatio="none" role="img" aria-label="Spread history">
        <path data-area d={`${line} L100,62 L0,62 Z`} />
        <path data-line d={line} vectorEffect="non-scaling-stroke" />
        {min < 0 ? <line x1="0" x2="100" y1={y(0)} y2={y(0)} vectorEffect="non-scaling-stroke" /> : null}
      </svg>
      <div className="t-timeline-scale">
        <span>{first.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
        <span className="t-num">
          now {pct(values[values.length - 1], 4)} /8h, range {pct(Math.min(...values), 4)} to {pct(Math.max(...values), 4)}
        </span>
      </div>
    </>
  );
}

/** Every exchange that lists the coin (ignoring the dashboard scope), with the pair's two legs marked. */
function AllExchanges({ opportunity, rows, loading }: { opportunity: ArbitrageOpportunity; rows: SymbolComparisonExchangeSnapshot[]; loading: boolean }) {
  if (loading && !rows.length) return <p className="t-muted">Loading every exchange…</p>;
  if (!rows.length) return <p className="t-muted">No other exchange lists {opportunity.base_asset} right now.</p>;
  return (
    <>
      <ul className="ax-list">
        {rows.map((row) => {
          const side = row.exchange === opportunity.long_leg.exchange ? "long" : row.exchange === opportunity.short_leg.exchange ? "short" : null;
          return (
            <li key={row.exchange}>
              <a className="ax-row" href={row.trade_url} target="_blank" rel="noreferrer" data-side={side ?? undefined} title={`Open ${row.exchange_symbol} on ${row.display_name}`}>
                <span className="ax-name">
                  <ExchangeTag exchange={row.exchange} />
                  {side ? <em className="ax-side">{side === "long" ? "Long here" : "Short here"}</em> : null}
                </span>
                <span className="t-num ax-rate">
                  {pct(row.funding_rate * 100, 4, true)}
                  <span className="t-muted"> /{row.funding_interval_hours}h</span>
                </span>
                <span className="t-num t-muted ax-meta">
                  <Countdown target={row.next_funding_time} /> · {formatLeverage(row.max_leverage)} · OI {formatUsd(row.open_interest_usd)} · fee {pct(row.taker_fee_bps / 100, 3)}
                </span>
              </a>
            </li>
          );
        })}
      </ul>
      <p className="t-muted" style={{ fontSize: 13, marginTop: 8 }}>
        {rows.length} exchanges list {opportunity.base_asset}. Click one to open it there.
      </p>
    </>
  );
}

interface TimelineEvent {
  at: number;
  side: "long" | "short";
  amount: number;
  exchange: string;
}

function legEvents(leg: OpportunityLeg, side: "long" | "short", now: number, windowMs: number, fallback: number): TimelineEvent[] {
  if (!leg.next_funding_time) return [];
  const interval = (leg.funding_interval_hours ?? fallback) * 3_600_000;
  let at = new Date(leg.next_funding_time).getTime();
  while (at <= now) at += interval;
  const events: TimelineEvent[] = [];
  for (; at <= now + windowMs; at += interval) {
    events.push({ at, side, exchange: leg.exchange, amount: side === "long" ? -leg.funding_rate : leg.funding_rate });
  }
  return events;
}

/** The next 24h of settlements per leg: what lands when, and whether it pays or costs you. */
function SettlementTimeline({ opportunity }: { opportunity: ArbitrageOpportunity }) {
  const now = useClock();
  const minuteNow = Math.floor(now / 60_000) * 60_000;
  const windowMs = 24 * 3_600_000;
  const events = useMemo(
    () => [
      ...legEvents(opportunity.long_leg, "long", minuteNow, windowMs, opportunity.funding_interval_hours),
      ...legEvents(opportunity.short_leg, "short", minuteNow, windowMs, opportunity.funding_interval_hours),
    ],
    [opportunity, minuteNow, windowMs],
  );
  const total = events.reduce((sum, event) => sum + event.amount, 0);
  return (
    <>
      <div className="t-timeline" aria-label="Settlements in the next 24 hours">
        <div className="t-timeline-axis" />
        {events.map((event) => (
          <span
            key={`${event.side}-${event.at}`}
            className="t-tick"
            data-side={event.side}
            style={{ left: `${((event.at - minuteNow) / windowMs) * 100}%` }}
            title={`${EXCHANGE_SHORT[event.exchange]} at ${new Date(event.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
          >
            <span className={`t-num ${event.amount >= 0 ? "t-receive" : "t-pay"}`}>{pct(event.amount * 100, 3, true)}</span>
            <i style={{ background: `var(--x-${event.exchange})` }} />
          </span>
        ))}
      </div>
      <div className="t-timeline-scale">
        <span>Now</span>
        <span className="t-num">
          24h total <span className={total >= 0 ? "t-receive" : "t-pay"}>{pct(total * 100, 4, true)}</span>
        </span>
        <span>+24h</span>
      </div>
    </>
  );
}

function LegCard({ leg, side, fallback, notional }: { leg: OpportunityLeg; side: "long" | "short"; fallback: number; notional: number }) {
  const youReceive = side === "long" ? leg.funding_rate < 0 : leg.funding_rate > 0;
  return (
    <a className="t-leg" href={leg.trade_url} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
      <span className="t-leg-side">{side === "long" ? "Long (buy)" : "Short (sell)"} on</span>
      <strong style={{ color: `var(--x-${leg.exchange})` }}>{leg.display_name}</strong>
      <span className={`t-leg-rate t-num ${youReceive ? "t-receive" : "t-pay"}`}>{legRateLabel(leg, fallback)}</span>
      <span className="t-muted">{youReceive ? "You receive this" : "You pay this"}</span>
      <dl className="t-kv">
        <div>
          <dt>Pays in</dt>
          <dd><Countdown target={leg.next_funding_time} /></dd>
        </div>
        <div>
          <dt>Mark</dt>
          <dd className="t-num">{formatPrice(leg.mark_price)}</dd>
        </div>
        <div>
          <dt>Book cost (${notional.toLocaleString()})</dt>
          <dd className="t-num">
            {leg.depth_fillable === false ? <span className="t-pay">can't fill</span> : leg.slippage_round_trip_percent != null ? pct(leg.slippage_round_trip_percent, 3) : "estimated"}
          </dd>
        </div>
        <div>
          <dt>Taker fee</dt>
          <dd className="t-num">{pct(leg.taker_fee_bps / 100, 3)}</dd>
        </div>
      </dl>
    </a>
  );
}

export function DetailContent({
  opportunity,
  scale,
  horizonLabel,
  onClose,
  exchangesQuery,
  captureFirst = false,
  positions = [],
}: {
  positions?: TradeSessionResponse[];
  opportunity: ArbitrageOpportunity;
  scale: EdgeScale;
  horizonLabel: string;
  onClose: () => void;
  exchangesQuery: string;
  captureFirst?: boolean;
}) {
  const history = useHistory(opportunity.canonical_symbol);
  const flags = riskFlags(opportunity);
  const { comparison, loading: comparisonLoading } = useSymbolComparison(opportunity.canonical_symbol, [], "hold");
  const exchangeRows = useMemo(
    () => [...(comparison?.exchanges ?? [])].sort((a, b) => b.funding_rate / (b.funding_interval_hours || 8) - a.funding_rate / (a.funding_interval_hours || 8)),
    [comparison],
  );
  const profitable = opportunity.net_return_percent > 0;
  const perCycle = opportunity.spread_rate_hourly * opportunity.funding_interval_hours * 100;
  const notional = opportunity.reference_notional_usd;
  const [copied, setCopied] = useState(false);

  const summary = `${opportunity.base_asset}: long ${opportunity.long_leg.display_name} (${legRateLabel(opportunity.long_leg, opportunity.funding_interval_hours)}), short ${opportunity.short_leg.display_name} (${legRateLabel(opportunity.short_leg, opportunity.funding_interval_hours)}). Net ${pct(opportunity.net_return_percent, 3, true)} over ${horizonLabel} after ${pct(opportunity.estimated_total_cost_percent, 3)} costs; break-even ${hoursLabel(opportunity.break_even_hours)}; ${opportunity.trust_level} trust.`;

  return (
    <>
      <div className="t-detail-head">
        <div>
          <h2>{opportunity.base_asset}</h2>
          <TrustBadge level={opportunity.trust_level} />
          <RiskChips opportunity={opportunity} max={4} />
        </div>
        <button type="button" className="t-icon-btn" onClick={onClose} aria-label="Close details">
          {Icon.close}
        </button>
      </div>

      <PositionNote trades={positions} symbol={opportunity.canonical_symbol} />

      {captureFirst && opportunity.capture ? (
        <>
          <div className="t-section" style={{ marginTop: 6 }}>
            <h3>Next settlement</h3>
            <CaptureBlock row={opportunity as CaptureRow} notional={notional} exchangesQuery={exchangesQuery} />
          </div>
          <h3 className="t-subhead" style={{ marginTop: 26 }}>
            If you hold for {horizonLabel} instead
          </h3>
        </>
      ) : null}

      <p className="t-detail-sentence">
        Buy on <strong>{opportunity.long_leg.display_name}</strong> and sell the same size on <strong>{opportunity.short_leg.display_name}</strong>. If rates hold you
        collect about <strong className="t-num">{pct(perCycle, 4)}</strong> every {opportunity.funding_interval_hours}h, which covers costs after{" "}
        <strong>{hoursLabel(opportunity.break_even_hours)}</strong>.
      </p>

      <div className="t-bigline">
        <strong className={`t-num ${profitable ? "t-receive" : "t-pay"}`}>{pct(opportunity.net_return_percent, 3, true)}</strong>
        <span className="t-soft">
          net over {horizonLabel}, <span className="t-num">{pct(opportunity.net_apr_percent, 1)}</span> a year
        </span>
      </div>
      <EdgeLine opportunity={opportunity} scale={scale} height={30} />

      <div className="t-section">
        <h3>All exchanges for {opportunity.base_asset}</h3>
        <AllExchanges opportunity={opportunity} rows={exchangeRows} loading={comparisonLoading} />
      </div>

      <div className="t-section">
        <div className="t-leg-grid">
          <LegCard leg={opportunity.long_leg} side="long" fallback={opportunity.funding_interval_hours} notional={notional} />
          <LegCard leg={opportunity.short_leg} side="short" fallback={opportunity.funding_interval_hours} notional={notional} />
        </div>
      </div>

      <div className="t-section">
        <h3>Next 24 hours</h3>
        <SettlementTimeline opportunity={opportunity} />
      </div>

      <div className="t-section">
        <h3>Money over {horizonLabel}, per ${notional.toLocaleString()} leg</h3>
        <dl className="t-kv">
          <div>
            <dt>Funding collected</dt>
            <dd className="t-num t-receive">{pct(opportunity.expected_funding_percent, 3, true)}</dd>
          </div>
          <div>
            <dt>Fees, entry and exit on both legs</dt>
            <dd className="t-num t-pay">{pct(-opportunity.estimated_round_trip_fee_percent, 3, true)}</dd>
          </div>
          <div>
            <dt>
              Slippage{" "}
              {opportunity.slippage_source === "orderbook" ? "(live order books)" : opportunity.slippage_source === "mixed" ? "(one book measured)" : "(estimated)"}
            </dt>
            <dd className="t-num t-pay">{pct(-opportunity.estimated_slippage_percent * 2, 3, true)}</dd>
          </div>
          <div data-total="true">
            <dt>Net</dt>
            <dd className={`t-num ${profitable ? "t-receive" : "t-pay"}`}>
              {pct(opportunity.net_return_percent, 3, true)} ≈ ${((opportunity.net_return_percent / 100) * notional).toFixed(2)}
            </dd>
          </div>
        </dl>
      </div>

      <div className="t-section">
        <h3>Does this edge last?</h3>
        <PersistenceBlock opportunity={opportunity} points={history} />
      </div>

      <div className="t-section">
        <h3>Spread history</h3>
        <Sparkline points={history} />
      </div>

      <div className="t-section">
        <h3>How often it has paid</h3>
        <BacktestConfidence baseAsset={opportunity.base_asset} />
      </div>

      <div className="t-section">
        <h3>How much you can trade</h3>
        <DepthBlock symbol={opportunity.canonical_symbol} longExchange={opportunity.long_leg.exchange} shortExchange={opportunity.short_leg.exchange} />
      </div>

      <div className="t-section">
        <h3>Funding rate history</h3>
        <TrendBlock
          symbol={opportunity.canonical_symbol}
          exchanges={exchangeRows.length ? exchangeRows.map((row) => row.exchange) : [opportunity.long_leg.exchange, opportunity.short_leg.exchange]}
          intervals={Object.fromEntries(exchangeRows.map((row) => [row.exchange, row.funding_interval_hours]))}
        />
      </div>

      <div className="t-section">
        <h3>Why this trust level{flags.length ? `, ${flags.length} to check` : ""}</h3>
        <ul className="t-checks">
          {opportunity.trust_checks.map((check) => (
            <li key={`${check.key}-${check.detail}`} className="t-check" data-status={check.status}>
              {Icon[check.status]}
              <div>
                <strong>{check.label}</strong>
                <span>{check.detail}</span>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="t-actions">
        <a className="t-btn" data-primary="true" href={tradeHref(opportunity.canonical_symbol, exchangesQuery, captureFirst ? "capture" : "hold")}>
          Paper or live trade
        </a>
        <a className="t-btn" href={`/compare/${encodeURIComponent(opportunity.canonical_symbol)}${exchangesQuery}`}>
          Compare all exchanges
        </a>
        <button
          type="button"
          className="t-btn"
          onClick={() => {
            void navigator.clipboard?.writeText(summary).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1600);
            });
          }}
        >
          {copied ? "Copied" : "Copy summary"}
        </button>
      </div>
    </>
  );
}

/** Bottom sheet on phones (drag down to dismiss), side sheet on tablets. */
export function DetailSheet({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  const [drag, setDrag] = useState<{ start: number; offset: number } | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  return (
    <>
      <div className="t-sheet-scrim" onClick={onClose} />
      <aside
        className="t-sheet"
        role="dialog"
        aria-modal="true"
        style={drag ? { transform: `translateY(${Math.max(0, drag.offset)}px)`, transition: "none" } : undefined}
        onTouchStart={(event) => {
          const sheet = event.currentTarget;
          if (sheet.scrollTop <= 0) setDrag({ start: event.touches[0].clientY, offset: 0 });
        }}
        onTouchMove={(event) => {
          if (drag) setDrag({ ...drag, offset: event.touches[0].clientY - drag.start });
        }}
        onTouchEnd={() => {
          if (drag && drag.offset > 110) onClose();
          setDrag(null);
        }}
      >
        <div className="t-grabber" aria-hidden="true" />
        {children}
      </aside>
    </>
  );
}
