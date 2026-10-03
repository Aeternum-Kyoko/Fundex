import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { ArbitrageOpportunity, TrustLevel } from "../lib/types";
import { DetailContent, DetailSheet } from "./detail";
import { type Density, PairCards, PairTable, type SortKey } from "./pairs";
import { CaptureCards, CapturePicks, type CaptureRow, CaptureTable } from "./capture";
import { type SectionTab, AppChrome } from "./chrome";
import { AnimatedPct } from "./motion";
import { Ticker } from "./ticker";
import { downloadCsv, PulseStrip } from "./panels";
import { useMediaQuery, usePref } from "./prefs";
import { EdgeLine, type EdgeScale, EXCHANGE_SHORT, exchangeVar, hoursLabel, Icon, makeEdgeScale, nextPayout, pct, TrustBadge } from "./primitives";
import { CalendarView } from "./calendar";
import { HealthView, useUnhealthyCount } from "./health";
import { HeatmapView } from "./heatmap";
import { PositionsStrip, usePositions } from "./insights";
import { SkeletonRows } from "./states";
import { pairSparks, TrendsView, useFundingTrends } from "./trends";
import { useDashboard } from "./useDashboard";
import { AlertsView, Empty, LeadersView, SettlementsView, useAlerts } from "./views";
import "./design.css";
import "./legacy.css";

type Tab = "pairs" | "leaders" | "heatmap" | "trends" | "calendar" | "settlements" | "alerts" | "health";
type Filter = "all" | "profitable" | "trusted" | "alerting";
type Strategy = "capture" | "hold";

const TRUST_RANK: Record<TrustLevel, number> = { low: 0, medium: 1, high: 2 };

function horizonText(hours: number) {
  return hours % 24 === 0 ? `${hours / 24} days` : `${hours}h`;
}

function sortCaptureRows(rows: CaptureRow[], sort: SortKey) {
  const by: Record<SortKey, (a: CaptureRow, b: CaptureRow) => number> = {
    net: (a, b) => b.capture.net_percent - a.capture.net_percent,
    spread: (a, b) => b.capture.capture_percent - a.capture.capture_percent,
    next: (a, b) => a.capture.settles_at.localeCompare(b.capture.settles_at) || b.capture.net_percent - a.capture.net_percent,
    trust: (a, b) => TRUST_RANK[b.capture.data_trust_level] - TRUST_RANK[a.capture.data_trust_level] || b.capture.net_percent - a.capture.net_percent,
    breakeven: (a, b) => a.capture.cost_percent - b.capture.cost_percent,
    coin: (a, b) => a.base_asset.localeCompare(b.base_asset),
    oi: (a, b) => (b.combined_open_interest_usd ?? 0) - (a.combined_open_interest_usd ?? 0),
  };
  return [...rows].sort(by[sort]);
}

function sortRows(rows: ArbitrageOpportunity[], sort: SortKey) {
  const sorted = [...rows];
  const by = {
    net: (a: ArbitrageOpportunity, b: ArbitrageOpportunity) => b.net_return_percent - a.net_return_percent,
    spread: (a: ArbitrageOpportunity, b: ArbitrageOpportunity) => b.spread_rate - a.spread_rate,
    breakeven: (a: ArbitrageOpportunity, b: ArbitrageOpportunity) => (a.break_even_hours ?? Infinity) - (b.break_even_hours ?? Infinity),
    trust: (a: ArbitrageOpportunity, b: ArbitrageOpportunity) =>
      TRUST_RANK[b.trust_level] - TRUST_RANK[a.trust_level] || b.confidence_score - a.confidence_score || b.net_return_percent - a.net_return_percent,
    next: (a: ArbitrageOpportunity, b: ArbitrageOpportunity) =>
      new Date(nextPayout(a) ?? 8.64e15).getTime() - new Date(nextPayout(b) ?? 8.64e15).getTime(),
    coin: (a: ArbitrageOpportunity, b: ArbitrageOpportunity) => a.base_asset.localeCompare(b.base_asset),
    oi: (a: ArbitrageOpportunity, b: ArbitrageOpportunity) => (b.combined_open_interest_usd ?? 0) - (a.combined_open_interest_usd ?? 0),
  }[sort];
  return sorted.sort(by);
}

