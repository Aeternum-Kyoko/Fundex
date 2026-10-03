import { useMemo, useState } from "react";
import type { ArbitrageOpportunity } from "../lib/types";
import { type CaptureRow, dollars } from "./capture";
import { useClock } from "./clock";
import { Countdown, EXCHANGE_SHORT, ExchangeTag, pct, TrustBadge } from "./primitives";
import { Empty } from "./states";
import type { RateRow } from "./useDashboard";

const HOUR = 3_600_000;
const HOURS_AHEAD = 24;

interface Payment {
  symbol: string;
  exchange: string;
  at: number;
  rate: number;
  interval: number;
}

/** Payments per clock hour for the next 24 hours, counted without building every payment. */
function hourCounts(rates: Record<string, RateRow[]>, exchanges: string[], start: number, now: number) {
  const buckets = Array.from({ length: HOURS_AHEAD + 1 }, () => ({} as Record<string, number>));
  const cycles: Record<string, Record<number, number>> = {};
  for (const rows of Object.values(rates)) {
    for (const row of rows) {
      if (!exchanges.includes(row.exchange) || !row.next_funding_time) continue;
      const step = Math.max(row.interval_hours || 8, 1) * HOUR;
      cycles[row.exchange] ??= {};
      cycles[row.exchange][row.interval_hours] = (cycles[row.exchange][row.interval_hours] ?? 0) + 1;
      for (let at = new Date(row.next_funding_time).getTime(); at < start + (HOURS_AHEAD + 1) * HOUR; at += step) {
        if (at < now) continue;
        const index = Math.floor((at - start) / HOUR);
        if (index >= 0 && index <= HOURS_AHEAD) buckets[index][row.exchange] = (buckets[index][row.exchange] ?? 0) + 1;
      }
    }
  }
  return { buckets, cycles };
}

function paymentsIn(rates: Record<string, RateRow[]>, exchanges: string[], from: number, now: number): Payment[] {
  const out: Payment[] = [];
  for (const [symbol, rows] of Object.entries(rates)) {
    for (const row of rows) {
      if (!exchanges.includes(row.exchange) || !row.next_funding_time) continue;
      const step = Math.max(row.interval_hours || 8, 1) * HOUR;
      for (let at = new Date(row.next_funding_time).getTime(); at < from + HOUR; at += step) {
        if (at >= from && at >= now) out.push({ symbol, exchange: row.exchange, at, rate: row.rate, interval: row.interval_hours });
      }
    }
  }
  return out;
}

