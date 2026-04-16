import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { OpportunityInspector } from "../components/OpportunityInspector";
import { OpportunityTable } from "../components/OpportunityTable";
import { useMarketFeed } from "../hooks/useMarketFeed";
import { useNow } from "../hooks/useNow";
import { exchangeLabel, exchangeToneClass, formatPct, formatTimestamp } from "../lib/monitor";
import type { ArbitrageOpportunity, ExchangeName } from "../lib/types";

const TRADE_REFRESH_KEY = "arbradar-trade-refresh";
const TRADE_SCOPE_KEY = "arbradar-trade-scope";

function averageConfidence(opportunities: ArbitrageOpportunity[]) {
  if (!opportunities.length) {
    return 0;
  }
  return opportunities.reduce((total, item) => total + item.confidence_score, 0) / opportunities.length;
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

export function TradeLandingPage() {
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState("positive-apr-desc");
  const [refreshIntervalMs, setRefreshIntervalMs] = useState(() => readStoredNumber(TRADE_REFRESH_KEY, 5000));
  const [selectedExchanges, setSelectedExchanges] = useState<ExchangeName[]>(
    () => readStoredStringArray(TRADE_SCOPE_KEY) as ExchangeName[],
  );
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [isOverviewOpen, setIsOverviewOpen] = useState(false);
  const nowTimestamp = useNow(1000);
  const deferredSearch = useDeferredValue(search);

  const { data, statuses, error, isLoading, lastUpdatedAt, refresh } = useMarketFeed(refreshIntervalMs, selectedExchanges);

  useEffect(() => {
    window.localStorage.setItem(TRADE_REFRESH_KEY, String(refreshIntervalMs));
  }, [refreshIntervalMs]);

  useEffect(() => {
    window.localStorage.setItem(TRADE_SCOPE_KEY, JSON.stringify(selectedExchanges));
  }, [selectedExchanges]);

  const toggleableExchanges = useMemo(
    () => statuses.filter((status) => status.enabled && status.configured).map((status) => status.exchange),
    [statuses],
  );

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

  const visibleOpportunities = useMemo(() => {
    const query = deferredSearch.trim().toUpperCase();
    const filtered = data.opportunities.filter((opportunity) => {
      if (!query) {
        return true;
      }
      return (
        opportunity.canonical_symbol.includes(query) ||
        opportunity.base_asset.toUpperCase().includes(query) ||
        opportunity.long_leg.display_name.toUpperCase().includes(query) ||
        opportunity.short_leg.display_name.toUpperCase().includes(query)
      );
    });

    return [...filtered].sort((left, right) => {
      switch (sortBy) {
        case "spread-desc":
          return Math.abs(right.spread_rate) - Math.abs(left.spread_rate);
        case "funding-soon":
          return (
            new Date(left.long_leg.next_funding_time ?? Number.MAX_SAFE_INTEGER).getTime() -
            new Date(right.long_leg.next_funding_time ?? Number.MAX_SAFE_INTEGER).getTime()
          );
        case "confidence-desc":
          return right.confidence_score - left.confidence_score;
        case "positive-apr-desc":
        default:
          if (left.net_apr_percent > 0 && right.net_apr_percent <= 0) {
            return -1;
          }
          if (right.net_apr_percent > 0 && left.net_apr_percent <= 0) {
            return 1;
          }
          return right.net_apr_percent - left.net_apr_percent;
      }
    });
  }, [data.opportunities, deferredSearch, sortBy]);

  useEffect(() => {
    setSelectedSymbol((current) =>
      visibleOpportunities.some((opportunity) => opportunity.canonical_symbol === current)
        ? current
        : visibleOpportunities[0]?.canonical_symbol ?? null,
    );
  }, [visibleOpportunities]);

  const selectedOpportunity = visibleOpportunities.find((item) => item.canonical_symbol === selectedSymbol) ?? null;
  const summary = useMemo(() => {
    const positiveRows = visibleOpportunities.filter((item) => item.net_apr_percent > 0).length;
    const avgConfidence = averageConfidence(visibleOpportunities) * 100;
    const strongestApr = visibleOpportunities.reduce((best, item) => Math.max(best, item.net_apr_percent), 0);
    return { positiveRows, avgConfidence, strongestApr };
  }, [visibleOpportunities]);

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
        <a href="/" className="top-nav-link">Dashboard</a>
        <a href="/trade" className="top-nav-link">Trade</a>
        <a href="https://t.me/alertbklbot" target="_blank" rel="noreferrer" className="top-nav-link">
          Bot
        </a>
      </nav>

      <section className="hero control-center-hero">
        <div>
          <p className="eyebrow">Trade Desk</p>
          <h1>Arm the funding trade</h1>
          <p className="lede">
            Reuse the live monitor table, open a symbol-specific trade workspace, then arm either a paper run or a real scheduled hedge around funding.
          </p>
        </div>

        <div className="hero-card control-center-card">
          <span className="chip">Execution flow</span>
          <strong>Table to trade workspace</strong>
          <p>
            Pick the symbol, open the trade page, review the best or reverse setup, add exchange credentials locally, and arm the trade before the funding window.
          </p>
        </div>
      </section>

      <section className="summary-grid control-center-grid">
        <article className="summary-card">
          <span className="subtle">Live candidates</span>
          <strong>{visibleOpportunities.length}</strong>
        </article>
        <article className="summary-card">
          <span className="subtle">Positive APR rows</span>
          <strong>{summary.positiveRows}</strong>
        </article>
        <article className="summary-card">
          <span className="subtle">Strongest APR</span>
          <strong>{formatPct(summary.strongestApr)}</strong>
        </article>
        <article className="summary-card">
          <span className="subtle">Average confidence</span>
          <strong>{summary.avgConfidence.toFixed(0)}/100</strong>
        </article>
        <article className="summary-card">
          <span className="subtle">Last refresh</span>
          <strong>{lastUpdatedAt ? formatTimestamp(lastUpdatedAt) : "Waiting"}</strong>
        </article>
      </section>

      {error ? <div className="banner banner-error">{error}</div> : null}

      <section className="exchange-scope-panel">
        <div className="overview-card-header">
          <div>
            <p className="eyebrow">Trade scope</p>
            <strong>{selectedExchanges.length} exchanges active</strong>
          </div>
          <span className="subtle">The same scope follows the trade page so preview, timing, and live support match what you picked here.</span>
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
                >
                  <span>{exchangeLabel(status.exchange)}</span>
                  <strong>{active ? "On" : "Off"}</strong>
                </button>
              );
            })}
        </div>
      </section>

      <section className="panel workspace">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Trade Table</p>
            <h2>{visibleOpportunities.length} live trade candidates</h2>
            <div className="subtle">Use the same live coin table, then jump straight into `/trade/:symbol` from any row.</div>
          </div>
          <div className="panel-note">{isLoading ? "Refreshing live data" : "Ready for arming"}</div>
        </div>

        <div className="table-toolbar sticky-toolbar">
          <label className="control search-control">
            <span className="subtle">Search</span>
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search BTC, ETH, Binance, Delta..." />
          </label>
          <label className="control">
            <span className="subtle">Sort</span>
            <select value={sortBy} onChange={(event) => setSortBy(event.target.value)}>
              <option value="positive-apr-desc">Most positive APR</option>
              <option value="spread-desc">Largest spread</option>
              <option value="confidence-desc">Highest confidence</option>
              <option value="funding-soon">Funding soonest</option>
            </select>
          </label>
          <label className="control">
            <span className="subtle">Refresh interval</span>
            <select value={String(refreshIntervalMs)} onChange={(event) => setRefreshIntervalMs(Number(event.target.value))}>
              <option value="0">Paused</option>
              <option value="5000">5 seconds</option>
              <option value="15000">15 seconds</option>
              <option value="30000">30 seconds</option>
            </select>
          </label>
          <div className="toolbar-actions">
            <button type="button" className="action-button" onClick={() => void refresh()}>
              Refresh
            </button>
          </div>
        </div>

        <OpportunityTable
          opportunities={visibleOpportunities}
          selectedSymbol={selectedSymbol}
          selectedExchanges={selectedExchanges}
          nowTimestamp={nowTimestamp}
          onSelect={(opportunity) => {
            setSelectedSymbol(opportunity.canonical_symbol);
            setIsOverviewOpen(true);
          }}
        />
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