function BestPicks({
  rows,
  scale,
  horizonLabel,
  onOpen,
  loading,
}: {
  rows: ArbitrageOpportunity[];
  scale: EdgeScale;
  horizonLabel: string;
  onOpen: (symbol: string) => void;
  loading: boolean;
}) {
  const picks = useMemo(
    () =>
      rows
        .filter((row) => row.net_return_percent > 0 && row.trust_level !== "low")
        .sort((a, b) => TRUST_RANK[b.trust_level] - TRUST_RANK[a.trust_level] || b.net_return_percent - a.net_return_percent)
        .slice(0, 3),
    [rows],
  );
  if (loading) return null;
  if (!picks.length) {
    return (
      <section className="t-best" aria-label="Best right now">
        <div className="t-best-empty">
          <strong>Nothing worth trading right now</strong>
          No pair clears fees and slippage over {horizonLabel} with medium or high trust. Low-trust pairs are still listed below with the reason they failed.
        </div>
      </section>
    );
  }
  return (
    <section className="t-best" aria-label="Best right now">
      {picks.map((pick, index) => (
        <button key={pick.canonical_symbol} type="button" className="t-best-card" data-lead={index === 0} onClick={() => onOpen(pick.canonical_symbol)}>
          <span className="t-best-kicker">{index === 0 ? "Best trade right now" : `Also worth a look`}</span>
          <h2 className="t-best-title">
            Long {pick.base_asset} on {EXCHANGE_SHORT[pick.long_leg.exchange]}, short on {EXCHANGE_SHORT[pick.short_leg.exchange]}
          </h2>
          <span className="t-best-money">
            <strong className="t-num"><AnimatedPct value={pick.net_return_percent} digits={2} signed /></strong>
            <span className="t-soft">over {horizonLabel} after costs</span>
          </span>
          <EdgeLine opportunity={pick} scale={scale} height={index === 0 ? 30 : 24} />
          <span className="t-card-meta">
            <TrustBadge level={pick.trust_level} compact />
            <span className="t-num">Break-even {hoursLabel(pick.break_even_hours)}</span>
          </span>
        </button>
      ))}
    </section>
  );
}

