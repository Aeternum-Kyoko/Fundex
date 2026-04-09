import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { FundingLeadersPanel } from "./components/FundingLeadersPanel";
import { FundingSettlementBoard } from "./components/FundingSettlementBoard";
import { FundingLeadersSkeleton, OpportunityTableSkeleton } from "./components/LoadingSkeletons";
import { OpportunityInspector } from "./components/OpportunityInspector";
import { OpportunityTable } from "./components/OpportunityTable";
import { useMarketFeed } from "./hooks/useMarketFeed";
import {
  buildOpportunityCsv,
  exchangeLabel,
  exchangeToneClass,
  formatCountdown,
  formatPct,
  formatTimestamp,
  getNextFundingTime,
} from "./lib/monitor";
import type { ArbitrageOpportunity, ExchangeName } from "./lib/types";

const ALERTS_KEY = "arbradar-alerts";
const REFRESH_KEY = "arbradar-refresh";
const NOTIFICATIONS_KEY = "arbradar-notifications";
const ALERT_HISTORY_KEY = "arbradar-alert-history";
const EXCHANGE_SCOPE_KEY = "arbradar-exchange-scope";

interface AlertPreferences {
  minSpreadPercent: number;
  minNetAprPercent: number;
}

interface NotificationPreferences {
  enabled: boolean;
  cooldownMinutes: number;
}

interface AlertEvent {
  id: string;
  signature: string;
  symbol: string;
  reasons: string[];
  created_at: string;
}

interface ExchangeHealthBadge {
  label: string;
  tone: "healthy" | "warning" | "danger" | "neutral";
}

const defaultAlertPreferences: AlertPreferences = {
  minSpreadPercent: 0.08,
  minNetAprPercent: 10,
};

const defaultNotificationPreferences: NotificationPreferences = {
  enabled: false,
  cooldownMinutes: 30,
};

function averageConfidence(opportunities: ArbitrageOpportunity[]) {
  if (!opportunities.length) {
    return 0;
  }

  return opportunities.reduce((total, item) => total + item.confidence_score, 0) / opportunities.length;
}

function readStoredObject<T>(key: string, fallback: T) {
  if (typeof window === "undefined") {
    return fallback;
  }

  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return fallback;
    }

    return { ...fallback, ...(JSON.parse(raw) as Partial<T>) };
  } catch {
    return fallback;
  }
}

function readStoredNumber(key: string, fallback: number) {
  if (typeof window === "undefined") {
    return fallback;
  }

  const raw = window.localStorage.getItem(key);
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readAlertHistory() {
  if (typeof window === "undefined") {
    return [] as AlertEvent[];
  }

  try {
    const raw = window.localStorage.getItem(ALERT_HISTORY_KEY);
    if (!raw) {
      return [] as AlertEvent[];
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [] as AlertEvent[];
    }

    return parsed.filter(
      (item): item is AlertEvent =>
        typeof item?.id === "string" &&
        typeof item?.signature === "string" &&
        typeof item?.symbol === "string" &&
        Array.isArray(item?.reasons) &&
        typeof item?.created_at === "string",
    );
  } catch {
    return [] as AlertEvent[];
  }
}

function readStoredStringArray(key: string) {
  if (typeof window === "undefined") {
    return [] as string[];
  }

  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return [] as string[];
    }

    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [] as string[];
  }
}

