import { useMemo, useState } from "react";
import { useClock } from "./clock";
import { EXCHANGE_SHORT, ExchangeTag, pct } from "./primitives";
import { Empty } from "./states";
import type { RateRow } from "./useDashboard";

const DAY = 24 * 3_600_000;
const SLOT = 5 * 60_000;

interface Payment {
  symbol: string;
  exchange: string;
  at: number;
  rate: number;
}

/** Every payment in the next 24 hours, from each exchange's next settlement and cycle length. */
function upcoming(rates: Record<string, RateRow[]>, exchanges: string[], now: number): Payment[] {
  const out: Payment[] = [];
  for (const [symbol, rows] of Object.entries(rates)) {
    for (const row of rows) {
      if (!exchanges.includes(row.exchange) || !row.next_funding_time) continue;
      const step = Math.max(row.interval_hours || 8, 1) * 3_600_000;
      for (let at = new Date(row.next_funding_time).getTime(); at <= now + DAY; at += step) {
        if (at >= now) out.push({ symbol, exchange: row.exchange, at, rate: row.rate });
      }
    }
  }
  return out;
}

function clock(time: number) {
  return new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** 24-hour timeline with a lane per exchange, so coins that pay close together are easy to line up. */
export function CalendarView({ rates, exchanges, onOpen }: { rates: Record<string, RateRow[]>; exchanges: string[]; onOpen: (symbol: string) => void }) {
  const minute = Math.floor(useClock() / 60_000);
  const now = minute * 60_000;
  const payments = useMemo(() => upcoming(rates, exchanges, now), [rates, exchanges, now]);
  const [slot, setSlot] = useState<number | null>(null);

  const slots = useMemo(() => {
    const map = new Map<number, Payment[]>();
    for (const payment of payments) {
      const key = Math.round(payment.at / SLOT) * SLOT;
      map.set(key, [...(map.get(key) ?? []), payment]);
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [payments]);

  if (!payments.length) return <Empty title="No settlements scheduled" body="Payment times appear once the exchanges report their next funding time." />;

  const chosen = slot != null ? slots.find(([key]) => key === slot) ?? slots[0] : slots[0];
  const chosenPayments = [...(chosen?.[1] ?? [])].sort((a, b) => Math.abs(b.rate) - Math.abs(a.rate));
  const x = (time: number) => Math.max(0, Math.min(100, ((time - now) / DAY) * 100));
  const hourTicks = Array.from({ length: 9 }, (_, index) => now + index * 3 * 3_600_000);

  return (
    <div className="t-panel cal-panel">
      <h3>Next 24 hours of funding payments</h3>
      <p className="t-subhead">Each dot is a moment when coins settle on that exchange. Bigger means more coins. Tap one to see which.</p>
      <div className="cal-lanes">
        {exchanges.map((exchange) => {
          const lane = slots.map(([key, list]) => [key, list.filter((payment) => payment.exchange === exchange)] as const).filter(([, list]) => list.length);
          return (
            <div key={exchange} className="cal-lane">
              <span className="cal-name" style={{ color: `var(--x-${exchange})` }}>{EXCHANGE_SHORT[exchange] ?? exchange}</span>
              <div className="cal-track">
                {lane.map(([key, list]) => (
                  <button
                    key={key}
                    type="button"
                    className="cal-dot"
                    data-active={chosen?.[0] === key}
                    style={{ left: `${x(key)}%`, width: 10 + Math.min(18, Math.sqrt(list.length) * 3), height: 10 + Math.min(18, Math.sqrt(list.length) * 3), background: `var(--x-${exchange})` }}
                    aria-label={`${list.length} coins on ${EXCHANGE_SHORT[exchange]} at ${clock(key)}`}
                    title={`${clock(key)}: ${list.length} coins`}
                    onClick={() => setSlot(key)}
                  />
                ))}
              </div>
            </div>
          );
        })}
        <div className="cal-axis" aria-hidden="true">
          <span className="cal-name" />
          <div className="cal-track cal-ticks">
            {hourTicks.map((tick) => (
              <span key={tick} style={{ left: `${x(tick)}%` }} className="t-num">
                {clock(tick)}
              </span>
            ))}
          </div>
        </div>
      </div>

      {chosen ? (
        <div className="cal-detail">
          <h4 className="t-subhead" style={{ margin: "18px 0 6px" }}>
            {clock(chosen[0])}: {chosenPayments.length} payments across {new Set(chosenPayments.map((payment) => payment.exchange)).size} exchange
            {new Set(chosenPayments.map((payment) => payment.exchange)).size > 1 ? "s" : ""}
          </h4>
          <ul className="t-list">
            {chosenPayments.slice(0, 12).map((payment) => (
              <li key={`${payment.symbol}-${payment.exchange}`}>
                <button type="button" className="t-list-row" onClick={() => onOpen(payment.symbol)}>
                  <span>
                    <strong>{payment.symbol.split("-")[0]}</strong> <ExchangeTag exchange={payment.exchange} />
                  </span>
                  <span className={`t-num ${payment.rate >= 0 ? "t-receive" : "t-pay"}`}>{pct(payment.rate * 100, 4, true)}</span>
                </button>
              </li>
            ))}
          </ul>
          {chosenPayments.length > 12 ? <p className="t-muted">and {chosenPayments.length - 12} more</p> : null}
        </div>
      ) : null}
    </div>
  );
}
