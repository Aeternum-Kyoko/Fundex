import type { ExchangeStatus } from "../lib/types";
import { useClock } from "./clock";
import { EXCHANGE_SHORT, exchangeVar } from "./primitives";
import { Empty, SkeletonPanels } from "./states";

export type HealthState = "ok" | "degraded" | "down" | "off";

export function healthState(status: ExchangeStatus, now: number): HealthState {
  if (!status.enabled || !status.configured) return "off";
  if (!status.last_success_at) return status.last_error ? "down" : "degraded";
  const age = (now - new Date(status.last_success_at).getTime()) / 1000;
  if (status.last_error || age > 180) return "down";
  if (!status.healthy || age > 60) return "degraded";
  return "ok";
}

/** Number of enabled exchanges that are slow or down, for the tab badge. */
export function useUnhealthyCount(statuses: ExchangeStatus[]) {
  const now = useClock();
  return statuses.filter((status) => status.enabled && ["degraded", "down"].includes(healthState(status, now))).length;
}

const LABEL: Record<HealthState, string> = { ok: "Healthy", degraded: "Slow", down: "Down", off: "Off" };

function agoText(seconds: number | null) {
  if (seconds == null) return "no update yet";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

/** Exchange feed health as its own section: one card per exchange, plus the live-update link. */
export function HealthView({ statuses, link, receivedAt, loading }: { statuses: ExchangeStatus[]; link: string; receivedAt: number | null; loading: boolean }) {
  const now = useClock();
  if (loading && !statuses.length) return <SkeletonPanels count={4} />;
  if (!statuses.length) return <Empty title="No exchange status yet" body="Feed health appears as soon as the backend has polled the exchanges." />;

  const rows = statuses.map((status) => ({
    status,
    state: healthState(status, now),
    age: status.last_success_at ? Math.max(0, Math.round((now - new Date(status.last_success_at).getTime()) / 1000)) : null,
  }));
  const ok = rows.filter((row) => row.state === "ok").length;
  const active = rows.filter((row) => row.state !== "off").length;

  return (
    <div className="hl-wrap">
      <div className="hl-summary t-panel">
        <div>
          <strong className="hl-big">
            {ok} of {active}
          </strong>
          <span className="t-soft"> exchanges healthy</span>
        </div>
        <div className="hl-link">
          <span className="t-dot" data-state={link === "live" ? undefined : link === "paused" ? "off" : "degraded"} />
          {link === "live" ? "Live updates connected" : link === "paused" ? "Live updates paused" : "Live link unavailable, refreshing every 8 seconds"}
          {receivedAt ? <span className="t-muted"> · data {agoText(Math.max(0, Math.round((now - receivedAt) / 1000)))}</span> : null}
        </div>
      </div>

      <div className="hl-grid">
        {rows.map(({ status, state, age }) => (
          <section key={status.exchange} className="t-panel hl-card" style={exchangeVar(status.exchange)} data-state={state}>
            <h3>
              <span className="hl-name">
                <span className="t-dot" data-state={state === "ok" ? undefined : state} style={state === "ok" ? { background: `var(--x-${status.exchange})` } : undefined} />
                {EXCHANGE_SHORT[status.exchange] ?? status.display_name}
              </span>
              <span className="hl-pill" data-state={state}>
                {LABEL[state]}
              </span>
            </h3>
            <dl className="t-kv">
              <div>
                <dt>Last update</dt>
                <dd className="t-num">{agoText(age)}</dd>
              </div>
              <div>
                <dt>Contracts tracked</dt>
                <dd className="t-num">{status.snapshot_count.toLocaleString()}</dd>
              </div>
            </dl>
            {status.last_error ? <p className="hl-error">{status.last_error}</p> : null}
            {!status.configured ? (
              <p className="t-muted hl-note">
                {status.exchange === "coinswitch" ? "Add a CoinSwitch API key under More, Exchange API keys, to monitor it." : "Not configured on the backend."}
              </p>
            ) : null}
            {status.enabled && status.configured && state === "degraded" && !status.last_error ? <p className="t-muted hl-note">Updates are slower than usual. Rates may be a little behind.</p> : null}
          </section>
        ))}
      </div>
    </div>
  );
}