export function Terminal() {
  const [scope, setScope] = usePref<string[]>("arbradar-scope-v2", []);
  const [paused, setPaused] = useState(false);
  const { data, error, link, receivedAt, refresh } = useDashboard(scope, paused);
  const positions = usePositions();
  const unhealthy = useUnhealthyCount(data?.statuses ?? []);
  const [density, setDensity] = usePref<Density>("arbradar-density", "compact");
  // Default to how this desk is traded: in just before a settlement, out right after.
  const [strategy, setStrategy] = usePref<Strategy>("arbradar-strategy", "capture");
  // Each strategy remembers its own sort; captures default to the countdown.
  const [holdSort, setHoldSort] = usePref<SortKey>("arbradar-sort-hold", "net");
  const [captureSort, setCaptureSort] = usePref<SortKey>("arbradar-sort-capture", "next");
  const sort = strategy === "capture" ? captureSort : holdSort;
  const setSort = strategy === "capture" ? setCaptureSort : setHoldSort;
  const [tab, setTab] = useState<Tab>(() => {
    const requested = new URLSearchParams(window.location.search).get("tab");
    return requested === "health" || requested === "leaders" || requested === "heatmap" || requested === "trends" || requested === "calendar" || requested === "settlements" || requested === "alerts" ? requested : "pairs";
  });
  const [filter, setFilter] = usePref<Filter>("arbradar-filter", "all");
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(() => decodeURIComponent(window.location.hash.slice(1)) || null);
  const isPhone = useMediaQuery("(max-width: 759px)");
  const isWide = useMediaQuery("(min-width: 1180px)");
  const searchRef = useRef<HTMLInputElement>(null);
  const deferredSearch = useDeferredValue(search.trim().toUpperCase());

  // The open pair lives in the URL hash: shareable, and the phone's back gesture closes the sheet.
  const open = useCallback((symbol: string) => {
    setSelected(symbol);
    if (window.location.hash.slice(1) !== encodeURIComponent(symbol)) window.location.hash = encodeURIComponent(symbol);
  }, []);
  const close = useCallback(() => {
    setSelected(null);
    if (window.location.hash) history.replaceState(null, "", window.location.pathname + window.location.search);
  }, []);
  useEffect(() => {
    const onHash = () => setSelected(decodeURIComponent(window.location.hash.slice(1)) || null);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const opportunities = data?.opportunities ?? [];
  const notional = data?.reference_notional_usd ?? 1000;
  const horizonLabel = horizonText(data?.holding_horizon_hours ?? 168);
  const alerts = useAlerts(opportunities, horizonLabel);
  const alertSymbols = useMemo(() => new Set(alerts.matches.map((item) => item.canonical_symbol)), [alerts.matches]);
  const scale = useMemo(() => makeEdgeScale(opportunities), [opportunities]);

  const captureMode = strategy === "capture";
  const rows = useMemo(() => {
    const filtered = opportunities.filter((row) => {
      // A setup that collects nothing at the settlement isn't a capture; keep the list to real payments.
      if (captureMode && (!row.capture || row.capture.capture_percent <= 0)) return false;
      const profitable = captureMode ? (row.capture?.net_percent ?? 0) > 0 : row.net_return_percent > 0;
      const trusted = captureMode ? row.capture?.data_trust_level === "high" : row.trust_level === "high";
      if (filter === "profitable" && !profitable) return false;
      if (filter === "trusted" && !trusted) return false;
      if (filter === "alerting" && !alertSymbols.has(row.canonical_symbol)) return false;
      if (!deferredSearch) return true;
      return (
        row.canonical_symbol.includes(deferredSearch) ||
        row.long_leg.display_name.toUpperCase().includes(deferredSearch) ||
        row.short_leg.display_name.toUpperCase().includes(deferredSearch)
      );
    });
    return captureMode ? sortCaptureRows(filtered as CaptureRow[], sort) : sortRows(filtered, sort);
  }, [opportunities, filter, deferredSearch, sort, alertSymbols, captureMode]);

  // Spread trend for the first screenful of rows; one request, refreshed each minute.
  const sparkRows = useMemo(() => (captureMode ? [] : rows.slice(0, 30)), [rows, captureMode]);
  const sparkPairs = useMemo(
    () =>
      sparkRows.map((row) => ({
        symbol: row.canonical_symbol,
        long: row.long_leg.exchange,
        short: row.short_leg.exchange,
        longInterval: row.long_leg.funding_interval_hours ?? row.funding_interval_hours,
        shortInterval: row.short_leg.funding_interval_hours ?? row.funding_interval_hours,
      })),
    [sparkRows],
  );
  const { series: sparkSeries } = useFundingTrends(
    sparkPairs.map((pair) => pair.symbol),
    useMemo(() => [...new Set(sparkPairs.flatMap((pair) => [pair.long, pair.short]))].sort(), [sparkPairs]),
    60,
    60_000,
  );
  const sparks = useMemo(() => pairSparks(sparkSeries, sparkPairs), [sparkSeries, sparkPairs]);

  const selectedRow = useMemo(() => opportunities.find((row) => row.canonical_symbol === selected) ?? null, [opportunities, selected]);
  const exchangesQuery = data?.selected_exchanges?.length ? `?exchanges=${encodeURIComponent(data.selected_exchanges.join(","))}` : "";
  const counts = useMemo(
    () => ({
      all: captureMode ? opportunities.filter((row) => (row.capture?.capture_percent ?? 0) > 0).length : opportunities.length,
      profitable: opportunities.filter((row) => (captureMode ? (row.capture?.net_percent ?? 0) > 0 : row.net_return_percent > 0)).length,
      trusted: opportunities.filter((row) => (captureMode ? row.capture?.data_trust_level === "high" : row.trust_level === "high")).length,
      alerting: alertSymbols.size,
    }),
    [opportunities, alertSymbols, captureMode],
  );

  // Keyboard: "/" search, j/k move, Enter open, Esc close.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const typing = target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA";
      if (event.key === "/" && !typing) {
        event.preventDefault();
        setSearchOpen(true);
        window.setTimeout(() => searchRef.current?.focus(), 0);
        return;
      }
      if (event.key === "Escape") {
        if (typing) (target as HTMLInputElement).blur();
        else close();
        return;
      }
      if (typing || tab !== "pairs" || !rowsRef.current.length) return;
      if (event.key === "j" || event.key === "k") {
        const list = rowsRef.current;
        const index = list.findIndex((row) => row.canonical_symbol === selected);
        const next = event.key === "j" ? Math.min(list.length - 1, index + 1) : Math.max(0, index - 1);
        open(list[next].canonical_symbol);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, open, selected, tab]);

  const available = data?.available_exchanges ?? [];
  const active = data?.selected_exchanges ?? available;
  const toggleExchange = (exchange: string) => {
    const current = scope.length ? scope : active;
    if (current.includes(exchange)) {
      if (current.length <= 2) return;
      setScope(current.filter((item) => item !== exchange));
    } else {
      setScope([...current, exchange]);
    }
  };

  const detail = selectedRow ? (
    <DetailContent
      key={selectedRow.canonical_symbol}
      opportunity={selectedRow}
      scale={scale}
      horizonLabel={horizonLabel}
      onClose={close}
      exchangesQuery={exchangesQuery}
      captureFirst={captureMode}
      positions={positions}
    />
  ) : null;

  const topActions = (
    <>
      <label className="t-search" data-open={searchOpen}>
        {Icon.search}
        <input
          ref={searchRef}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onBlur={() => !search && setSearchOpen(false)}
          placeholder="Search coin or exchange"
          aria-label="Search coin or exchange"
          enterKeyHint="search"
        />
        <span className="t-kbd">/</span>
      </label>
      {isPhone ? (
        <button
          type="button"
          className="t-icon-btn"
          aria-label="Search"
          onClick={() => {
            setSearchOpen(true);
            setTab("pairs");
            window.setTimeout(() => searchRef.current?.focus(), 0);
          }}
        >
          {Icon.search}
        </button>
      ) : null}
    </>
  );

  return (
    <AppChrome
      active="dashboard"
      exchangesQuery={exchangesQuery}
      hideBrandText={searchOpen && isPhone}
      topActions={topActions}
      onSection={(next: SectionTab) => setTab(next)}
      moreExtras={[
        { label: "Export CSV", description: "Download the pairs you're viewing", onClick: () => downloadCsv(rows) },
        { label: paused ? "Resume live updates" : "Pause live updates", description: paused ? "Numbers are frozen right now" : "Freeze the numbers while you read", onClick: () => setPaused(!paused) },
      ]}
    >
      <div className="t-shell" data-detail={selectedRow && isWide ? "open" : "closed"}>
        <main className="t-main">
          {error ? (
            <div className="t-banner" role="alert">
              {error}{" "}
              <button type="button" className="t-text-btn" onClick={() => void refresh()}>
                Retry
              </button>
            </div>
          ) : null}

          {data ? <Ticker rows={opportunities} onOpen={open} /> : null}

          {tab === "pairs" ? <PositionsStrip trades={positions} opportunities={opportunities} onOpen={open} /> : null}

          {tab === "pairs" && data ? (
            captureMode ? (
              <CapturePicks rows={opportunities.filter((row): row is CaptureRow => Boolean(row.capture))} notional={notional} onOpen={open} />
            ) : (
              <BestPicks rows={opportunities} scale={scale} horizonLabel={horizonLabel} onOpen={open} loading={!data} />
            )
          ) : null}

          {data ? (
            <PulseStrip
              rows={rows}
              all={opportunities}
              profitable={counts.profitable}
              profitableLabel={captureMode ? "pay for themselves at the next settlement" : `profitable over ${horizonLabel}`}
              receivedAt={receivedAt}
              link={link}
              onOpenFeeds={() => setTab("health")}
            />
          ) : null}

          <div className="t-tabs" role="tablist">
            {(
              [
                ["pairs", "Pairs", opportunities.length],
                ["leaders", "Funding leaders", null],
                ["heatmap", "Heatmap", null],
                ["trends", "Rate history", null],
                ["calendar", "Calendar", null],
                ["settlements", "Settlements", data?.settlements.length ?? null],
                ["alerts", "Alerts", alertSymbols.size],
                ["health", "Exchange health", unhealthy || null],
              ] as const
            ).map(([key, label, count]) => (
              <button key={key} type="button" role="tab" className="t-tab" aria-selected={tab === key} onClick={() => setTab(key)}>
                {label}
                {count != null ? <span className="t-tab-count t-num">{count}</span> : null}
              </button>
            ))}
          </div>

          <div className="t-view" key={tab}>
          {tab === "pairs" ? (
            <>
              <div className="t-toolbar">
                <div className="t-segmented t-strategy" role="group" aria-label="Strategy">
                  <button type="button" aria-pressed={captureMode} onClick={() => setStrategy("capture")} title="Enter just before a settlement, collect it, exit right after">
                    Next funding
                  </button>
                  <button type="button" aria-pressed={!captureMode} onClick={() => setStrategy("hold")} title={`Keep the hedge on for ${horizonLabel} and collect every settlement`}>
                    Hold {horizonLabel}
                  </button>
                </div>
                <div className="t-segmented" role="group" aria-label="Show">
                  {(
                    [
                      ["all", "All"],
                      ["profitable", "Profitable"],
                      ["trusted", "High trust"],
                      ["alerting", "Alerting"],
                    ] as const
                  ).map(([key, label]) => (
                    <button key={key} type="button" aria-pressed={filter === key} onClick={() => setFilter(key)}>
                      {label} <span className="t-num t-muted">{counts[key]}</span>
                    </button>
                  ))}
                </div>
                <div className="t-scope" role="group" aria-label="Exchanges">
                  {available.map((exchange) => {
                    const on = active.includes(exchange);
                    return (
                      <button
                        key={exchange}
                        type="button"
                        className="t-chip"
                        style={exchangeVar(exchange)}
                        aria-pressed={on}
                        disabled={on && active.length <= 2}
                        title={on && active.length <= 2 ? "Keep at least two exchanges on" : undefined}
                        onClick={() => toggleExchange(exchange)}
                      >
                        {EXCHANGE_SHORT[exchange] ?? exchange}
                      </button>
                    );
                  })}
                </div>
                {isPhone || captureMode ? (
                  <select className="t-select" value={sort} onChange={(event) => setSort(event.target.value as SortKey)} aria-label="Sort">
                    <option value="net">{captureMode ? "Best net per capture" : "Best net"}</option>
                    <option value="next">{captureMode ? "Settling soonest" : "Paying soonest"}</option>
                    <option value="spread">{captureMode ? "Biggest payment" : "Widest spread"}</option>
                    <option value="trust">Most trusted data</option>
                    {captureMode ? <option value="breakeven">Lowest costs</option> : <option value="breakeven">Fastest break-even</option>}
                    <option value="oi">Largest open interest</option>
                    <option value="coin">Coin A to Z</option>
                  </select>
                ) : null}
                <div className="t-toolbar-end">
                  {captureMode ? null : (
                    <div className="t-segmented" role="group" aria-label="Table detail">
                      <button type="button" aria-pressed={density === "compact"} onClick={() => setDensity("compact")}>
                        Compact
                      </button>
                      <button type="button" aria-pressed={density === "detailed"} onClick={() => setDensity("detailed")} title="Adds each leg's rate and timer, open interest, price gap and max leverage">
                        Detailed
                      </button>
                    </div>
                  )}
                  <button type="button" className="t-text-btn" style={{ height: 32 }} onClick={() => downloadCsv(rows)}>
                    Export CSV
                  </button>
                  <button type="button" className="t-text-btn" style={{ height: 32 }} onClick={() => setPaused(!paused)} aria-pressed={paused}>
                    {paused ? "Resume" : "Pause"}
                  </button>
                  <button type="button" className="t-text-btn" style={{ height: 32 }} onClick={() => void refresh()}>
                    Refresh
                  </button>
                </div>
              </div>

              {!data ? (
                <div className="t-table" aria-busy="true">
                  {Array.from({ length: 8 }, (_, index) => (
                    <div key={index} className="t-skel" />
                  ))}
                </div>
              ) : !rows.length ? (
                <Empty
                  title={search ? `No pairs match "${search}"` : "No pairs in this view"}
                  body={search ? "Try the coin's ticker, like BTC or SOL." : "Switch the view to All, or turn on more exchanges."}
                />
              ) : captureMode ? (
                isPhone ? (
                  <CaptureCards rows={rows as CaptureRow[]} onSelect={open} notional={notional} exchangesQuery={exchangesQuery} />
                ) : (
                  <>
                    <p className="t-footnote">
                      Each row is the best way to catch that coin's next settlement: in just before, out right after. Costs are taker fees in and out plus slippage at $
                      {notional.toLocaleString()} per leg.
                    </p>
                    <CaptureTable rows={rows as CaptureRow[]} selected={selected} onSelect={open} notional={notional} exchangesQuery={exchangesQuery} />
                  </>
                )
              ) : isPhone ? (
                <PairCards rows={rows} scale={scale} selected={selected} onSelect={open} horizonLabel={horizonLabel} exchangesQuery={exchangesQuery} sparks={sparks} />
              ) : (
                <>
                  <p className="t-footnote">
                    Costs assume ${(data?.reference_notional_usd ?? 1000).toLocaleString()} per leg held for {horizonLabel}. Click a row for details, or use Compare and Trade on the right.
                  </p>
                  <PairTable
                    rows={rows}
                    scale={scale}
                    selected={selected}
                    onSelect={open}
                    horizonLabel={horizonLabel}
                    exchangesQuery={exchangesQuery}
                    sort={sort}
                    onSort={setSort}
                    density={isWide && selectedRow ? "compact" : density}
                    sparks={sparks}
                  />
                </>
              )}
            </>
          ) : null}

          {tab === "leaders" ? <LeadersView leaders={data?.leaders ?? []} onOpen={open} loading={!data} /> : null}
          {tab === "heatmap" ? (
            data ? <HeatmapView rates={data.rates ?? {}} exchanges={active} onOpen={open} /> : <SkeletonRows count={10} height={40} label="Loading heatmap" />
          ) : null}
          {tab === "calendar" ? (
            data ? <CalendarView rates={data.rates ?? {}} exchanges={active} opportunities={opportunities} onOpen={open} /> : <SkeletonRows count={6} height={48} label="Loading calendar" />
          ) : null}
          {tab === "trends" ? <TrendsView opportunities={opportunities} leaders={data?.leaders ?? []} exchanges={active} onOpen={open} /> : null}
          {tab === "settlements" ? <SettlementsView items={data?.settlements ?? []} onOpen={open} loading={!data} /> : null}
          {tab === "health" ? <HealthView statuses={data?.statuses ?? []} link={link} receivedAt={receivedAt} loading={!data} /> : null}
          {tab === "alerts" ? <AlertsView alerts={alerts} horizonLabel={horizonLabel} onOpen={open} /> : null}
          </div>
        </main>

        {detail && isWide ? <aside className="t-detail" aria-label={`${selectedRow?.base_asset} details`}>{detail}</aside> : null}
      </div>

      {detail && !isWide ? <DetailSheet onClose={close}>{detail}</DetailSheet> : null}

      {selected && data && !selectedRow ? (
        <div className="t-sheet-scrim" onClick={close}>
          <div className="t-empty" style={{ marginTop: "30vh", color: "var(--t-text)" }}>
            <strong>{selected.split("-")[0]} has no live pair right now</strong>
            Its spread may have closed, or one exchange is out of scope.
          </div>
        </div>
      ) : null}

    </AppChrome>
  );
}
