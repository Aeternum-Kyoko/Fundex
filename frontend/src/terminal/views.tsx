import { useEffect, useMemo, useRef, useState } from "react";
import type { ArbitrageOpportunity, ExchangeFundingLeaders, FundingLeader, FundingSettlementItem, TrustLevel } from "../lib/types";
import { useClock } from "./clock";
import { usePref } from "./prefs";
import { formatLeverage, formatPrice, formatUsd } from "../lib/monitor";
import { Empty, SkeletonPanels, SkeletonRows } from "./states";
import { MiniSpark, rateSparks, type SparkMap, useFundingTrends } from "./trends";
import { clockTime, Countdown, EXCHANGE_SHORT, ExchangeTag, exchangeVar, pct, TrustBadge } from "./primitives";

type LeaderMode = "exchange" | "market";
type LeaderSide = "both" | "positive" | "negative";
type LeaderSort = "rate" | "apr" | "oi";

const perHourRate = (leader: FundingLeader) => leader.funding_rate / Math.max(leader.funding_interval_hours ?? 8, 1);
/** Simple (non-compounded) annualised rate in percent, comparable across 1h, 4h and 8h coins. */
const leaderApr = (leader: FundingLeader) => Math.abs(perHourRate(leader)) * 24 * 365 * 100;

function LeaderRow({ leader, showExchange, onOpen, spark }: { leader: FundingLeader; showExchange: boolean; onOpen: (symbol: string) => void; spark?: number[] }) {
  return (
    <li className="ld-row">
      <button type="button" className="t-list-row ld-main" onClick={() => onOpen(leader.canonical_symbol)}>
        <span>
          <strong>{leader.base_asset}</strong> {showExchange ? <ExchangeTag exchange={leader.exchange} /> : null}
          <small className="t-muted t-num ld-meta">
            {leader.next_funding_time ? `${clockTime(leader.next_funding_time)} · in ` : ""}
            <Countdown target={leader.next_funding_time} />
            {leader.max_leverage != null ? ` · ${formatLeverage(leader.max_leverage)}` : ""}
            {leader.open_interest_usd != null ? ` · OI ${formatUsd(leader.open_interest_usd)}` : ""}
          </small>
        </span>
        <span className="ld-rate">
          <MiniSpark values={spark ?? []} width={52} height={20} label={`${leader.base_asset} rate trend`} />
          <span className="t-num t-receive">
            {pct(leader.funding_rate * 100, 4, true)}
            <span className="t-muted"> /{leader.funding_interval_hours ?? 8}h</span>
          </span>
        </span>
      </button>
      <a className="t-text-btn ld-ext" href={leader.trade_url} target="_blank" rel="noreferrer" title={`Open ${leader.base_asset} on ${leader.display_name}`}>
        Trade
      </a>
    </li>
  );
}

function LeaderLists({ positive, negative, showExchange, limit, onOpen, sparks, split = false, side = "both" }: { positive: FundingLeader[]; negative: FundingLeader[]; showExchange: boolean; limit: number; onOpen: (symbol: string) => void; sparks: SparkMap; split?: boolean; side?: LeaderSide }) {
  return (
    <div className={split && side === "both" ? "ld-split" : undefined}>
      {side !== "negative" ? <div>
      <p className="t-subhead">Shorts get paid most</p>
      <ul className="t-list">
        {positive.slice(0, limit).map((leader) => (
          <LeaderRow key={`p-${leader.exchange}-${leader.exchange_symbol}`} leader={leader} showExchange={showExchange} onOpen={onOpen} spark={sparks[`${leader.canonical_symbol}|${leader.exchange}`]} />
        ))}
      </ul>
      </div> : null}
      {side !== "positive" ? <div>
      <p className="t-subhead" style={split || side === "negative" ? undefined : { marginTop: 12 }}>
        Longs get paid most
      </p>
      <ul className="t-list">
        {negative.slice(0, limit).map((leader) => (
          <LeaderRow key={`n-${leader.exchange}-${leader.exchange_symbol}`} leader={leader} showExchange={showExchange} onOpen={onOpen} spark={sparks[`${leader.canonical_symbol}|${leader.exchange}`]} />
        ))}
      </ul>
      </div> : null}
    </div>
  );
}

