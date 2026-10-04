import { useCallback, useEffect, useState } from "react";

const API_BASE = import.meta.env.VITE_API_URL ?? "/api";

export interface BotParams {
  days: number;
  notional_usd: number;
  binance_taker_bps: number;
  delta_taker_bps: number;
  slippage_percent_per_leg: number;
  lookback: number;
  entry_apr_percent: number;
  exit_apr_percent: number;
  max_positions: number;
}

interface BotState {
  config: { enabled: boolean; mode: string; leverage: number; params: BotParams };
  last_tick_at: string | null;
  next_tick_at: string | null;
  last_error: string | null;
  coins_tracked: number;
  top_signals: Array<{ coin: string; signal_apr: number }>;
  positions: Array<{
    id: string;
    coin: string;
    direction: string;
    opened_at: string;
    entry_signal_apr: number | null;
    current_signal_apr: number | null;
    settlements: number;
    funding_usd: number;
    fees_usd: number;
    net_usd: number;
    notional_usd: number;
  }>;
  totals: {
    open_count: number;
    open_net_usd: number;
    open_funding_usd: number;
    closed_count: number;
    closed_net_usd: number;
    closed_wins: number;
    first_trade_at: string | null;
  };
  recent_closed: Array<{ id: string; coin: string; opened_at: string; closed_at: string; settlements: number; net_usd: number; reason: string | null }>;
  log: Array<{ at: string; kind: string; coin: string | null; message: string }>;
}