function downloadCsv(csv: string, filename: string) {
  if (!csv) {
    return;
  }

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function getExchangeHealthBadges(status: {
  configured: boolean;
  healthy: boolean;
  snapshot_count: number;
  last_success_at: string | null;
  last_error: string | null;
}): ExchangeHealthBadge[] {
  const badges: ExchangeHealthBadge[] = [];
  const ageSeconds = status.last_success_at ? (Date.now() - new Date(status.last_success_at).getTime()) / 1000 : null;

  if (!status.configured) {
    badges.push({ label: "Needs setup", tone: "neutral" });
    return badges;
  }

  if (status.snapshot_count === 0) {
    badges.push({ label: "Missing data", tone: "danger" });
  }

  if (status.last_error) {
    badges.push({ label: "Feed issue", tone: "danger" });
  }

  if (ageSeconds != null && ageSeconds > 180) {
    badges.push({ label: "Stale", tone: "danger" });
  } else if (ageSeconds != null && ageSeconds > 60) {
    badges.push({ label: "Delayed", tone: "warning" });
  }

  if (!badges.length) {
    badges.push({ label: status.healthy ? "Healthy" : "Live" , tone: status.healthy ? "healthy" : "warning" });
  }

  return badges.slice(0, 3);
}

export function App() {
  const [search, setSearch] = useState("");
  const [viewFilter, setViewFilter] = useState("all");
  const [sortBy, setSortBy] = useState("spread-desc");
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [isOverviewOpen, setIsOverviewOpen] = useState(false);
  const [nowTimestamp, setNowTimestamp] = useState(Date.now());
  const [refreshIntervalMs, setRefreshIntervalMs] = useState(() => readStoredNumber(REFRESH_KEY, 5000));
  const [alertPreferences, setAlertPreferences] = useState<AlertPreferences>(() =>
    readStoredObject(ALERTS_KEY, defaultAlertPreferences),
  );
  const [notificationPreferences, setNotificationPreferences] = useState<NotificationPreferences>(() =>
    readStoredObject(NOTIFICATIONS_KEY, defaultNotificationPreferences),
  );
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>(() =>
    typeof Notification === "undefined" ? "denied" : Notification.permission,
  );
  const [recentAlerts, setRecentAlerts] = useState<AlertEvent[]>(() => readAlertHistory());
  const [selectedExchanges, setSelectedExchanges] = useState<ExchangeName[]>(
    () => readStoredStringArray(EXCHANGE_SCOPE_KEY) as ExchangeName[],
  );
  const recentAlertsRef = useRef(recentAlerts);

  const { data, statuses, fundingLeaders, fundingSettlements, error, isLoading, lastUpdatedAt, refresh } =
    useMarketFeed(refreshIntervalMs, selectedExchanges);

  const toggleableExchanges = useMemo(
    () => statuses.filter((status) => status.enabled && status.configured).map((status) => status.exchange),
    [statuses],
  );
  const deferredSearch = useDeferredValue(search);

  useEffect(() => {
    recentAlertsRef.current = recentAlerts;
    window.localStorage.setItem(ALERT_HISTORY_KEY, JSON.stringify(recentAlerts));
  }, [recentAlerts]);

  useEffect(() => {
    window.localStorage.setItem(ALERTS_KEY, JSON.stringify(alertPreferences));
  }, [alertPreferences]);

  useEffect(() => {
    window.localStorage.setItem(NOTIFICATIONS_KEY, JSON.stringify(notificationPreferences));
  }, [notificationPreferences]);

  useEffect(() => {
    window.localStorage.setItem(REFRESH_KEY, String(refreshIntervalMs));
  }, [refreshIntervalMs]);

  useEffect(() => {
    window.localStorage.setItem(EXCHANGE_SCOPE_KEY, JSON.stringify(selectedExchanges));
  }, [selectedExchanges]);

  useEffect(() => {
    if (!toggleableExchanges.length) {
      return;
    }

    setSelectedExchanges((current) => {
      const filtered = current.filter((exchange): exchange is ExchangeName => toggleableExchanges.includes(exchange));
      const next = filtered.length >= 2 ? filtered : toggleableExchanges.slice(0, Math.max(2, toggleableExchanges.length));

      if (next.length === current.length && next.every((exchange, index) => exchange === current[index])) {
        return current;
      }

      return next;
    });
  }, [toggleableExchanges]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setNowTimestamp(Date.now());
    }, 30_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  const filteredOpportunities = useMemo(() => {
    const query = deferredSearch.trim().toUpperCase();

    const matchesFilter = (opportunity: ArbitrageOpportunity) => {
      switch (viewFilter) {
        case "positive":
          return opportunity.net_apr_percent > 0;
        case "negative":
          return opportunity.net_apr_percent < 0;
        case "high-confidence":
          return opportunity.confidence_score >= 0.75;
        case "alerts":
          return true;
        case "wide-spread":
          return Math.abs(opportunity.spread_rate) >= 0.0001;
        default:
          return true;
      }
    };

    const filtered = data.opportunities.filter((opportunity) => {
      const matchesSearch =
        !query ||
        opportunity.canonical_symbol.includes(query) ||
        opportunity.base_asset.toUpperCase().includes(query) ||
        opportunity.long_leg.display_name.toUpperCase().includes(query) ||
        opportunity.short_leg.display_name.toUpperCase().includes(query);
      return matchesSearch && matchesFilter(opportunity);
    });

    return [...filtered].sort((left, right) => {
      switch (sortBy) {
        case "net-desc":
          return right.net_apr_percent - left.net_apr_percent;
        case "net-asc":
          return left.net_apr_percent - right.net_apr_percent;
        case "confidence-desc":
          return right.confidence_score - left.confidence_score;
        case "oi-desc":
          return (right.combined_open_interest_usd ?? 0) - (left.combined_open_interest_usd ?? 0);
        case "funding-soon":
          return (
            new Date(getNextFundingTime(left) ?? Number.MAX_SAFE_INTEGER).getTime() -
            new Date(getNextFundingTime(right) ?? Number.MAX_SAFE_INTEGER).getTime()
          );
        case "symbol-asc":
          return left.base_asset.localeCompare(right.base_asset);
        case "spread-asc":
          return left.spread_rate - right.spread_rate;
        case "spread-desc":
        default:
          return Math.abs(right.spread_rate) - Math.abs(left.spread_rate);
      }
    });
  }, [data.opportunities, deferredSearch, sortBy, viewFilter]);

  const opportunityMap = useMemo(
    () => new Map(data.opportunities.map((opportunity) => [opportunity.canonical_symbol, opportunity])),
    [data.opportunities],
  );

  const alertSource = filteredOpportunities;
  const activeAlerts = useMemo(() => {
    return alertSource
      .map((opportunity) => {
        const spreadPercent = Math.abs(opportunity.spread_rate * 100);
        const reasons: string[] = [];

        if (spreadPercent >= alertPreferences.minSpreadPercent) {
          reasons.push(`spread ${formatPct(spreadPercent, 3)}`);
        }

        if (opportunity.net_apr_percent >= alertPreferences.minNetAprPercent) {
          reasons.push(`net APR ${formatPct(opportunity.net_apr_percent)}`);
        }

        return { opportunity, reasons };
      })
      .filter((item) => item.reasons.length > 0)
      .sort((left, right) => Math.abs(right.opportunity.spread_rate) - Math.abs(left.opportunity.spread_rate));
  }, [alertPreferences.minNetAprPercent, alertPreferences.minSpreadPercent, alertSource]);

  const alertSymbols = useMemo(() => new Set(activeAlerts.map((item) => item.opportunity.canonical_symbol)), [activeAlerts]);

  const visibleOpportunities = useMemo(() => {
    if (viewFilter !== "alerts") {
      return filteredOpportunities;
    }

    return filteredOpportunities.filter((opportunity) => alertSymbols.has(opportunity.canonical_symbol));
  }, [alertSymbols, filteredOpportunities, viewFilter]);

  const selectedOpportunity =
    data.opportunities.find((opportunity) => opportunity.canonical_symbol === selectedSymbol) ??
    visibleOpportunities[0] ??
    null;

  useEffect(() => {
    setSelectedSymbol((current) =>
      data.opportunities.some((opportunity) => opportunity.canonical_symbol === current)
        ? current
        : visibleOpportunities[0]?.canonical_symbol ?? data.opportunities[0]?.canonical_symbol ?? null,
    );
  }, [data.opportunities, visibleOpportunities]);

  useEffect(() => {
    const cooldownMs = notificationPreferences.cooldownMinutes * 60_000;
    const additions = activeAlerts
      .map(({ opportunity, reasons }) => {
        const signature = `${opportunity.canonical_symbol}:${reasons.join("|")}`;
        const existing = recentAlertsRef.current.find((item) => item.signature === signature);
        if (existing && nowTimestamp - new Date(existing.created_at).getTime() < cooldownMs) {
          return null;
        }

        return {
          id: `${Date.now()}-${opportunity.canonical_symbol}-${reasons.length}`,
          signature,
          symbol: opportunity.canonical_symbol,
          reasons,
          created_at: new Date().toISOString(),
        } satisfies AlertEvent;
      })
      .filter((item): item is AlertEvent => Boolean(item));

    if (!additions.length) {
      return;
    }

    setRecentAlerts((current) => [...additions, ...current].slice(0, 40));

    if (notificationPreferences.enabled && notificationPermission === "granted" && typeof Notification !== "undefined") {
      additions.slice(0, 3).forEach((event) => {
        const notification = new Notification(`ArbRadar alert: ${event.symbol}`, {
          body: event.reasons.join(" and "),
          tag: event.signature,
        });
        window.setTimeout(() => notification.close(), 6000);
      });
    }
  }, [activeAlerts, notificationPermission, notificationPreferences.cooldownMinutes, notificationPreferences.enabled, nowTimestamp]);

  const openOverview = (opportunity: ArbitrageOpportunity) => {
    setSelectedSymbol(opportunity.canonical_symbol);
    setIsOverviewOpen(true);
  };

  const openOverviewBySymbol = (canonicalSymbol: string) => {
    const opportunity = opportunityMap.get(canonicalSymbol);
    if (!opportunity) {
      return;
    }
    openOverview(opportunity);
  };

  const requestNotificationPermission = async () => {
    if (typeof Notification === "undefined") {
      setNotificationPermission("denied");
      return;
    }

    const permission = await Notification.requestPermission();
    setNotificationPermission(permission);
    if (permission === "granted") {
      setNotificationPreferences((current) => ({ ...current, enabled: true }));
    }
  };

  const exportVisibleRows = () => {
    downloadCsv(buildOpportunityCsv(visibleOpportunities), `arbradar-visible-${new Date().toISOString().slice(0, 19)}.csv`);
  };

  const summary = useMemo(() => {
    const positiveRows = visibleOpportunities.filter((item) => item.net_apr_percent > 0).length;
    const negativeRows = visibleOpportunities.filter((item) => item.net_apr_percent < 0).length;
    const avgConfidence = averageConfidence(visibleOpportunities) * 100;
    const largestSpread = visibleOpportunities.reduce((largest, item) => Math.max(largest, Math.abs(item.spread_rate)), 0);

    return { positiveRows, negativeRows, avgConfidence, largestSpread };
  }, [visibleOpportunities]);

  const selectedExchangeLabel = useMemo(
    () => selectedExchanges.map((exchange) => exchangeLabel(exchange)).join(", "),
    [selectedExchanges],
  );

  const toggleExchange = (exchange: ExchangeName) => {
    setSelectedExchanges((current) => {
      const isSelected = current.includes(exchange);
      if (isSelected) {
        if (current.length <= 2) {
          return current;
        }
        return current.filter((item) => item !== exchange);
      }

      return [...current, exchange];
    });
  };

  return (
    <main className="page">
      <nav className="top-nav">
        <a href="#dashboard" className="top-nav-link">Dashboard</a>
        <a href="#settlements" className="top-nav-link">Settlements</a>
        <a href="#table" className="top-nav-link">Table</a>
        <a href="https://t.me/alertbklbot" target="_blank" rel="noreferrer" className="top-nav-link">
          Bot
        </a>
      </nav>

      <section className="hero control-center-hero" id="dashboard">
        <div>
          <p className="eyebrow">ArbRadar</p>
          <h1>Funding Control Center</h1>
          <p className="lede">
            A live desk for funding spreads, settlement timing, and symbol-level comparison across Binance, Delta, CoinDCX, and CoinSwitch.
          </p>
        </div>

        <div className="hero-card control-center-card">
          <span className="chip">Desk state</span>
          <strong>{isLoading ? "Refreshing live data" : "Live monitor ready"}</strong>
          <p>
            Use the exchange scope toggles to keep the whole desk on the exact venues you want, then search, sort, refresh,
            export, and move quickly between the table and compare flow.
          </p>
        </div>
      </section>

      <section className="summary-grid control-center-grid">
        <article className="summary-card">
          <span className="subtle">Visible symbols</span>
          <strong>{visibleOpportunities.length.toLocaleString()}</strong>
        </article>
        <article className="summary-card">
          <span className="subtle">Positive / negative</span>
          <strong>
            {summary.positiveRows} / {summary.negativeRows}
          </strong>
        </article>
        <article className="summary-card">
          <span className="subtle">Average confidence</span>
          <strong>{summary.avgConfidence.toFixed(0)}/100</strong>
        </article>
        <article className="summary-card">
          <span className="subtle">Largest spread</span>
          <strong>{formatPct(summary.largestSpread * 100, 3)}</strong>
        </article>
        <article className="summary-card">
          <span className="subtle">Last refresh</span>
          <strong>{lastUpdatedAt ? formatTimestamp(lastUpdatedAt) : "Waiting"}</strong>
        </article>
      </section>

      <section className="status-grid">
        {statuses.map((status) => (
          <article className={`status-card ${selectedExchanges.includes(status.exchange) ? "status-card-active" : "status-card-muted"}`} key={status.exchange}>
            <div className="status-topline">
              <strong>{status.display_name}</strong>
              <span className={status.healthy ? "healthy" : status.configured ? "unhealthy" : "pending"}>
                {status.healthy ? "healthy" : status.configured ? "degraded" : "needs setup"}
              </span>
            </div>
            <p>{status.snapshot_count} symbols tracked</p>
            <span className="subtle">
              {status.last_error
                ? status.last_error
                : status.last_success_at
                  ? `Updated ${new Date(status.last_success_at).toLocaleTimeString()}`
                  : "Waiting for first poll"}
            </span>
          </article>
        ))}
      </section>

      <section className="exchange-scope-panel">
        <div className="overview-card-header">
          <div>
            <p className="eyebrow">Exchange Scope</p>
            <strong>{selectedExchanges.length} exchanges selected</strong>
          </div>
          <span className="subtle">Keep at least two exchanges active. The table, leaders, settlements, and compare view all follow this scope.</span>
        </div>
        <div className="exchange-scope-chips">
          {statuses
            .filter((status) => status.enabled && status.configured)
            .map((status) => {
              const active = selectedExchanges.includes(status.exchange);
              const locked = active && selectedExchanges.length <= 2;
              return (
                <button
                  key={status.exchange}
                  type="button"
                  className={`exchange-scope-chip ${exchangeToneClass(status.exchange)} ${active ? "exchange-scope-chip-active" : ""}`}
                  onClick={() => toggleExchange(status.exchange)}
                  disabled={locked}
                  aria-pressed={active}
                  title={locked ? "At least two exchanges must stay selected." : undefined}
                >
                  <span>{status.display_name}</span>
                  <strong>{active ? "On" : "Off"}</strong>
                </button>
              );
            })}
        </div>
        <div className="subtle exchange-scope-summary">Current desk scope: {selectedExchangeLabel || "Waiting for exchanges"}</div>
      </section>

      {error ? <div className="banner banner-error">{error}</div> : null}

      {isLoading && !fundingLeaders.length ? (
        <FundingLeadersSkeleton />
      ) : (
        <section id="leaders">
          <FundingLeadersPanel
            exchanges={fundingLeaders}
            nowTimestamp={nowTimestamp}
            onOpenSymbol={openOverviewBySymbol}
          />
        </section>
      )}

      <section id="settlements">
        <FundingSettlementBoard items={fundingSettlements} nowTimestamp={nowTimestamp} onOpenSymbol={openOverviewBySymbol} />
      </section>

      <section className="phase-three-grid">
        <section className="overview-card">
          <div className="overview-card-header">
            <div>
              <p className="eyebrow">Alert Center</p>
              <strong>{activeAlerts.length} active alerts</strong>
            </div>
            <span className="subtle">Watching all visible live rows inside the current exchange scope.</span>
          </div>

          <div className="alert-controls">
            <label className="control">
              <span className="subtle">Min spread %</span>
              <input
                type="number"
                step="0.01"
                value={alertPreferences.minSpreadPercent}
                onChange={(event) =>
                  setAlertPreferences((current) => ({
                    ...current,
                    minSpreadPercent: Number(event.target.value) || 0,
                  }))
                }
              />
            </label>
            <label className="control">
              <span className="subtle">Min net APR %</span>
              <input
                type="number"
                step="1"
                value={alertPreferences.minNetAprPercent}
                onChange={(event) =>
                  setAlertPreferences((current) => ({
                    ...current,
                    minNetAprPercent: Number(event.target.value) || 0,
                  }))
                }
              />
            </label>
          </div>

          {activeAlerts.length ? (
            <div className="alert-list">
              {activeAlerts.slice(0, 6).map(({ opportunity, reasons }) => (
                <button
                  type="button"
                  key={opportunity.canonical_symbol}
                  className="alert-item"
                  onClick={() => openOverview(opportunity)}
                >
                  <div className="alert-item-top">
                    <strong>{opportunity.canonical_symbol}</strong>
                    <span>{formatCountdown(getNextFundingTime(opportunity), nowTimestamp)}</span>
                  </div>
                  <div className="subtle">{reasons.join(" and ")}</div>
                </button>
              ))}
            </div>
          ) : (
            <div className="empty-state compact-empty">
              <p>No active alerts right now.</p>
              <span>Lower the thresholds if you want the live monitor to flag more rows.</span>
            </div>
          )}
        </section>

        <section className="overview-card">
          <div className="overview-card-header">
            <div>
              <p className="eyebrow">Desk Controls</p>
              <strong>{isLoading ? "Refreshing feed" : "Feed ready"}</strong>
            </div>
            <span className="subtle">{lastUpdatedAt ? `Last refresh ${formatTimestamp(lastUpdatedAt)}` : "Waiting for first refresh"}</span>
          </div>

          <div className="desk-controls">
            <label className="control">
              <span className="subtle">Refresh interval</span>
              <select value={String(refreshIntervalMs)} onChange={(event) => setRefreshIntervalMs(Number(event.target.value))}>
                <option value="0">Paused</option>
                <option value="5000">5 seconds</option>
                <option value="15000">15 seconds</option>
                <option value="30000">30 seconds</option>
                <option value="60000">60 seconds</option>
              </select>
            </label>
            <label className="control">
              <span className="subtle">Notification cooldown</span>
              <select
                value={String(notificationPreferences.cooldownMinutes)}
                onChange={(event) =>
                  setNotificationPreferences((current) => ({
                    ...current,
                    cooldownMinutes: Number(event.target.value),
                  }))
                }
              >
                <option value="5">5 minutes</option>
                <option value="15">15 minutes</option>
                <option value="30">30 minutes</option>
                <option value="60">60 minutes</option>
              </select>
            </label>
            <div className="button-row">
              <button type="button" className="action-button" onClick={() => void refresh()}>
                Refresh now
              </button>
              <button type="button" className="action-button" onClick={exportVisibleRows}>
                Export visible CSV
              </button>
            </div>
            <div className="notification-row">
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={notificationPreferences.enabled}
                  onChange={(event) =>
                    setNotificationPreferences((current) => ({
                      ...current,
                      enabled: event.target.checked,
                    }))
                  }
                  disabled={notificationPermission !== "granted"}
                />
                <span>Browser notifications</span>
              </label>
              <button type="button" className="action-button secondary-button" onClick={() => void requestNotificationPermission()}>
                {notificationPermission === "granted" ? "Permission granted" : "Enable notifications"}
              </button>
            </div>
            <div className="subtle">
              Permission: {notificationPermission}. Notifications only fire for new alerts that pass the cooldown window.
            </div>
          </div>

          <div className="recent-alerts">
            <div className="overview-card-header">
              <strong>Recent alert log</strong>
              <span className="subtle">{recentAlerts.length} stored events</span>
            </div>
            {recentAlerts.length ? (
              <div className="recent-alert-list">
                {recentAlerts.slice(0, 6).map((event) => (
                  <div key={event.id} className="alert-log-item">
                    <div className="alert-item-top">
                      <strong>{event.symbol}</strong>
                      <span>{formatTimestamp(event.created_at)}</span>
                    </div>
                    <div className="subtle">{event.reasons.join(" and ")}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-state compact-empty">
                <p>No alerts have triggered yet.</p>
                <span>The log fills automatically when the current alert thresholds are met.</span>
              </div>
            )}
          </div>
        </section>
      </section>

      <section className="workspace" id="table">
        <section className="panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Monitor Table</p>
              <h2>{visibleOpportunities.length} live funding comparisons</h2>
              <div className="subtle">
                Search inside the table, sort by spread or funding timing, export snapshots, and open any row for a full-screen overview.
              </div>
            </div>
            <div className="panel-note">{selectedOpportunity ? `Selected: ${selectedOpportunity.canonical_symbol}` : selectedExchangeLabel}</div>
          </div>

          <div className="exchange-health-strip">
            {statuses.map((status) => (
              <article key={status.exchange} className={`exchange-health-card ${status.exchange}`}>
                <div className="exchange-health-top">
                  <strong>{status.display_name}</strong>
                  <span className="subtle">{status.snapshot_count} rows</span>
                </div>
                <div className="exchange-health-badges">
                  {getExchangeHealthBadges(status).map((badge) => (
                    <span key={`${status.exchange}-${badge.label}`} className={`exchange-health-badge ${badge.tone}`}>
                      {badge.label}
                    </span>
                  ))}
                </div>
                <div className="subtle exchange-health-meta">
                  {status.last_success_at
                    ? `Updated ${new Date(status.last_success_at).toLocaleTimeString()}`
                    : status.last_error
                      ? status.last_error
                      : "Waiting for first poll"}
                </div>
              </article>
            ))}
          </div>

          <div className="table-toolbar sticky-toolbar">
            <label className="control search-control">
              <span className="subtle">Search</span>
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search BTC, ETH, Binance, Delta, CoinDCX, CoinSwitch..."
              />
            </label>

            <div className="exchange-toggle-inline">
              <span className="subtle">Exchanges</span>
              <div className="exchange-toggle-inline-row">
                {statuses
                  .filter((status) => status.enabled && status.configured)
                  .map((status) => {
                    const active = selectedExchanges.includes(status.exchange);
                    const locked = active && selectedExchanges.length <= 2;
                    return (
                      <button
                        key={status.exchange}
                        type="button"
                        className={`table-pill exchange-inline-pill ${exchangeToneClass(status.exchange)} ${active ? "exchange-inline-pill-active" : "exchange-inline-pill-muted"}`}
                        onClick={() => toggleExchange(status.exchange)}
                        disabled={locked}
                      >
                        {exchangeLabel(status.exchange)}
                      </button>
                    );
                  })}
              </div>
            </div>

            <label className="control">
              <span className="subtle">View</span>
              <select value={viewFilter} onChange={(event) => setViewFilter(event.target.value)}>
                <option value="all">All rows</option>
                <option value="alerts">Alerted rows</option>
                <option value="positive">Positive net APR</option>
                <option value="negative">Negative net APR</option>
                <option value="high-confidence">High confidence</option>
                <option value="wide-spread">Wide spreads</option>
              </select>
            </label>

            <label className="control">
              <span className="subtle">Sort</span>
              <select value={sortBy} onChange={(event) => setSortBy(event.target.value)}>
                <option value="spread-desc">Largest spread</option>
                <option value="spread-asc">Smallest spread</option>
                <option value="net-desc">Highest net APR</option>
                <option value="net-asc">Most negative APR</option>
                <option value="confidence-desc">Highest confidence</option>
                <option value="oi-desc">Largest open interest</option>
                <option value="funding-soon">Funding soonest</option>
                <option value="symbol-asc">Coin A-Z</option>
              </select>
            </label>

            <div className="toolbar-stat">
              <span className="subtle">Visible alerts</span>
              <strong>{activeAlerts.length}</strong>
            </div>
            <div className="toolbar-actions">
              <button type="button" className="action-button" onClick={() => void refresh()}>
                Refresh
              </button>
              <button type="button" className="action-button secondary-button" onClick={exportVisibleRows}>
                Export
              </button>
            </div>
          </div>

          {isLoading && !visibleOpportunities.length ? (
            <OpportunityTableSkeleton />
          ) : (
            <OpportunityTable
              opportunities={visibleOpportunities}
              selectedSymbol={selectedOpportunity?.canonical_symbol ?? null}
              selectedExchanges={selectedExchanges}
              nowTimestamp={nowTimestamp}
              onSelect={openOverview}
            />
          )}
        </section>
      </section>

      <OpportunityInspector
        opportunity={selectedOpportunity}
        isOpen={isOverviewOpen}
        nowTimestamp={nowTimestamp}
        selectedExchanges={selectedExchanges}
        onClose={() => setIsOverviewOpen(false)}
      />
    </main>
  );
}