export function LeadersView({ leaders, onOpen, loading = false }: { leaders: ExchangeFundingLeaders[]; onOpen: (symbol: string) => void; loading?: boolean }) {
  const [mode, setMode] = usePref<LeaderMode>("arbradar-leaders-mode", "market");
  const [limit, setLimit] = usePref<number>("arbradar-leaders-limit", 5);
  // Rates compare fairly only per hour, so the market-wide list ranks on that.
  const [side, setSide] = usePref<LeaderSide>("arbradar-leaders-side", "both");
  const [sort, setSort] = usePref<LeaderSort>("arbradar-leaders-sort", "rate");
  const [advanced, setAdvanced] = useState(false);
  const [search, setSearch] = useState("");
  const [minApr, setMinApr] = useState("");
  const [minOi, setMinOi] = useState("");
  const [interval, setIntervalHours] = useState<number | "any">("any");
  const [hidden, setHidden] = useState<string[]>([]);
  const activeFilters = [search.trim(), minApr, minOi, interval !== "any", hidden.length].filter(Boolean).length;
  const resetFilters = () => {
    setSearch("");
    setMinApr("");
    setMinOi("");
    setIntervalHours("any");
    setHidden([]);
  };

  const filtered = useMemo(() => {
    const query = search.trim().toUpperCase();
    const aprFloor = Number(minApr) || 0;
    const oiFloor = (Number(minOi) || 0) * 1_000_000;
    const keep = (leader: FundingLeader) =>
      !hidden.includes(leader.exchange) &&
      (interval === "any" || (leader.funding_interval_hours ?? 8) === interval) &&
      leaderApr(leader) >= aprFloor &&
      (!oiFloor || (leader.open_interest_usd ?? 0) >= oiFloor) &&
      (!query || leader.base_asset.toUpperCase().includes(query) || leader.canonical_symbol.toUpperCase().includes(query));
    // Rates compare fairly only per hour, so every ranking uses the hourly figure.
    const order = (positive: boolean) => (a: FundingLeader, b: FundingLeader) => {
      if (sort === "oi") return (b.open_interest_usd ?? 0) - (a.open_interest_usd ?? 0);
      return positive ? perHourRate(b) - perHourRate(a) : perHourRate(a) - perHourRate(b);
    };
    return leaders.map((group) => ({
      ...group,
      top_positive: group.top_positive.filter((leader) => leader.funding_rate > 0 && keep(leader)).sort(order(true)),
      top_negative: group.top_negative.filter((leader) => leader.funding_rate < 0 && keep(leader)).sort(order(false)),
    }));
  }, [leaders, search, minApr, minOi, interval, hidden, sort]);

  const market = useMemo(() => {
    const everyone = filtered.flatMap((group) => [...group.top_positive, ...group.top_negative]);
    const rank = (positive: boolean) => (a: FundingLeader, b: FundingLeader) =>
      sort === "oi" ? (b.open_interest_usd ?? 0) - (a.open_interest_usd ?? 0) : positive ? perHourRate(b) - perHourRate(a) : perHourRate(a) - perHourRate(b);
    return {
      positive: everyone.filter((leader) => leader.funding_rate > 0).sort(rank(true)),
      negative: everyone.filter((leader) => leader.funding_rate < 0).sort(rank(false)),
    };
  }, [filtered, sort]);

  const shown = useMemo(() => {
    const picked = mode === "market" ? [...market.positive.slice(0, limit), ...market.negative.slice(0, limit)] : filtered.flatMap((group) => [...group.top_positive.slice(0, limit), ...group.top_negative.slice(0, limit)]);
    return picked.map((leader) => leader.canonical_symbol);
  }, [mode, limit, market, filtered]);
  const trendExchanges = useMemo(() => leaders.map((group) => group.exchange), [leaders]);
  const intervals = useMemo(() => Object.fromEntries(leaders.flatMap((group) => [...group.top_positive, ...group.top_negative].slice(0, 1).map((leader) => [group.exchange, leader.funding_interval_hours ?? 8]))), [leaders]);
  const { series } = useFundingTrends(shown, trendExchanges, 60, 60_000);
  const intervalOptions = useMemo(() => [...new Set(leaders.flatMap((group) => [...group.top_positive, ...group.top_negative].map((leader) => leader.funding_interval_hours ?? 8)))].sort((a, b) => a - b), [leaders]);
  const sparks = useMemo(() => rateSparks(series, intervals), [series, intervals]);

  if (loading && !leaders.length) return <SkeletonPanels count={3} />;
  if (!leaders.length) {
    return <Empty title="No funding data yet" body="Leaders appear as soon as the first exchange reports rates." />;
  }
  return (
    <>
      <div className="t-toolbar" style={{ marginBottom: 12 }}>
        <div className="t-segmented" role="group" aria-label="Group leaders">
          <button type="button" aria-pressed={mode === "market"} onClick={() => setMode("market")}>
            Whole market
          </button>
          <button type="button" aria-pressed={mode === "exchange"} onClick={() => setMode("exchange")}>
            By exchange
          </button>
        </div>
        <label className="t-field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          Show
          <select value={limit} onChange={(event) => setLimit(Number(event.target.value))}>
            {[5, 10, 20, 50].map((count) => (
              <option key={count} value={count}>
                {count} each
              </option>
            ))}
          </select>
        </label>
        <div className="t-segmented" role="group" aria-label="Direction">
          <button type="button" aria-pressed={side === "both"} onClick={() => setSide("both")}>
            Both
          </button>
          <button type="button" aria-pressed={side === "positive"} onClick={() => setSide("positive")} title="Funding above zero: shorts collect">
            Top positive
          </button>
          <button type="button" aria-pressed={side === "negative"} onClick={() => setSide("negative")} title="Funding below zero: longs collect">
            Top negative
          </button>
        </div>
        <label className="t-field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          Rank by
          <select value={sort} onChange={(event) => setSort(event.target.value as LeaderSort)}>
            <option value="rate">Funding rate</option>
            <option value="oi">Open interest</option>
          </select>
        </label>
        <button type="button" className="t-text-btn" aria-pressed={advanced} onClick={() => setAdvanced((value) => !value)}>
          Advanced filters{activeFilters ? ` (${activeFilters})` : ""}
        </button>
      </div>
      {advanced ? (
        <div className="t-toolbar" style={{ marginBottom: 12, alignItems: "flex-end" }}>
          <label className="t-field">
            Coin
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="BTC, SOL…" />
          </label>
          <label className="t-field">
            Min APR %
            <input type="number" min="0" inputMode="decimal" value={minApr} onChange={(event) => setMinApr(event.target.value)} placeholder="e.g. 30" style={{ width: 90 }} />
          </label>
          <label className="t-field">
            Min open interest ($M)
            <input type="number" min="0" inputMode="decimal" value={minOi} onChange={(event) => setMinOi(event.target.value)} placeholder="e.g. 5" style={{ width: 110 }} />
          </label>
          <label className="t-field">
            Settles every
            <select value={interval} onChange={(event) => setIntervalHours(event.target.value === "any" ? "any" : Number(event.target.value))}>
              <option value="any">Any</option>
              {intervalOptions.map((hours) => (
                <option key={hours} value={hours}>
                  {hours}h
                </option>
              ))}
            </select>
          </label>
          <div className="t-scope" role="group" aria-label="Exchanges">
            {leaders.map((group) => (
              <button
                key={group.exchange}
                type="button"
                className="t-chip"
                style={exchangeVar(group.exchange)}
                aria-pressed={!hidden.includes(group.exchange)}
                onClick={() => setHidden((current) => (current.includes(group.exchange) ? current.filter((item) => item !== group.exchange) : [...current, group.exchange]))}
              >
                {EXCHANGE_SHORT[group.exchange] ?? group.exchange}
              </button>
            ))}
          </div>
          {activeFilters ? (
            <button type="button" className="t-text-btn" onClick={resetFilters}>
              Reset
            </button>
          ) : null}
        </div>
      ) : null}
      {mode === "market" ? (
        <section className="t-panel">
          <h3>Highest funding rates across all exchanges</h3>
          <LeaderLists positive={market.positive} negative={market.negative} showExchange limit={limit} onOpen={onOpen} sparks={sparks} split side={side} />
        </section>
      ) : (
        <div className="t-grid-leaders">
          {filtered.map((group) => (
            <section key={group.exchange} className="t-panel" style={exchangeVar(group.exchange)}>
              <h3>
                <ExchangeTag exchange={group.exchange} />
              </h3>
              <LeaderLists positive={group.top_positive} negative={group.top_negative} showExchange={false} limit={limit} onOpen={onOpen} sparks={sparks} side={side} />
            </section>
          ))}
        </div>
      )}
    </>
  );
}

export function SettlementsView({ items, onOpen, loading = false }: { items: FundingSettlementItem[]; onOpen: (symbol: string) => void; loading?: boolean }) {
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

  if (loading && !items.length) return <SkeletonRows count={7} height={52} label="Loading settlements" />;
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

export { Empty };
