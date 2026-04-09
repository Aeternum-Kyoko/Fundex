import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { FundingLeadersPanel } from "./components/FundingLeadersPanel";
import { FundingSettlementBoard } from "./components/FundingSettlementBoard";
import { FundingLeadersSkeleton, OpportunityTableSkeleton } from "./components/LoadingSkeletons";
import { OpportunityInspector } from "./components/OpportunityInspector";
import { OpportunityTable } from "./components/OpportunityTable";
import { useFundingTrends } from "./hooks/useFundingTrends";
import { useMarketFeed } from "./hooks/useMarketFeed";
import { useOpportunityHistory } from "./hooks/useOpportunityHistory";
import {
  buildOpportunityCsv,
  formatCountdown,
  formatPct,
  formatTimestamp,
  getNextFundingTime,
} from "./lib/monitor";
import type { ArbitrageOpportunity, FundingTrendPoint } from "./lib/types";

const WATCHLIST_KEY = "arbradar-watchlist";
const ALERTS_KEY = "arbradar-alerts";
const REFRESH_KEY = "arbradar-refresh";
const NOTIFICATIONS_KEY = "arbradar-notifications";
const ALERT_HISTORY_KEY = "arbradar-alert-history";

interface AlertPreferences {
  minSpreadPercent: number;
  minNetAprPercent: number;
  watchlistOnly: boolean;
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

const defaultAlertPreferences: AlertPreferences = {
  minSpreadPercent: 0.08,
  minNetAprPercent: 10,
  watchlistOnly: true,
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

function readStoredArray(key: string) {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
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

export function App() {
  const [search, setSearch] = useState("");
  const [viewFilter, setViewFilter] = useState("all");
  const [sortBy, setSortBy] = useState("spread-desc");
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [isOverviewOpen, setIsOverviewOpen] = useState(false);
  const [nowTimestamp, setNowTimestamp] = useState(Date.now());
  const [refreshIntervalMs, setRefreshIntervalMs] = useState(() => readStoredNumber(REFRESH_KEY, 5000));
  const [watchlist, setWatchlist] = useState<string[]>(() => readStoredArray(WATCHLIST_KEY));
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
  const recentAlertsRef = useRef(recentAlerts);

  const { data, statuses, fundingLeaders, fundingSettlements, error, isLoading, lastUpdatedAt, refresh } =
    useMarketFeed(refreshIntervalMs);
  const deferredSearch = useDeferredValue(search);

  const fundingLeaderSymbols = useMemo(
    () =>
      Array.from(
        new Set(
          fundingLeaders.flatMap((exchange) =>
            [...exchange.top_positive, ...exchange.top_negative].map((leader) => leader.canonical_symbol),
          ),
        ),
      ),
    [fundingLeaders],
  );
  const activeExchanges = useMemo(
    () => (data.exchanges_in_backend.length ? data.exchanges_in_backend : statuses.map((status) => status.exchange)),
    [data.exchanges_in_backend, statuses],
  );
  const { series: fundingTrendSeries, loading: fundingTrendLoading } = useFundingTrends(
    fundingLeaderSymbols,
    activeExchanges,
  );

  useEffect(() => {
    recentAlertsRef.current = recentAlerts;
    window.localStorage.setItem(ALERT_HISTORY_KEY, JSON.stringify(recentAlerts));
  }, [recentAlerts]);

  useEffect(() => {
    window.localStorage.setItem(WATCHLIST_KEY, JSON.stringify(watchlist));
  }, [watchlist]);

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
        case "watchlist":
          return watchlist.includes(opportunity.canonical_symbol);
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
  }, [data.opportunities, deferredSearch, sortBy, viewFilter, watchlist]);

  const opportunityMap = useMemo(
    () => new Map(data.opportunities.map((opportunity) => [opportunity.canonical_symbol, opportunity])),
    [data.opportunities],
  );

  const watchlistOpportunities = useMemo(
    () => watchlist.map((symbol) => opportunityMap.get(symbol)).filter((item): item is ArbitrageOpportunity => Boolean(item)),
    [opportunityMap, watchlist],
  );

  const fundingTrendMap = useMemo(() => {
    const map: Record<string, Record<string, FundingTrendPoint[]>> = {};
    fundingTrendSeries.forEach((entry) => {
      map[entry.canonical_symbol] ??= {};
      map[entry.canonical_symbol][entry.exchange] = entry.points;
    });
    return map;
  }, [fundingTrendSeries]);

  const alertSource = alertPreferences.watchlistOnly ? watchlistOpportunities : filteredOpportunities;
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

  const { history, loading } = useOpportunityHistory(selectedOpportunity?.canonical_symbol ?? null);

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

  const toggleWatchlist = (symbol: string) => {
    setWatchlist((current) => (current.includes(symbol) ? current.filter((item) => item !== symbol) : [...current, symbol]));
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

  const exportWatchlistRows = () => {
    downloadCsv(buildOpportunityCsv(watchlistOpportunities), `arbradar-watchlist-${new Date().toISOString().slice(0, 19)}.csv`);
  };

  const summary = useMemo(() => {
    const positiveRows = visibleOpportunities.filter((item) => item.net_apr_percent > 0).length;
    const negativeRows = visibleOpportunities.filter((item) => item.net_apr_percent < 0).length;
    const avgConfidence = averageConfidence(visibleOpportunities) * 100;
    const largestSpread = visibleOpportunities.reduce((largest, item) => Math.max(largest, Math.abs(item.spread_rate)), 0);

    return { positiveRows, negativeRows, avgConfidence, largestSpread };
  }, [visibleOpportunities]);

  return (
    <main className="page">
      <section className="hero">
        <div>
          <p className="eyebrow">ArbRadar</p>
          <h1>Dark Funding Monitor</h1>
          <p className="lede">
            Phase 4 turns the dashboard into an operations desk with live feed controls, browser notifications, alert history,
            and one-click CSV export across every active exchange in the monitor.
          </p>
        </div>

        <div className="hero-card">
          <span className="chip">Current phase</span>
          <strong>Phase 4</strong>
          <p>Monitor, notify, export, review, and now jump from funding boards straight into pinned rows and full overview.</p>
        </div>
      </section>

      <section className="summary-grid">
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
      </section>

      <section className="status-grid">
        {statuses.map((status) => (
          <article className="status-card" key={status.exchange}>
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

      {error ? <div className="banner banner-error">{error}</div> : null}

      {isLoading && !fundingLeaders.length ? (
        <FundingLeadersSkeleton />
      ) : (
        <FundingLeadersPanel
          exchanges={fundingLeaders}
          pinnedSymbols={watchlist}
          trendMap={fundingTrendMap}
          trendLoading={fundingTrendLoading}
          nowTimestamp={nowTimestamp}
          onOpenSymbol={openOverviewBySymbol}
          onTogglePin={toggleWatchlist}
        />
      )}

      <FundingSettlementBoard items={fundingSettlements} nowTimestamp={nowTimestamp} onOpenSymbol={openOverviewBySymbol} />

      <section className="phase-three-grid">
        <section className="overview-card">
          <div className="overview-card-header">
            <div>
              <p className="eyebrow">Watchlist</p>
              <strong>{watchlistOpportunities.length} saved symbols</strong>
            </div>
            <span className="subtle">Open any card for full overview</span>
          </div>

          {watchlistOpportunities.length ? (
            <div className="watchlist-grid">
              {watchlistOpportunities.map((opportunity) => {
                const nextFunding = getNextFundingTime(opportunity);
                return (
                  <button
                    type="button"
                    key={opportunity.canonical_symbol}
                    className="watchlist-card"
                    onClick={() => openOverview(opportunity)}
                  >
                    <div className="watchlist-card-top">
                      <strong>{opportunity.canonical_symbol}</strong>
                      <span className={opportunity.net_apr_percent >= 0 ? "positive" : "negative"}>
                        {formatPct(opportunity.net_apr_percent)}
                      </span>
                    </div>
                    <div className="subtle">Lower on {opportunity.long_leg.display_name}</div>
                    <div className="watchlist-meta">
                      <span>{formatPct(opportunity.spread_rate * 100, 3)} spread</span>
                      <span>{formatCountdown(nextFunding, nowTimestamp)}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="empty-state compact-empty">
              <p>Your watchlist is empty.</p>
              <span>Use Pin from the funding boards or Watch from the table to save symbols here.</span>
            </div>
          )}
        </section>

        <section className="overview-card">
          <div className="overview-card-header">
            <div>
              <p className="eyebrow">Alert Center</p>
              <strong>{activeAlerts.length} active alerts</strong>
            </div>
            <span className="subtle">{alertPreferences.watchlistOnly ? "Watching saved symbols only" : "Watching all visible rows"}</span>
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
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={alertPreferences.watchlistOnly}
                onChange={(event) =>
                  setAlertPreferences((current) => ({
                    ...current,
                    watchlistOnly: event.target.checked,
                  }))
                }
              />
              <span>Watchlist only</span>
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
              <span>Lower the thresholds or add more symbols to the watchlist to make this more sensitive.</span>
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
              <button type="button" className="action-button" onClick={exportWatchlistRows}>
                Export watchlist CSV
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

      <section className="workspace">
        <section className="panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Monitor Table</p>
              <h2>{visibleOpportunities.length} live funding comparisons</h2>
              <div className="subtle">
                Search inside the table, sort by spread or funding timing, export snapshots, and open any row for a full-screen overview.
              </div>
            </div>
            <div className="panel-note">
              {selectedOpportunity ? `Selected: ${selectedOpportunity.canonical_symbol}` : data.phase}
            </div>
          </div>

          <div className="table-toolbar">
            <label className="control search-control">
              <span className="subtle">Search</span>
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search BTC, ETH, Binance, Delta, CoinDCX..."
              />
            </label>

            <label className="control">
              <span className="subtle">View</span>
              <select value={viewFilter} onChange={(event) => setViewFilter(event.target.value)}>
                <option value="all">All rows</option>
                <option value="watchlist">Watchlist</option>
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
              <span className="subtle">Watchlist / alerts</span>
              <strong>
                {watchlistOpportunities.length} / {activeAlerts.length}
              </strong>
            </div>
          </div>

          {isLoading && !visibleOpportunities.length ? (
            <OpportunityTableSkeleton />
          ) : (
            <OpportunityTable
              opportunities={visibleOpportunities}
              selectedSymbol={selectedOpportunity?.canonical_symbol ?? null}
              watchlist={watchlist}
              nowTimestamp={nowTimestamp}
              onSelect={openOverview}
              onToggleWatchlist={toggleWatchlist}
            />
          )}
        </section>
      </section>

      <OpportunityInspector
        opportunity={selectedOpportunity}
        history={history}
        loading={loading}
        isOpen={isOverviewOpen}
        isWatched={selectedOpportunity ? watchlist.includes(selectedOpportunity.canonical_symbol) : false}
        nowTimestamp={nowTimestamp}
        onClose={() => setIsOverviewOpen(false)}
        onToggleWatchlist={toggleWatchlist}
      />
    </main>
  );
}