function usd(value: number) {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}$${Math.abs(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function tone(value: number) {
  return value > 0 ? "t-receive" : value < 0 ? "t-pay" : "t-soft";
}

function when(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function held(iso: string) {
  const hours = (Date.now() - new Date(iso).getTime()) / 3_600_000;
  return hours >= 48 ? `${(hours / 24).toFixed(1)} days` : `${Math.max(0, Math.round(hours))}h`;
}

const RULE_KEYS: Array<keyof BotParams> = ["entry_apr_percent", "exit_apr_percent", "lookback", "max_positions", "notional_usd"];

/** The paper bot: runs the lab's rules on live settled funding and trades them on paper, every hour. */
export function StrategyBot({ params }: { params: BotParams }) {
  const [state, setState] = useState<BotState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/strategy/bot`);
      if (!response.ok) throw new Error();
      setState((await response.json()) as BotState);
    } catch {
      setError("Can't reach the strategy bot.");
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const call = async (label: string, path: string, init: RequestInit) => {
    setBusy(label);
    setError(null);
    try {
      const response = await fetch(`${API_BASE}${path}`, { headers: { "Content-Type": "application/json" }, ...init });
      const payload = await response.json();
      if (!response.ok) setError(typeof payload.detail === "string" ? payload.detail : "The bot refused that.");
      else setState(payload as BotState);
    } catch {
      setError("Can't reach the strategy bot.");
    } finally {
      setBusy(null);
    }
  };

  const configure = (enabled: boolean, rules: BotParams) =>
    call(enabled ? "start" : "stop", "/strategy/bot", { method: "PUT", body: JSON.stringify({ enabled, mode: "paper", leverage: state?.config.leverage ?? 2, params: rules }) });

  const running = state?.config.enabled ?? false;
  const botRules = state?.config.params;
  const differs = !!botRules && RULE_KEYS.some((key) => botRules[key] !== params[key]);
  const totals = state?.totals;
  const net = (totals?.closed_net_usd ?? 0) + (totals?.open_net_usd ?? 0);

  return (
    <section className="t-panel td-section sb-panel" style={{ marginTop: 16 }} aria-label="Paper bot">
      <h3>
        <span className="sb-title">
          <i className="sb-dot" data-on={running} aria-hidden="true" />
          Paper bot {running ? "running" : state?.positions.length ? "winding down" : "off"}
        </span>
        <span className="sb-actions">
          {running && differs ? (
            <button type="button" className="t-btn" disabled={!!busy} onClick={() => void configure(true, params)}>
              Use the rules above
            </button>
          ) : null}
          {running ? (
            <button type="button" className="t-btn" disabled={!!busy} onClick={() => void configure(false, botRules ?? params)}>
              {busy === "stop" ? "Stopping…" : "Stop new entries"}
            </button>
          ) : (
            <button type="button" className="t-btn" data-primary="true" disabled={!!busy} onClick={() => void configure(true, params)}>
              {busy === "start" ? "Starting…" : "Run these rules on paper"}
            </button>
          )}
          <button type="button" className="t-btn" disabled={!!busy || (!running && !state?.positions.length)} onClick={() => void call("check", "/strategy/bot/check", { method: "POST" })}>
            {busy === "check" ? "Checking…" : "Check now"}
          </button>
        </span>
      </h3>
      <p className="t-muted sl-note">
        {running && botRules ? (
          <>
            Every hour, 2 minutes after settlement, it reads the settled rates for {state?.coins_tracked || "every"} Binance and Delta coins, credits funding to open
            pairs, closes those below {botRules.exit_apr_percent}% a year and opens the widest above {botRules.entry_apr_percent}% (up to {botRules.max_positions} pairs of $
            {botRules.notional_usd.toLocaleString()} per leg), with fills from the live order books. Same rules as the replay below.
          </>
        ) : (
          <>
            Runs the rules above on live data with paper money: the same decisions as the backtest, filled on the live order books, with funding credited from the
            settled rates. Results land in Results next to your other paper trades. Stopping only blocks new entries; open pairs still close on the exit rule.
          </>
        )}
      </p>
      {error ? <div className="t-banner" role="alert">{error}</div> : null}
      {state?.last_error ? <div className="t-banner" role="alert">Last check failed: {state.last_error}</div> : null}

      {state ? (
        <>
          <div className="sb-kpis">
            <div>
              <span>Net so far</span>
              <b className={`t-num ${tone(net)}`}>{usd(net)}</b>
              <small className="t-muted">{totals?.first_trade_at ? `since ${when(totals.first_trade_at)}` : "no trades yet"}</small>
            </div>
            <div>
              <span>Open pairs</span>
              <b className="t-num">{totals?.open_count ?? 0}</b>
              <small className="t-muted">funding {usd(totals?.open_funding_usd ?? 0)}</small>
            </div>
            <div>
              <span>Closed</span>
              <b className="t-num">{totals?.closed_count ?? 0}</b>
              <small className="t-muted">
                {totals?.closed_count ? `${totals.closed_wins} paid off, ${usd(totals.closed_net_usd)}` : "none yet"}
              </small>
            </div>
            <div>
              <span>Checks</span>
              <b className="t-num">{state.last_tick_at ? when(state.last_tick_at) : "—"}</b>
              <small className="t-muted">next {state.next_tick_at ? when(state.next_tick_at) : "on start"}</small>
            </div>
          </div>

          {state.positions.length ? (
            <div className="sl-table-wrap" style={{ marginTop: 14 }}>
              <table className="sl-table">
                <thead>
                  <tr>
                    <th>Coin</th>
                    <th>Side</th>
                    <th>Held</th>
                    <th>Spread in / now</th>
                    <th>Settlements</th>
                    <th>Funding</th>
                    <th>Net</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {state.positions.map((position) => (
                    <tr key={position.id}>
                      <td>{position.coin}</td>
                      <td className="t-muted">{position.direction.replace(", ", " / ")}</td>
                      <td className="t-num">{held(position.opened_at)}</td>
                      <td className="t-num">
                        {position.entry_signal_apr != null ? `${position.entry_signal_apr.toFixed(0)}%` : "—"} /{" "}
                        <span className={position.current_signal_apr != null && botRules && position.current_signal_apr < botRules.exit_apr_percent ? "t-pay" : ""}>
                          {position.current_signal_apr != null ? `${position.current_signal_apr.toFixed(0)}%` : "—"}
                        </span>
                      </td>
                      <td className="t-num">{position.settlements}</td>
                      <td className={`t-num ${tone(position.funding_usd)}`}>{usd(position.funding_usd)}</td>
                      <td className={`t-num ${tone(position.net_usd)}`}>{usd(position.net_usd)}</td>
                      <td>
                        <button
                          type="button"
                          className="t-btn sb-close"
                          disabled={!!busy}
                          onClick={() => void call(`close-${position.id}`, `/strategy/bot/positions/${position.id}/close`, { method: "POST" })}
                        >
                          {busy === `close-${position.id}` ? "Closing…" : "Close"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : running ? (
            <p className="t-muted" style={{ margin: "14px 0 0" }}>
              No open pairs: nothing is above {botRules?.entry_apr_percent}% a year right now
              {state.top_signals[0] ? ` (widest: ${state.top_signals[0].coin} at ${Math.abs(state.top_signals[0].signal_apr).toFixed(0)}%)` : ""}.
            </p>
          ) : null}

          {state.recent_closed.length || state.log.length ? (
            <div className="sb-columns">
              {state.recent_closed.length ? (
                <div>
                  <h4>Recently closed</h4>
                  <ul className="t-list">
                    {state.recent_closed.map((trade) => (
                      <li key={trade.id}>
                        <span>
                          {trade.coin}{" "}
                          <span className="t-muted">
                            {when(trade.closed_at)}, {trade.settlements} payments{trade.reason ? `, ${trade.reason}` : ""}
                          </span>
                        </span>
                        <span className={`t-num ${tone(trade.net_usd)}`}>{usd(trade.net_usd)}</span>
                      </li>
                    ))}
                  </ul>
                  <a className="sb-link" href="/performance">
                    Full details in Results
                  </a>
                </div>
              ) : null}
              {state.log.length ? (
                <div>
                  <h4>Decisions</h4>
                  <ul className="sb-log">
                    {state.log.slice(0, 12).map((entry, index) => (
                      <li key={`${entry.at}-${index}`} data-kind={entry.kind}>
                        <time className="t-num t-muted">{when(entry.at)}</time>
                        <span>{entry.message}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
