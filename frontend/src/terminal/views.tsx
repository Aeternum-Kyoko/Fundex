import { useEffect, useMemo, useRef, useState } from "react";
import type { ArbitrageOpportunity, ExchangeFundingLeaders, FundingSettlementItem, TrustLevel } from "../lib/types";
import { useClock } from "./clock";
import { usePref } from "./prefs";
import { formatLeverage, formatPrice, formatUsd } from "../lib/monitor";
import { Countdown, ExchangeTag, exchangeVar, pct, TrustBadge } from "./primitives";

export function LeadersView({ leaders, onOpen }: { leaders: ExchangeFundingLeaders[]; onOpen: (symbol: string) => void }) {
  if (!leaders.length) {
    return <Empty title="No funding data yet" body="Leaders appear as soon as the first exchange reports rates." />;
  }
  return (
    <div className="t-grid-leaders">
      {leaders.map((group) => (
        <section key={group.exchange} className="t-panel" style={exchangeVar(group.exchange)}>
          <h3>
            <ExchangeTag exchange={group.exchange} />
          </h3>
          <p className="t-subhead">Shorts get paid most</p>
          <ul className="t-list">
            {group.top_positive.slice(0, 5).map((leader) => (
              <li key={`p-${leader.exchange_symbol}`}>
                <button type="button" className="t-list-row" onClick={() => onOpen(leader.canonical_symbol)}>
                  <span>{leader.base_asset}</span>
                  <span className="t-num t-receive">{pct(leader.funding_rate * 100, 4, true)}<span className="t-muted"> /{leader.funding_interval_hours ?? 8}h</span></span>
                </button>
              </li>
            ))}
          </ul>
          <p className="t-subhead" style={{ marginTop: 12 }}>
            Longs get paid most
          </p>
          <ul className="t-list">
            {group.top_negative.slice(0, 5).map((leader) => (
              <li key={`n-${leader.exchange_symbol}`}>
                <button type="button" className="t-list-row" onClick={() => onOpen(leader.canonical_symbol)}>
                  <span>{leader.base_asset}</span>
                  <span className="t-num t-receive">{pct(leader.funding_rate * 100, 4, true)}<span className="t-muted"> /{leader.funding_interval_hours ?? 8}h</span></span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function SettlementsView({ items, onOpen }: { items: FundingSettlementItem[]; onOpen: (symbol: string) => void }) {
  const now = useClock();
  const minute = Math.floor(now / 60_000);
  const groups = useMemo(() => {
    const buckets: Record<string, FundingSettlementItem[]> = { "Next 15 minutes": [], "Within the hour": [], Later: [] };
    for (const item of items) {
      const minutes = item.next_funding_time ? (new Date(item.next_funding_time).getTime() - minute * 60_000) / 60_000 : Infinity;
      if (minutes < 0) continue;
      buckets[minutes <= 15 ? "Next 15 minutes" : minutes <= 60 ? "Within the hour" : "Later"].push(item);
    }
    return Object.entries(buckets).filter(([, list]) => list.length);
  }, [items, minute]);

  if (!groups.length) {
    return <Empty title="No settlements scheduled" body="Upcoming funding payments show here once exchanges report their next settlement times." />;
  }
  return (
    <div>
      {groups.map(([label, list]) => (
        <section key={label} className="t-settle-group">
          <p className="t-subhead">{label}</p>
          <div className="t-panel" style={{ padding: 0 }}>
            {list.map((item) => (
              <button
                key={`${item.exchange}-${item.exchange_symbol}`}
                type="button"
                className="t-settle-row"
                style={{ width: "100%", border: 0, background: "none", textAlign: "left", cursor: "pointer" }}
                onClick={() => onOpen(item.canonical_symbol)}
              >
                <span className="t-num">
                  <Countdown target={item.next_funding_time} />
                </span>
                <span>
                  <strong>{item.canonical_symbol.split("-")[0]}</strong> <ExchangeTag exchange={item.exchange} />
                </span>
                <span className="t-num t-hide-phone t-muted">
                  every {item.funding_interval_hours}h, mark {formatPrice(item.mark_price)}, max {formatLeverage(item.max_leverage)}, OI {formatUsd(item.open_interest_usd)}
                </span>
                <span className="t-cell-stack" style={{ textAlign: "right" }}>
                  <span className="t-num">{pct(item.funding_rate * 100, 4, true)}</span>
                  <small>{item.funding_rate >= 0 ? "longs pay shorts" : "shorts pay longs"}</small>
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

interface AlertEvent {
  key: string;
  symbol: string;
  text: string;
  at: number;
}

const TRUST_RANK: Record<TrustLevel, number> = { low: 0, medium: 1, high: 2 };

/** Alert rules run in the browser on every update. Keys are pair + rule, never live values, so they don't repeat. */
export function useAlerts(opportunities: ArbitrageOpportunity[], horizonLabel: string) {
  // Any enabled rule can trigger (blank = off), and trust must be at least the chosen level.
  const [rules, setRules] = usePref("arbradar-alert-rules-v4", {
    minNetPercent: 1 as number | null,
    minSpreadPercent: null as number | null,
    minCaptureNetPercent: 0 as number | null,
    minTrust: "medium" as TrustLevel,
    notify: false,
    cooldownMinutes: 30,
  });
  const [log, setLog] = usePref<AlertEvent[]>("arbradar-alert-log-v4", []);
  const logRef = useRef(log);
  logRef.current = log;

  const reasonsFor = useMemo(
    () => (item: ArbitrageOpportunity) => {
      const reasons: string[] = [];
      if (rules.minNetPercent != null && item.net_return_percent >= rules.minNetPercent) reasons.push(`${pct(item.net_return_percent, 2, true)} over ${horizonLabel}`);
      if (rules.minSpreadPercent != null && item.spread_rate * 100 >= rules.minSpreadPercent) reasons.push(`spread ${pct(item.spread_rate * 100, 3)} /8h`);
      if (rules.minCaptureNetPercent != null && item.capture && item.capture.capture_percent > 0 && item.capture.net_percent >= rules.minCaptureNetPercent)
        reasons.push(`next settlement nets ${pct(item.capture.net_percent, 3, true)}`);
      return reasons;
    },
    [rules.minNetPercent, rules.minSpreadPercent, rules.minCaptureNetPercent, horizonLabel],
  );
  const matches = useMemo(
    () => opportunities.filter((item) => TRUST_RANK[item.trust_level] >= TRUST_RANK[rules.minTrust] && reasonsFor(item).length > 0),
    [opportunities, rules.minTrust, reasonsFor],
  );

  useEffect(() => {
    const now = Date.now();
    const cooldown = rules.cooldownMinutes * 60_000;
    const fresh: AlertEvent[] = [];
    for (const item of matches) {
      const reasons = reasonsFor(item);
      const fired = [rules.minNetPercent != null && item.net_return_percent >= rules.minNetPercent ? "net" : "", reasons.some((r) => r.startsWith("spread")) ? "spread" : "", reasons.some((r) => r.startsWith("next")) ? "capture" : ""].filter(Boolean).join("+");
      // Coin + rule only: the chosen exchange pair can flip between tied venues and must not re-alert.
      const key = `${item.canonical_symbol}:${fired}`;
      const seen = logRef.current.find((event) => event.key === key);
      if (seen && now - seen.at < cooldown) continue;
      fresh.push({ key, symbol: item.canonical_symbol, text: `${item.base_asset}: ${reasons.join(", ")} (${item.trust_level} trust)`, at: now });
    }
    if (!fresh.length) return;
    setLog((current) => [...fresh, ...current.filter((event) => !fresh.some((added) => added.key === event.key))].slice(0, 60));
    if (rules.notify && typeof Notification !== "undefined" && Notification.permission === "granted") {
      fresh.slice(0, 3).forEach((event) => new Notification("Fundex", { body: event.text, tag: event.key }));
    }
  }, [matches, rules, horizonLabel, setLog, reasonsFor]);

  return { rules, setRules, matches, log, clearLog: () => setLog([]), reasonsFor };
}

export function AlertsView({
  alerts,
  horizonLabel,
  onOpen,
}: {
  alerts: ReturnType<typeof useAlerts>;
  horizonLabel: string;
  onOpen: (symbol: string) => void;
}) {
  const { rules, setRules, matches, log, clearLog, reasonsFor } = alerts;
  const [permission, setPermission] = useState(typeof Notification === "undefined" ? "denied" : Notification.permission);
  return (
    <div className="t-grid-leaders" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 340px), 1fr))" }}>
      <section className="t-panel">
        <h3>Alert me when any of these is true</h3>
        <p className="t-subhead">Leave a box empty to switch that rule off.</p>
        <div className="t-form-row">
          <RuleField
            label="Next settlement nets at least (%)"
            value={rules.minCaptureNetPercent}
            step="0.01"
            onChange={(value) => setRules({ ...rules, minCaptureNetPercent: value })}
          />
          <RuleField label={`Net over ${horizonLabel} at least (%)`} value={rules.minNetPercent} step="0.1" onChange={(value) => setRules({ ...rules, minNetPercent: value })} />
          <RuleField label="Spread /8h at least (%)" value={rules.minSpreadPercent} step="0.01" onChange={(value) => setRules({ ...rules, minSpreadPercent: value })} />
        </div>
        <div className="t-form-row" style={{ marginTop: 12 }}>
          <label className="t-field">
            and trust is at least
            <select value={rules.minTrust} onChange={(event) => setRules({ ...rules, minTrust: event.target.value as TrustLevel })}>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </label>
          <label className="t-field">
            Repeat after
            <select value={rules.cooldownMinutes} onChange={(event) => setRules({ ...rules, cooldownMinutes: Number(event.target.value) })}>
              <option value={15}>15 minutes</option>
              <option value={30}>30 minutes</option>
              <option value={60}>1 hour</option>
              <option value={240}>4 hours</option>
            </select>
          </label>
        </div>
        <div className="t-actions" style={{ marginTop: 14 }}>
          {permission === "granted" ? (
            <button type="button" className="t-btn" onClick={() => setRules({ ...rules, notify: !rules.notify })} aria-pressed={rules.notify}>
              {rules.notify ? "Turn off browser notifications" : "Turn on browser notifications"}
            </button>
          ) : (
            <button
              type="button"
              className="t-btn"
              disabled={permission === "denied"}
              onClick={() =>
                void Notification.requestPermission().then((result) => {
                  setPermission(result);
                  if (result === "granted") setRules({ ...rules, notify: true });
                })
              }
            >
              {permission === "denied" ? "Notifications blocked in browser settings" : "Allow browser notifications"}
            </button>
          )}
        </div>
        <p className="t-subhead" style={{ marginTop: 18 }}>
          Matching now: {matches.length}
        </p>
        <ul className="t-list">
          {matches.slice(0, 8).map((item) => (
            <li key={item.canonical_symbol}>
              <button type="button" className="t-list-row" onClick={() => onOpen(item.canonical_symbol)}>
                <span>
                  {item.base_asset} <TrustBadge level={item.trust_level} compact />
                </span>
                <span className="t-num t-soft" style={{ fontSize: 13 }}>
                  {reasonsFor(item).join(", ")}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {!matches.length ? <p className="t-muted">Nothing clears these rules right now. Lower the net threshold to see more.</p> : null}
      </section>
      <section className="t-panel">
        <h3>
          Recent alerts
          {log.length ? (
            <button type="button" className="t-text-btn" style={{ height: 30 }} onClick={clearLog}>
              Clear
            </button>
          ) : null}
        </h3>
        {log.length ? (
          <ul className="t-list">
            {log.slice(0, 20).map((event) => (
              <li key={`${event.key}-${event.at}`}>
                <button type="button" className="t-list-row" onClick={() => onOpen(event.symbol)}>
                  <span>{event.text}</span>
                  <span className="t-num t-muted">{new Date(event.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="t-muted">Alerts you trigger appear here, once per pair until the repeat window passes.</p>
        )}
      </section>
    </div>
  );
}

function RuleField({ label, value, step, onChange }: { label: string; value: number | null; step: string; onChange: (value: number | null) => void }) {
  return (
    <label className="t-field">
      {label}
      <input
        type="number"
        step={step}
        inputMode="decimal"
        placeholder="off"
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value === "" ? null : Number(event.target.value))}
      />
    </label>
  );
}

export function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="t-empty">
      <strong>{title}</strong>
      {body}
    </div>
  );
}