function hourLabel(time: number, short = false) {
  const date = new Date(time);
  return short
    ? date.toLocaleTimeString([], { hour: "numeric" }).replace(" ", "").toLowerCase()
    : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function clock(time: number) {
  return new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function total(bucket: Record<string, number>) {
  return Object.values(bucket).reduce((sum, value) => sum + value, 0);
}

/** The next 24 hours of funding payments: how many pay each hour, which exchange, and which moments are worth a trade. */
export function CalendarView({
  rates,
  exchanges,
  opportunities,
  onOpen,
}: {
  rates: Record<string, RateRow[]>;
  exchanges: string[];
  opportunities: ArbitrageOpportunity[];
  onOpen: (symbol: string) => void;
}) {
  const minute = Math.floor(useClock() / 60_000);
  const now = minute * 60_000;
  // Buckets follow the viewer's clock hours (not UTC hours), so half-hour time zones like India still read 9pm to 10pm.
  const zoneMs = new Date(now).getTimezoneOffset() * 60_000;
  const start = Math.floor((now - zoneMs) / HOUR) * HOUR + zoneMs;
  const { buckets, cycles } = useMemo(() => hourCounts(rates, exchanges, start, now), [rates, exchanges, start, now]);

  // Best capture per hour: the setup whose settlement lands in that hour with the highest net.
  const bestByHour = useMemo(() => {
    const map = new Map<number, CaptureRow>();
    for (const row of opportunities) {
      if (!row.capture || row.capture.capture_percent <= 0) continue;
      const index = Math.floor((new Date(row.capture.settles_at).getTime() - start) / HOUR);
      if (index < 0 || index > HOURS_AHEAD) continue;
      const current = map.get(index);
      if (!current || row.capture.net_percent > current.capture.net_percent) map.set(index, row as CaptureRow);
    }
    return map;
  }, [opportunities, start]);

  const counts = buckets.map(total);
  const max = Math.max(...counts, 1);
  const firstIndex = counts.findIndex((count) => count > 0);
  const [picked, setPicked] = useState<number | null>(null);
  const selected = picked != null && counts[picked] ? picked : firstIndex;
  const [filter, setFilter] = useState<string>("all");

  const busiest = counts.reduce((best, count, index) => (count > counts[best] ? index : best), 0);
  const bestAhead = [...bestByHour.entries()].sort((a, b) => b[1].capture.net_percent - a[1].capture.net_percent)[0];

  const payments = useMemo(
    () => (selected >= 0 ? paymentsIn(rates, exchanges, start + selected * HOUR, now) : []),
    [rates, exchanges, start, selected, now],
  );
  const filtered = filter === "all" ? payments : payments.filter((payment) => payment.exchange === filter);
  const shorts = [...filtered].filter((payment) => payment.rate > 0).sort((a, b) => b.rate / b.interval - a.rate / a.interval).slice(0, 8);
  const longs = [...filtered].filter((payment) => payment.rate < 0).sort((a, b) => a.rate / a.interval - b.rate / b.interval).slice(0, 8);

  if (firstIndex < 0) return <Empty title="No settlements scheduled" body="Payment times appear once the exchanges report their next funding time." />;

  // The exact moment of the first payment, not the start of its hour.
  const nextAt = Object.values(rates)
    .flat()
    .filter((row) => exchanges.includes(row.exchange) && row.next_funding_time && new Date(row.next_funding_time).getTime() >= now)
    .reduce((soonest, row) => Math.min(soonest, new Date(row.next_funding_time as string).getTime()), Infinity);
  const best = selected >= 0 ? bestByHour.get(selected) : undefined;

  return (
    <div className="cal">
      <div className="cal-stats">
        <div className="cal-stat">
          <span className="cal-k">Next payments</span>
          <strong className="t-num">{hourLabel(nextAt)}</strong>
          <span className="t-soft">
            {counts[firstIndex].toLocaleString()} payments, in <Countdown target={new Date(nextAt).toISOString()} />
          </span>
        </div>
        <div className="cal-stat">
          <span className="cal-k">Busiest hour</span>
          <strong className="t-num">{hourLabel(start + busiest * HOUR)}</strong>
          <span className="t-soft">{counts[busiest].toLocaleString()} payments across {Object.keys(buckets[busiest]).length} exchanges</span>
        </div>
        <button type="button" className="cal-stat cal-stat-action" disabled={!bestAhead} onClick={() => bestAhead && setPicked(bestAhead[0])}>
          <span className="cal-k">Best capture ahead</span>
          {bestAhead ? (
            <>
              <strong>
                {bestAhead[1].base_asset} at {hourLabel(new Date(bestAhead[1].capture.settles_at).getTime())}
              </strong>
              <span className={bestAhead[1].capture.net_percent > 0 ? "t-receive" : "t-soft"}>
                collect {pct(bestAhead[1].capture.capture_percent, 4, true)}, net {pct(bestAhead[1].capture.net_percent, 3, true)}
              </span>
            </>
          ) : (
            <span className="t-soft">No settlement clears its costs</span>
          )}
        </button>
      </div>

      <section className="t-panel cal-chart-panel">
        <h3>
          Payments per hour
          <span className="cal-legend">
            {exchanges.map((exchange) => (
              <span key={exchange}>
                <i style={{ background: `var(--x-${exchange})` }} />
                {EXCHANGE_SHORT[exchange] ?? exchange}
              </span>
            ))}
          </span>
        </h3>
        <div className="cal-bars" role="group" aria-label="Payments per hour, pick an hour">
          {buckets.map((bucket, index) => {
            const count = counts[index];
            const best = bestByHour.get(index);
            return (
              <button
                key={index}
                type="button"
                className="cal-bar"
                data-active={index === selected}
                data-now={index === 0}
                disabled={!count}
                onClick={() => setPicked(index)}
                title={`${hourLabel(start + index * HOUR)}: ${count.toLocaleString()} payments${best ? `, best capture ${best.base_asset} ${pct(best.capture.net_percent, 3, true)}` : ""}`}
                aria-label={`${hourLabel(start + index * HOUR)}, ${count} payments`}
              >
                <span className="cal-flag" data-good={best != null && best.capture.net_percent > 0} data-on={best != null} />
                <span className="cal-stack" style={{ height: `${Math.max(count ? 4 : 0, (count / max) * 100)}%` }}>
                  {exchanges.map((exchange) => (bucket[exchange] ? <i key={exchange} style={{ flex: bucket[exchange], background: `var(--x-${exchange})` }} /> : null))}
                </span>
                <span className="cal-hour t-num">{index % 3 === 0 ? (index === 0 ? "now" : hourLabel(start + index * HOUR, true)) : ""}</span>
              </button>
            );
          })}
        </div>
        <p className="t-muted cal-foot">
          Bars count every coin paying that hour. A dot above a bar marks an hour with a capture that clears its costs <i className="cal-key" data-good="true" />, or the best one that does not <i className="cal-key" />.
        </p>
        <div className="cal-cycles">
          {exchanges
            .filter((exchange) => cycles[exchange])
            .map((exchange) => (
              <span key={exchange} className="cal-cycle">
                <ExchangeTag exchange={exchange} />
                {Object.entries(cycles[exchange])
                  .sort((a, b) => Number(a[0]) - Number(b[0]))
                  .map(([hours, count]) => (
                    <span key={hours} className="t-num t-muted">
                      {count} on {hours}h
                    </span>
                  ))}
              </span>
            ))}
        </div>
      </section>

      {selected >= 0 ? (
        <section className="t-panel cal-detail">
          <h3>
            <span>
              {hourLabel(start + selected * HOUR)} to {hourLabel(start + (selected + 1) * HOUR)}
              <span className="t-muted"> · {counts[selected].toLocaleString()} payments</span>
            </span>
            <span className="cal-filter" role="group" aria-label="Exchange filter">
              <button type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
                All
              </button>
              {exchanges
                .filter((exchange) => buckets[selected][exchange])
                .map((exchange) => (
                  <button key={exchange} type="button" aria-pressed={filter === exchange} style={{ "--x": `var(--x-${exchange})` } as React.CSSProperties} onClick={() => setFilter(exchange)}>
                    {EXCHANGE_SHORT[exchange] ?? exchange} <span className="t-num t-muted">{buckets[selected][exchange]}</span>
                  </button>
                ))}
            </span>
          </h3>

          {best ? (
            <button type="button" className="cal-best" onClick={() => onOpen(best.canonical_symbol)}>
              <span className="cal-k">Best capture this hour</span>
              <span className="cal-best-main">
                <strong>{best.base_asset}</strong>
                <span className="t-soft">
                  buy {EXCHANGE_SHORT[best.capture.long_leg.exchange]}, sell {EXCHANGE_SHORT[best.capture.short_leg.exchange]}
                </span>
                <span className="t-num t-receive">collect {pct(best.capture.capture_percent, 4, true)}</span>
                <span className={`t-num ${best.capture.net_percent > 0 ? "t-receive" : "t-pay"}`}>
                  net {pct(best.capture.net_percent, 3, true)} ({dollars(best.capture.net_percent, best.reference_notional_usd)})
                </span>
                <TrustBadge level={best.capture.data_trust_level} compact />
              </span>
            </button>
          ) : null}

          <div className="cal-cols">
            <PaymentColumn title="Shorts collect most" tone="receive" rows={shorts} onOpen={onOpen} />
            <PaymentColumn title="Longs collect most" tone="pay" rows={longs} onOpen={onOpen} />
          </div>
        </section>
      ) : null}
    </div>
  );
}

function PaymentColumn({ title, tone, rows, onOpen }: { title: string; tone: "receive" | "pay"; rows: Payment[]; onOpen: (symbol: string) => void }) {
  return (
    <div>
      <p className="t-subhead">{title}</p>
      {rows.length ? (
        <ul className="cal-list">
          {rows.map((payment) => (
            <li key={`${payment.symbol}-${payment.exchange}-${payment.at}`}>
              <button type="button" onClick={() => onOpen(payment.symbol)}>
                <span>
                  <strong>{payment.symbol.split("-")[0]}</strong> <ExchangeTag exchange={payment.exchange} />
                  <small className="t-muted t-num"> {clock(payment.at)} · every {payment.interval}h</small>
                </span>
                <span className={`t-num t-${tone}`}>{pct(payment.rate * 100, 4, true)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="t-muted">None in this selection.</p>
      )}
    </div>
  );
}
