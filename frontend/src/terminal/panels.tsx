import { FormEvent, useEffect, useMemo, useState } from "react";
import { buildOpportunityCsv } from "../lib/monitor";
import type { ArbitrageOpportunity, ExchangeStatus } from "../lib/types";
import { useClock } from "./clock";
import { Icon, pct } from "./primitives";

const API_BASE = import.meta.env.VITE_API_URL ?? "/api";

export function downloadCsv(rows: ArbitrageOpportunity[]) {
  const csv = buildOpportunityCsv(rows);
  if (!csv) return;
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `fundex-${new Date().toISOString().slice(0, 16).replace(":", "")}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function ago(iso: string | null | undefined, now: number) {
  if (!iso) return "never";
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  return seconds < 90 ? `${seconds}s ago` : `${Math.round(seconds / 60)}m ago`;
}

/** The desk's vital signs, with a live "updated" clock so a stalled feed is obvious. */
export function PulseStrip({
  rows,
  all,
  profitable,
  profitableLabel,
  receivedAt,
  link,
  onOpenFeeds,
}: {
  rows: ArbitrageOpportunity[];
  all: ArbitrageOpportunity[];
  profitable: number;
  profitableLabel: string;
  receivedAt: number | null;
  link: string;
  onOpenFeeds: () => void;
}) {
  const now = useClock();
  const stats = useMemo(() => {
    const avgScore = all.length ? (all.reduce((sum, row) => sum + row.confidence_score, 0) / all.length) * 100 : 0;
    const widest = all.reduce((best, row) => Math.max(best, row.spread_rate), 0);
    return { avgScore, widest };
  }, [all]);
  const age = receivedAt ? Math.max(0, Math.round((now - receivedAt) / 1000)) : null;
  return (
    <div className="t-pulse" aria-label="Desk summary">
      <span>
        <b className="t-num">{rows.length}</b> shown of <span className="t-num">{all.length}</span> pairs
      </span>
      <span>
        <b className={`t-num ${profitable ? "t-receive" : "t-pay"}`}>{profitable}</b> {profitableLabel}
      </span>
      <span>
        Average trust score <b className="t-num">{stats.avgScore.toFixed(0)}</b>
      </span>
      <span>
        Widest spread <b className="t-num">{pct(stats.widest * 100, 4)}</b> /8h
      </span>
      <button type="button" className="t-pulse-feeds" onClick={onOpenFeeds}>
        <span className="t-dot" data-state={link === "live" ? undefined : link === "paused" ? "off" : "degraded"} />
        <span>
          {link === "paused" ? "Paused" : link === "live" ? "Live" : "Polling"}
          {age != null ? `, updated ${age}s ago` : ""}
        </span>
      </button>
    </div>
  );
}

export function FeedsPanel({ statuses }: { statuses: ExchangeStatus[] }) {
  const now = useClock();
  return (
    <ul className="t-feeds">
      {statuses.map((status) => {
        const state = !status.enabled
          ? "Off"
          : !status.configured
            ? "Needs API key"
            : status.last_error
              ? "Error"
              : status.healthy
                ? "Healthy"
                : "Waiting";
        return (
          <li key={status.exchange}>
            <span className="t-feed-name">
              <span className="t-dot" style={{ background: `var(--x-${status.exchange})` }} data-state={state === "Healthy" ? undefined : state === "Error" ? "down" : "off"} />
              <strong>{status.display_name}</strong>
            </span>
            <span className={state === "Error" ? "t-pay" : state === "Healthy" ? "t-receive" : "t-muted"}>{state}</span>
            <span className="t-num t-muted">{status.snapshot_count} contracts</span>
            <span className="t-num t-muted">updated {ago(status.last_success_at, now)}</span>
            {status.last_error ? <span className="t-feed-error">{status.last_error}</span> : null}
            {!status.configured && status.exchange === "coinswitch" ? (
              <span className="t-feed-error t-muted">Add a CoinSwitch API key with the key button to monitor it.</span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export function CompareDialog({ exchangesQuery, onClose, initial }: { exchangesQuery: string; onClose: () => void; initial: string }) {
  const [symbols, setSymbols] = useState<string[]>([]);
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/symbols`)
      .then((response) => (response.ok ? response.json() : []))
      .then((rows: string[]) => !cancelled && setSymbols(rows))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const query = value.trim().toUpperCase();
    const match = symbols.find((symbol) => symbol === query) ?? symbols.find((symbol) => symbol.split("-")[0] === query);
    if (!match) {
      setError(symbols.length ? `No live pair for "${value}". Try a ticker like BTC or SOL.` : "Coin list is still loading; try again in a moment.");
      return;
    }
    window.location.href = `/compare/${encodeURIComponent(match)}${exchangesQuery}`;
  };
  return (
    <Dialog title="Compare a coin across exchanges" onClose={onClose}>
      <form onSubmit={submit} className="t-form-row">
        <label className="t-field" style={{ flex: 1 }}>
          Coin
          <input list="t-symbols" value={value} onChange={(event) => setValue(event.target.value)} placeholder="BTC" autoFocus />
          <datalist id="t-symbols">
            {symbols.map((symbol) => (
              <option key={symbol} value={symbol.split("-")[0]} />
            ))}
          </datalist>
        </label>
        <button type="submit" className="t-btn" data-primary="true">
          Compare
        </button>
      </form>
      {error ? <p className="t-pay">{error}</p> : <p className="t-muted">Shows every exchange's rate, interval, timing, fees and the trade planner for that coin.</p>}
    </Dialog>
  );
}

export function Dialog({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <>
      <div className="t-sheet-scrim" onClick={onClose} />
      <div className={`t-dialog ${wide ? "t-dialog-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="t-detail-head" style={{ marginBottom: 8 }}>
          <h2 style={{ fontSize: 22 }}>{title}</h2>
          <button type="button" className="t-icon-btn" onClick={onClose} aria-label="Close">
            {Icon.close}
          </button>
        </div>
        {children}
      </div>
    </>
  );
}
