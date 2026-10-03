import { useEffect, useMemo, useState } from "react";
import type { TradeSessionResponse } from "../lib/trade-types";
import { type CaptureRow, dollars, whoPays } from "./capture";
import { tradeHref } from "./pairs";
import { Countdown, EXCHANGE_SHORT, pct, TrustBadge } from "./primitives";
import { useDashboard } from "./useDashboard";
import "./design.css";

const API_BASE = import.meta.env.VITE_API_URL ?? "/api";
const FINAL = new Set(["completed", "failed", "cancelled"]);

function money(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function useJournal() {
  const [trades, setTrades] = useState<TradeSessionResponse[]>([]);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch(`${API_BASE}/trade/journal?limit=60`)
        .then((response) => (response.ok ? response.json() : []))
        .then((payload: TradeSessionResponse[]) => !cancelled && setTrades(payload))
        .catch(() => undefined);
    void load();
    const timer = window.setInterval(load, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);
  return trades;
}

/** Where trading starts: what is running, what settles next, and how recent trades went. */
export function TradeHub() {
  const { data, error } = useDashboard([]);
  const trades = useJournal();
  const running = useMemo(() => trades.filter((trade) => !FINAL.has(trade.status)), [trades]);
  const recent = useMemo(() => trades.filter((trade) => FINAL.has(trade.status)).slice(0, 8), [trades]);
  const notional = data?.reference_notional_usd ?? 1000;
  const upcoming = useMemo(
    () =>
      (data?.opportunities ?? [])
        .filter((row): row is CaptureRow => Boolean(row.capture) && (row.capture?.capture_percent ?? 0) >= 0.01)
        .sort((a, b) => a.capture.settles_at.localeCompare(b.capture.settles_at) || b.capture.net_percent - a.capture.net_percent)
        .slice(0, 12),
    [data],
  );

  return (
    <main className="t-main td-page">
      <header className="td-head">
        <div>
          <a className="td-back" href="/">Dashboard</a>
          <h1 className="td-title">Trade desk</h1>
          <p className="t-soft td-sub">
            Paper trades fill against live order books and settle at the real funding rate, so you can test a setup end to end before risking money.
          </p>
        </div>
        <div className="td-switches">
          <a className="t-btn" href="/performance">See all results</a>
        </div>
      </header>

      {error ? <div className="t-banner" role="alert">{error}</div> : null}

      {running.length ? (
        <section className="t-panel td-section">
          <h3>Running now</h3>
          <ul className="t-list">
            {running.map((trade) => (
              <li key={trade.id}>
                <a className="th-row" href={`/trade/${encodeURIComponent(trade.canonical_symbol)}`}>
                  <span>
                    <strong>{trade.canonical_symbol.split("-")[0]}</strong>{" "}
                    <span className="t-muted">
                      {trade.mode}, buy {EXCHANGE_SHORT[trade.long_leg.exchange]}, sell {EXCHANGE_SHORT[trade.short_leg.exchange]}: {trade.current_phase}
                    </span>
                  </span>
                  <span className="t-num">
                    {trade.status === "armed" ? (
                      <>
                        enters in <Countdown target={trade.scheduled_entry_at} />
                      </>
                    ) : (
                      <>
                        exits in <Countdown target={trade.scheduled_exit_at} />
                      </>
                    )}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="t-panel td-section" style={{ marginTop: running.length ? 16 : 0 }}>
        <h3>
          Next settlements worth a trade
          <span className="t-muted" style={{ fontWeight: 400, fontSize: 13 }}>
            costs at ${notional.toLocaleString()} per leg
          </span>
        </h3>
        {!data ? (
          <div className="t-skel" style={{ borderRadius: 12 }} />
        ) : upcoming.length ? (
          <div className="th-grid">
            {upcoming.map((row) => (
              <a key={row.canonical_symbol} className="th-card" href={tradeHref(row.canonical_symbol, "")}>
                <span className="t-card-top">
                  <strong>{row.base_asset}</strong>
                  <span className="t-capture-clock">
                    <Countdown target={row.capture.settles_at} />
                  </span>
                </span>
                <span className="t-muted">
                  Sell {EXCHANGE_SHORT[row.capture.short_leg.exchange]}, buy {EXCHANGE_SHORT[row.capture.long_leg.exchange]}. {whoPays(row.capture)}.
                </span>
                <span className="t-card-meta">
                  <span className="t-num">
                    Collect <b className="t-receive">{pct(row.capture.capture_percent, 4, true)}</b>
                  </span>
                  <span className="t-num">costs {pct(row.capture.cost_percent, 3)}</span>
                  <span className={`t-num ${row.capture.net_percent > 0 ? "t-receive" : "t-pay"}`}>net {dollars(row.capture.net_percent, notional)}</span>
                </span>
                <span className="t-card-meta">
                  <TrustBadge level={row.capture.data_trust_level} compact />
                  <span className="th-go">Paper trade</span>
                </span>
              </a>
            ))}
          </div>
        ) : (
          <p className="t-muted">No settlement is paying a meaningful amount right now.</p>
        )}
      </section>

      <section className="t-panel td-section" style={{ marginTop: 16 }}>
        <h3>
          Recent trades
          <a className="t-text-btn" style={{ height: 32, display: "inline-flex", alignItems: "center", textDecoration: "none" }} href="/performance">
            Performance
          </a>
        </h3>
        {recent.length ? (
          <ul className="t-list">
            {recent.map((trade) => (
              <li key={trade.id}>
                <a className="th-row" href={`/trade/${encodeURIComponent(trade.canonical_symbol)}`}>
                  <span>
                    <strong>{trade.canonical_symbol.split("-")[0]}</strong>{" "}
                    <span className="t-muted">
                      {new Date(trade.created_at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}, {trade.mode}, {trade.status}
                    </span>
                  </span>
                  <span className={`t-num ${(trade.realized_net_pnl_usd ?? 0) > 0 ? "t-receive" : trade.realized_net_pnl_usd == null ? "t-muted" : "t-pay"}`}>
                    {money(trade.realized_net_pnl_usd)}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="t-muted">No finished trades yet. Pick a settlement above to run your first paper trade.</p>
        )}
      </section>
    </main>
  );
}
