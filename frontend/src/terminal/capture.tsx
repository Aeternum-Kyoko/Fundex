import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ArbitrageOpportunity, CaptureLeg, CaptureSetup } from "../lib/types";
import { useClock } from "./clock";
import { compareHref, tradeHref } from "./pairs";
import { Countdown, EXCHANGE_SHORT, ExchangeTag, pct, TrustBadge } from "./primitives";

export type CaptureRow = ArbitrageOpportunity & { capture: CaptureSetup };

const MEANINGFUL_CAPTURE_PERCENT = 0.01;

export function whoPays(capture: CaptureSetup) {
  if (capture.settling === "both") return "Both legs settle";
  const leg = capture.settling === "long" ? capture.long_leg : capture.short_leg;
  return `Only ${EXCHANGE_SHORT[leg.exchange]} settles`;
}

export function dollars(percent: number, notional: number) {
  const value = (percent / 100) * notional;
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function useAnchor() {
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

/** Urgency colour for the countdown: amber inside 15 minutes (time to get in), coral inside 2. */
function CaptureClock({ target, large = false }: { target: string; large?: boolean }) {
  const now = useClock();
  const minutes = (new Date(target).getTime() - now) / 60_000;
  const state = minutes <= 2 ? "now" : minutes <= 15 ? "soon" : "later";
  return (
    <span className={`t-capture-clock ${large ? "t-capture-clock-large" : ""}`} data-state={state}>
      <Countdown target={target} />
    </span>
  );
}

function LegLine({ leg, side }: { leg: CaptureLeg; side: "long" | "short" }) {
  return (
    <span className="t-capture-leg" data-settles={leg.settles_in_window}>
      <span className="t-muted">{side === "long" ? "Buy" : "Sell"}</span> <ExchangeTag exchange={leg.exchange} />
    </span>
  );
}

export function CaptureTable({
  rows,
  selected,
  onSelect,
  notional,
  exchangesQuery,
}: {
  rows: CaptureRow[];
  selected: string | null;
  onSelect: (symbol: string) => void;
  notional: number;
  exchangesQuery: string;
}) {
  const [anchor, scrollMargin] = useAnchor();
  const virtualizer = useWindowVirtualizer({ count: rows.length, estimateSize: () => 60, overscan: 8, scrollMargin });
  return (
    <div className="t-table t-capture-table" role="table" aria-label="Next funding captures">
      <div className="t-head" role="row">
        <span>Pair</span>
        <span title="Live countdown to the settlement this setup captures">Funding in</span>
        <span>Who pays then</span>
        <span className="t-right" title="Funding collected at that settlement, % of each leg's notional">Collect</span>
        <span className="t-right" title="Taker fees in and out on both legs, plus slippage">Costs</span>
        <span className="t-right" title={`Collect minus costs, per $${notional.toLocaleString()} leg`}>Net per capture</span>
        <span>Data</span>
        <span className="t-right">Open</span>
      </div>
      <div ref={anchor} style={{ position: "relative", height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          return (
            <CaptureRowView
              key={row.canonical_symbol}
              row={row}
              selected={row.canonical_symbol === selected}
              onSelect={onSelect}
              top={item.start - scrollMargin}
              notional={notional}
              exchangesQuery={exchangesQuery}
            />
          );
        })}
      </div>
    </div>
  );
}

const CaptureRowView = memo(function CaptureRowView({
  row,
  selected,
  onSelect,
  top,
  notional,
  exchangesQuery,
}: {
  row: CaptureRow;
  selected: boolean;
  onSelect: (symbol: string) => void;
  top: number;
  notional: number;
  exchangesQuery: string;
}) {
  const capture = row.capture;
  const stop = (event: React.SyntheticEvent) => event.stopPropagation();
  return (
    <div
      role="row"
      tabIndex={0}
      className="t-row"
      data-selected={selected}
      style={{ transform: `translateY(${top}px)` }}
      onClick={() => onSelect(row.canonical_symbol)}
      onKeyDown={(event) => event.key === "Enter" && onSelect(row.canonical_symbol)}
    >
      <span className="t-coin">
        <strong>{row.base_asset}</strong>
        <span className="t-legs">
          <LegLine leg={capture.long_leg} side="long" />
          <LegLine leg={capture.short_leg} side="short" />
        </span>
      </span>
      <CaptureClock target={capture.settles_at} />
      <span className="t-soft" style={{ fontSize: 13.5 }}>
        {whoPays(capture)}
      </span>
      <span className={`t-num t-right ${capture.capture_percent >= 0 ? "t-receive" : "t-pay"}`}>{pct(capture.capture_percent, 4, true)}</span>
      <span className="t-num t-right t-soft">{pct(-capture.cost_percent, 3, true)}</span>
      <span className="t-cell-stack t-right">
        <span className={`t-num ${capture.net_percent > 0 ? "t-receive" : "t-pay"}`}>{pct(capture.net_percent, 3, true)}</span>
        <small className="t-num">{dollars(capture.net_percent, notional)}</small>
      </span>
      <span>
        <TrustBadge level={capture.data_trust_level} compact />
      </span>
      <span className="t-row-actions">
        <a href={compareHref(row.canonical_symbol, exchangesQuery)} onClick={stop}>
          Compare
        </a>
        <a href={tradeHref(row.canonical_symbol, exchangesQuery)} onClick={stop}>
          Trade
        </a>
      </span>
    </div>
  );
});

export function CaptureCards({
  rows,
  onSelect,
  notional,
  exchangesQuery,
}: {
  rows: CaptureRow[];
  onSelect: (symbol: string) => void;
  notional: number;
  exchangesQuery: string;
}) {
  const [anchor, scrollMargin] = useAnchor();
  const virtualizer = useWindowVirtualizer({ count: rows.length, estimateSize: () => 168, overscan: 5, scrollMargin });
  return (
    <div ref={anchor} className="t-cards" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((item) => {
        const row = rows[item.index];
        const capture = row.capture;
        const stop = (event: React.SyntheticEvent) => event.stopPropagation();
        return (
          <div
            key={row.canonical_symbol}
            role="button"
            tabIndex={0}
            className="t-card"
            style={{ transform: `translateY(${item.start - scrollMargin}px)`, height: 156 }}
            onClick={() => onSelect(row.canonical_symbol)}
          >
            <span className="t-card-top">
              <strong>{row.base_asset}</strong>
              <CaptureClock target={capture.settles_at} />
            </span>
            <span className="t-card-meta">
              <span className="t-legs">
                <LegLine leg={capture.long_leg} side="long" />
                <LegLine leg={capture.short_leg} side="short" />
              </span>
              <span>{whoPays(capture)}</span>
            </span>
            <span className="t-card-meta">
              <span className="t-num">
                Collect <b className={capture.capture_percent >= 0 ? "t-receive" : "t-pay"}>{pct(capture.capture_percent, 4, true)}</b>
              </span>
              <span className="t-num">Costs {pct(capture.cost_percent, 3)}</span>
              <span className={`t-card-money t-num ${capture.net_percent > 0 ? "t-receive" : "t-pay"}`} style={{ fontSize: 17 }}>
                {dollars(capture.net_percent, notional)}
              </span>
            </span>
            <span className="t-card-meta">
              <TrustBadge level={capture.data_trust_level} compact />
              <span className="t-row-actions">
                <a href={compareHref(row.canonical_symbol, exchangesQuery)} onClick={stop}>
                  Compare
                </a>
                <a href={tradeHref(row.canonical_symbol, exchangesQuery)} onClick={stop}>
                  Trade
                </a>
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Three honest picks: best net, biggest payment, soonest settlement. Says plainly when fees win. */
export function CapturePicks({ rows, notional, onOpen }: { rows: CaptureRow[]; notional: number; onOpen: (symbol: string) => void }) {
  const picks = useMemo(() => {
    // Ignore near-zero payments: they "win" on net only because their costs are low.
    const meaningful = rows.filter((row) => row.capture.capture_percent >= MEANINGFUL_CAPTURE_PERCENT);
    const byNet = [...meaningful].sort((a, b) => b.capture.net_percent - a.capture.net_percent)[0];
    const byGross = [...rows].sort((a, b) => b.capture.capture_percent - a.capture.capture_percent)[0];
    const soonest = [...meaningful].sort(
      (a, b) => a.capture.settles_at.localeCompare(b.capture.settles_at) || b.capture.capture_percent - a.capture.capture_percent,
    )[0];
    const list: Array<[string, CaptureRow]> = [];
    const add = (label: string, row: CaptureRow | undefined) => {
      if (row && !list.some(([, existing]) => existing.canonical_symbol === row.canonical_symbol)) list.push([label, row]);
    };
    if (byNet && byNet.capture.net_percent > 0) {
      add("Best capture right now", byNet);
      add("Biggest payment", byGross);
    } else {
      add("Biggest payment", byGross);
      add("Closest to covering costs", byNet);
    }
    add("Soonest meaningful settlement", soonest);
    return list;
  }, [rows]);
  if (!picks.length) return null;
  const anyProfitable = rows.some((row) => row.capture.net_percent > 0);
  return (
    <>
      {!anyProfitable ? (
        <p className="t-capture-note">
          At ${notional.toLocaleString()} per leg with taker fees, no single settlement pays more than it costs right now. Lower fees (maker orders, a VIP tier set under More, Exchange API keys) or a bigger payment would change that; the closest setups are below.
        </p>
      ) : null}
      <section className="t-best" aria-label="Next funding picks">
        {picks.map(([label, row], index) => {
          const capture = row.capture;
          const shortName = EXCHANGE_SHORT[capture.short_leg.exchange];
          const longName = EXCHANGE_SHORT[capture.long_leg.exchange];
          return (
            <button key={row.canonical_symbol} type="button" className="t-best-card" data-lead={index === 0 && capture.net_percent > 0} onClick={() => onOpen(row.canonical_symbol)}>
              <span className="t-best-kicker">{label}</span>
              <h2 className="t-best-title">
                {row.base_asset}: sell on {shortName}, buy on {longName}
              </h2>
              <span className="t-best-money">
                <CaptureClock target={capture.settles_at} large={index === 0} />
                <span className="t-soft">until {new Date(capture.settles_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
              </span>
              <span className="t-card-meta">
                <span className="t-num">
                  Collect <b className={capture.capture_percent >= 0 ? "t-receive" : "t-pay"}>{pct(capture.capture_percent, 4, true)}</b>
                </span>
                <span className="t-num">costs {pct(capture.cost_percent, 3)}</span>
                <span className={`t-num ${capture.net_percent > 0 ? "t-receive" : "t-pay"}`}>
                  net {dollars(capture.net_percent, notional)}
                </span>
              </span>
              <span className="t-card-meta">
                <span>{whoPays(capture)}</span>
                <TrustBadge level={capture.data_trust_level} compact />
              </span>
            </button>
          );
        })}
      </section>
    </>
  );
}

/** Detail block: exactly what happens at the next settlement and what it nets. */
export function CaptureBlock({ row, notional, exchangesQuery }: { row: CaptureRow; notional: number; exchangesQuery: string }) {
  const capture = row.capture;
  const time = new Date(capture.settles_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <div className="t-capture-block">
      <div className="t-bigline" style={{ alignItems: "center" }}>
        <CaptureClock target={capture.settles_at} large />
        <span className="t-soft">until the {time} settlement</span>
      </div>
      <p className="t-detail-sentence">
        Sell {row.base_asset} on <strong>{capture.short_leg.display_name}</strong> and buy the same size on <strong>{capture.long_leg.display_name}</strong> just before {time}, then
        close both right after. {whoPays(capture)} at that moment.
      </p>
      <dl className="t-kv">
        {[capture.short_leg, capture.long_leg].map((leg) => (
          <div key={leg.exchange}>
            <dt>
              {leg === capture.short_leg ? "Short" : "Long"} {leg.display_name} ({pct(leg.funding_rate * 100, 4, true)} / {leg.funding_interval_hours}h)
            </dt>
            <dd className={`t-num ${leg.payment > 0 ? "t-receive" : leg.payment < 0 ? "t-pay" : "t-muted"}`}>
              {leg.settles_in_window ? pct(leg.payment * 100, 4, true) : `settles later (${new Date(leg.next_funding_time ?? capture.settles_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })})`}
            </dd>
          </div>
        ))}
        <div>
          <dt>Fees, in and out on both legs</dt>
          <dd className="t-num t-pay">{pct(-capture.fee_percent, 3, true)}</dd>
        </div>
        <div>
          <dt>Slippage {capture.long_leg.slippage_measured && capture.short_leg.slippage_measured ? "(live order books)" : "(partly estimated)"}</dt>
          <dd className="t-num t-pay">{pct(-capture.slippage_percent, 3, true)}</dd>
        </div>
        <div data-total="true">
          <dt>Net for this settlement</dt>
          <dd className={`t-num ${capture.net_percent > 0 ? "t-receive" : "t-pay"}`}>
            {pct(capture.net_percent, 3, true)} ≈ {dollars(capture.net_percent, notional)} per ${notional.toLocaleString()} leg
          </dd>
        </div>
      </dl>
      <div className="t-actions">
        <a className="t-btn" data-primary="true" href={tradeHref(row.canonical_symbol, exchangesQuery)}>
          Arm on the trade desk (paper or live)
        </a>
      </div>
      <p className="t-muted" style={{ fontSize: 13, marginTop: 8 }}>
        The trade desk enters about 30 seconds before and exits about 15 seconds after the settlement by default. Rates can still move until {time}.
      </p>
    </div>
  );
}
