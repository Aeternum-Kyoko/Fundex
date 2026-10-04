import { useEffect, useMemo, useState } from "react";
import { formatPrice } from "../lib/monitor";
import { DepthBlock, SettledBlock } from "./insights";
import { Countdown, exchangeVar } from "./primitives";
import "./design.css";

const API_BASE = import.meta.env.VITE_API_URL ?? "/api";

interface Spread {
  min: number;
  median: number;
  max: number;
}

interface Summary {
  exchange: string;
  display_name: string;
  region: string | null;
  market: string | null;
  healthy: boolean;
  enabled: boolean;
  configured: boolean;
  last_success_at: string | null;
  last_error: string | null;
  coins: number;
  shared_coins: number;
  interval_mix: Record<string, number>;
  next_settlement_at: string | null;
  data_age_seconds: number | null;
  fees: { taker_bps: Spread | null; maker_bps: Spread | null; source: string; published: string | null };
  funding: {
    positive_share: number | null;
    median_apr_percent: number | null;
    highest: Array<{ coin: string; apr_percent: number }>;
    lowest: Array<{ coin: string; apr_percent: number }>;
  };
  open_interest_usd: number | null;
  volume_24h_usd: number | null;
  max_leverage: Spread | null;
  live_trading: string | null;
  funding_schedule: string | null;
  rate_feed: string | null;
  history: string | null;
  links: { website?: string; fee_page?: string; api_docs?: string };
}

interface CoinRow {
  canonical_symbol: string;
  coin: string;
  exchange_symbol: string;
  funding_rate: number;
  interval_hours: number;
  apr_percent: number;
  next_funding_time: string | null;
  mark_price: number | null;
  index_price: number | null;
  premium_percent: number | null;
  open_interest_usd: number | null;
  volume_24h_usd: number | null;
  max_leverage: number | null;
  maker_fee_bps: number;
  taker_fee_bps: number;
  listed_on: number;
  rank: number;
  best_pair: { role: string; other: string; spread_apr: number } | null;
  trade_url: string;
  fetched_at: string;
}

interface Detail extends Summary {
  coin_rows: CoinRow[];
}

interface CoinDetail extends CoinRow {
  exchange: string;
  display_name: string;
  specs: Array<{ label: string; value: string }>;
  feed: Record<string, string | number | boolean>;
  venues: Array<CoinRow & { exchange: string; display_name: string }>;
}

function useJson<T>(path: string, refreshMs = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(`${API_BASE}${path}`);
        const payload = await response.json();
        if (cancelled) return;
        if (!response.ok) setError(typeof payload.detail === "string" ? payload.detail : "Couldn't load this page.");
        else {
          setData(payload as T);
          setError(null);
        }
      } catch {
        if (!cancelled) setError("Can't reach the server.");
      }
    };
    void load();
    const timer = refreshMs ? window.setInterval(() => void load(), refreshMs) : null;
    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
    };
  }, [path, refreshMs]);
  return { data, error };
}

function compactUsd(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value) || value === 0) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function bps(value: number | null | undefined) {
  return value == null ? "—" : `${(value / 100).toFixed(value % 1 ? 4 : 3).replace(/0+$/, "").replace(/\.$/, "")}%`;
}

function feeRange(spread: Spread | null) {
  if (!spread) return "—";
  return spread.min === spread.max ? bps(spread.median) : `${bps(spread.min)} to ${bps(spread.max)}`;
}

function apr(value: number | null | undefined, digits = 1) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(digits)}%`;
}

function rate(value: number) {
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value * 100).toFixed(4)}%`;
}

function tone(value: number | null | undefined) {
  return value == null ? "" : value > 0 ? "t-receive" : value < 0 ? "t-pay" : "t-soft";
}

function age(seconds: number | null) {
  if (seconds == null) return "—";
  return seconds < 90 ? `${Math.round(seconds)}s` : `${Math.round(seconds / 60)} min`;
}

function exchangeName(id: string) {
  return { binance: "Binance", delta: "Delta", coindcx: "CoinDCX", wazirx: "WazirX", coinswitch: "CoinSwitch" }[id] ?? id;
}

function Health({ summary }: { summary: Summary }) {
  const state = !summary.configured ? "off" : summary.healthy ? "ok" : "down";
  const label = state === "off" ? "Not connected" : state === "ok" ? "Live" : "Feed down";
  return (
    <span className="xc-health" data-state={state}>
      <i aria-hidden="true" />
      {label}
    </span>
  );
}

/* ---------- All exchanges ---------- */

function Overview() {
  const { data, error } = useJson<{ exchanges: Summary[] }>("/exchanges", 30_000);
  const rows = data?.exchanges ?? [];
  return (
    <main className="t-main td-page">
      <header className="td-head">
        <div>
          <a className="td-back" href="/">Dashboard</a>
          <h1 className="td-title">Exchanges</h1>
          <p className="t-soft td-sub">
            Every venue Fundex watches: what it charges (and where that number comes from), how it pays funding, how deep it is, and every coin it lists.
          </p>
        </div>
      </header>
      {error ? <div className="t-banner" role="alert">{error}</div> : null}
      {!data && !error ? <div className="t-skel" style={{ height: 240, borderRadius: 14 }} aria-busy="true" /> : null}

      <div className="xc-cards">
        {rows.map((summary) => (
          <a key={summary.exchange} className="t-panel xc-card" href={`/exchanges/${summary.exchange}`}>
            <div className="xc-card-head">
              <span className="xc-name">
                <i className="xc-dot" style={exchangeVar(summary.exchange)} aria-hidden="true" />
                <strong>{summary.display_name}</strong>
              </span>
              <Health summary={summary} />
            </div>
            <p className="t-muted xc-card-sub">
              {summary.region} · {summary.market}
            </p>
            <dl className="xc-facts">
              <div>
                <dt>Coins</dt>
                <dd className="t-num">
                  {summary.coins} <small className="t-muted">{summary.shared_coins} shared</small>
                </dd>
              </div>
              <div>
                <dt>Taker fee</dt>
                <dd className="t-num">
                  {bps(summary.fees.taker_bps?.median)} <small className="t-muted">maker {bps(summary.fees.maker_bps?.median)}</small>
                </dd>
              </div>
              <div>
                <dt>Median funding</dt>
                <dd className={`t-num ${tone(summary.funding.median_apr_percent)}`}>
                  {summary.funding.median_apr_percent == null ? "—" : `${apr(summary.funding.median_apr_percent)} a year`}
                </dd>
              </div>
              <div>
                <dt>Open interest</dt>
                <dd className="t-num">{compactUsd(summary.open_interest_usd)}</dd>
              </div>
              <div>
                <dt>24h volume</dt>
                <dd className="t-num">{compactUsd(summary.volume_24h_usd)}</dd>
              </div>
              <div>
                <dt>Settles every</dt>
                <dd className="t-num">{Object.keys(summary.interval_mix).join(", ") || "—"}</dd>
              </div>
            </dl>
            <p className="t-muted xc-card-foot">Fees: {summary.fees.source}</p>
          </a>
        ))}
      </div>

      {rows.length ? (
        <section className="t-panel td-section" style={{ marginTop: 16 }}>
          <h3>Side by side</h3>
          <div className="sl-table-wrap">
            <table className="sl-table xc-table">
              <thead>
                <tr>
                  <th>Exchange</th>
                  <th>Status</th>
                  <th>Coins</th>
                  <th>Taker fee</th>
                  <th>Maker fee</th>
                  <th>Max leverage</th>
                  <th>Paying longs</th>
                  <th>Open interest</th>
                  <th>24h volume</th>
                  <th>Data age</th>
                  <th>Live trading</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((summary) => (
                  <tr key={summary.exchange} className="xc-link-row" onClick={() => window.location.assign(`/exchanges/${summary.exchange}`)}>
                    <td>
                      <a href={`/exchanges/${summary.exchange}`}>{summary.display_name}</a>
                    </td>
                    <td>
                      <Health summary={summary} />
                    </td>
                    <td className="t-num">{summary.coins}</td>
                    <td className="t-num">{feeRange(summary.fees.taker_bps)}</td>
                    <td className="t-num">{feeRange(summary.fees.maker_bps)}</td>
                    <td className="t-num">{summary.max_leverage ? `${summary.max_leverage.max}x` : "—"}</td>
                    <td className="t-num">
                      {summary.funding.positive_share == null ? "—" : `${Math.round(summary.funding.positive_share * 100)}% of coins`}
                    </td>
                    <td className="t-num">{compactUsd(summary.open_interest_usd)}</td>
                    <td className="t-num">{compactUsd(summary.volume_24h_usd)}</td>
                    <td className="t-num">{age(summary.data_age_seconds)}</td>
                    <td className="t-muted">{summary.live_trading?.split(":")[0] ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="t-muted sl-note" style={{ margin: "10px 0 0" }}>
            "Paying longs" is the share of coins where longs pay shorts right now (positive funding).
          </p>
        </section>
      ) : null}
    </main>
  );
}

/* ---------- One exchange ---------- */

type SortKey = "abs_apr" | "apr" | "oi" | "volume" | "coin" | "next";

const SORTS: Array<{ key: SortKey; label: string }> = [
  { key: "abs_apr", label: "Biggest funding" },
  { key: "apr", label: "Highest" },
  { key: "oi", label: "Open interest" },
  { key: "volume", label: "Volume" },
  { key: "next", label: "Settles soonest" },
  { key: "coin", label: "A to Z" },
];

function sortRows(rows: CoinRow[], key: SortKey) {
  const copy = [...rows];
  const by = (value: (row: CoinRow) => number) => copy.sort((a, b) => value(b) - value(a));
  if (key === "abs_apr") return by((row) => Math.abs(row.apr_percent));
  if (key === "apr") return by((row) => row.apr_percent);
  if (key === "oi") return by((row) => row.open_interest_usd ?? -1);
  if (key === "volume") return by((row) => row.volume_24h_usd ?? -1);
  if (key === "next") return copy.sort((a, b) => (a.next_funding_time ?? "9").localeCompare(b.next_funding_time ?? "9"));
  return copy.sort((a, b) => a.coin.localeCompare(b.coin));
}

function ExchangeView({ exchange }: { exchange: string }) {
  const { data, error } = useJson<Detail>(`/exchanges/${encodeURIComponent(exchange)}`, 30_000);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("abs_apr");
  const [intervalFilter, setIntervalFilter] = useState<string>("all");
  const [limit, setLimit] = useState(60);

  const rows = useMemo(() => {
    if (!data) return [];
    const needle = query.trim().toUpperCase();
    const filtered = data.coin_rows.filter(
      (row) => (!needle || row.coin.includes(needle) || row.exchange_symbol.toUpperCase().includes(needle)) && (intervalFilter === "all" || `${row.interval_hours}h` === intervalFilter),
    );
    return sortRows(filtered, sort);
  }, [data, query, sort, intervalFilter]);

  if (error) return <main className="t-main td-page"><div className="t-banner" role="alert">{error}</div></main>;
  if (!data) return <main className="t-main td-page"><div className="t-skel" style={{ height: 320, borderRadius: 14 }} aria-busy="true" /></main>;

  return (
    <main className="t-main td-page">
      <header className="td-head">
        <div>
          <a className="td-back" href="/exchanges">Exchanges</a>
          <h1 className="td-title">
            {data.display_name} <Health summary={data} />
          </h1>
          <p className="t-soft td-sub">
            {data.region} · {data.market}
          </p>
        </div>
        <div className="td-switches xc-links">
          {data.links.website ? (
            <a className="t-btn" href={data.links.website} target="_blank" rel="noreferrer">
              Open {data.display_name}
            </a>
          ) : null}
          {data.links.fee_page ? (
            <a className="t-btn" href={data.links.fee_page} target="_blank" rel="noreferrer">
              Fee schedule
            </a>
          ) : null}
          {data.links.api_docs ? (
            <a className="t-btn" href={data.links.api_docs} target="_blank" rel="noreferrer">
              API docs
            </a>
          ) : null}
        </div>
      </header>

      {data.last_error && !data.healthy ? <div className="t-banner" role="alert">Feed problem: {data.last_error}</div> : null}

      <section className="t-perf-kpis" aria-label="Exchange at a glance">
        <div className="t-perf-lead">
          <span className="t-soft">Fees per fill</span>
          <strong className="t-num">
            {bps(data.fees.taker_bps?.median)} <small className="t-muted">taker</small>
          </strong>
          <span className="t-soft t-num">{bps(data.fees.maker_bps?.median)} maker</span>
          <small className="t-muted xc-source">Source: {data.fees.source}</small>
        </div>
        <div className="t-perf-kpi">
          <span>Coins listed</span>
          <b className="t-num">{data.coins}</b>
          <small className="t-muted">{data.shared_coins} also on another exchange</small>
        </div>
        <div className="t-perf-kpi">
          <span>Median funding</span>
          <b className={`t-num ${tone(data.funding.median_apr_percent)}`}>{apr(data.funding.median_apr_percent)}</b>
          <small className="t-muted">a year; longs pay on {data.funding.positive_share == null ? "—" : `${Math.round(data.funding.positive_share * 100)}%`}</small>
        </div>
        <div className="t-perf-kpi">
          <span>Open interest</span>
          <b className="t-num">{compactUsd(data.open_interest_usd)}</b>
          <small className="t-muted">24h volume {compactUsd(data.volume_24h_usd)}</small>
        </div>
        <div className="t-perf-kpi">
          <span>Next settlement</span>
          <b className="t-num">
            <Countdown target={data.next_settlement_at} />
          </b>
          <small className="t-muted">{Object.entries(data.interval_mix).map(([key, count]) => `${count} every ${key}`).join(", ")}</small>
        </div>
        <div className="t-perf-kpi">
          <span>Max leverage</span>
          <b className="t-num">{data.max_leverage ? `${data.max_leverage.max}x` : "—"}</b>
          <small className="t-muted">{data.max_leverage ? `median ${data.max_leverage.median}x` : "not published"}</small>
        </div>
        <div className="t-perf-kpi">
          <span>Data age</span>
          <b className="t-num">{age(data.data_age_seconds)}</b>
          <small className="t-muted">median across coins</small>
        </div>
      </section>

      <div className="xc-three">
        <section className="t-panel">
          <h3>How it works here</h3>
          <ul className="t-list xc-about">
            <li>
              <span className="t-muted">Funding</span>
              <span>{data.funding_schedule}</span>
            </li>
            <li>
              <span className="t-muted">Rate feed</span>
              <span>{data.rate_feed}</span>
            </li>
            <li>
              <span className="t-muted">History</span>
              <span>{data.history}</span>
            </li>
            <li>
              <span className="t-muted">Fees</span>
              <span>{data.fees.published}</span>
            </li>
            <li>
              <span className="t-muted">Trading from Fundex</span>
              <span>{data.live_trading}</span>
            </li>
          </ul>
        </section>
        <section className="t-panel">
          <h3>Longs pay the most</h3>
          <ul className="t-list">
            {data.funding.highest.map((item) => (
              <li key={item.coin}>
                <span>{item.coin}</span>
                <span className={`t-num ${tone(item.apr_percent)}`}>{apr(item.apr_percent)}</span>
              </li>
            ))}
          </ul>
        </section>
        <section className="t-panel">
          <h3>Shorts pay the most</h3>
          <ul className="t-list">
            {data.funding.lowest.map((item) => (
              <li key={item.coin}>
                <span>{item.coin}</span>
                <span className={`t-num ${tone(item.apr_percent)}`}>{apr(item.apr_percent)}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="t-panel td-section" style={{ marginTop: 16 }}>
        <h3>
          Every coin on {data.display_name}
          <span className="t-muted xc-count">{rows.length} shown</span>
        </h3>
        <div className="xc-tools">
          <input className="xc-search" type="search" placeholder="Find a coin" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Find a coin" />
          <div className="t-segmented" role="group" aria-label="Sort">
            {SORTS.map((item) => (
              <button key={item.key} type="button" aria-pressed={sort === item.key} onClick={() => setSort(item.key)}>
                {item.label}
              </button>
            ))}
          </div>
          {Object.keys(data.interval_mix).length > 1 ? (
            <div className="t-segmented" role="group" aria-label="Settlement interval">
              {["all", ...Object.keys(data.interval_mix)].map((key) => (
                <button key={key} type="button" aria-pressed={intervalFilter === key} onClick={() => setIntervalFilter(key)}>
                  {key === "all" ? "Any interval" : key}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <div className="sl-table-wrap">
          <table className="sl-table xc-table">
            <thead>
              <tr>
                <th>Coin</th>
                <th>Rate</th>
                <th>Every</th>
                <th>A year</th>
                <th>Next</th>
                <th>Mark</th>
                <th>Premium</th>
                <th>Open interest</th>
                <th>24h volume</th>
                <th>Max lev.</th>
                <th>Taker / maker</th>
                <th>Rank</th>
                <th>Best pairing</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, limit).map((row) => (
                <tr key={row.canonical_symbol} className="xc-link-row" onClick={() => window.location.assign(`/exchanges/${exchange}/${encodeURIComponent(row.canonical_symbol)}`)}>
                  <td>
                    <a href={`/exchanges/${exchange}/${encodeURIComponent(row.canonical_symbol)}`}>
                      <strong>{row.coin}</strong>
                    </a>
                  </td>
                  <td className={`t-num ${tone(row.funding_rate)}`}>{rate(row.funding_rate)}</td>
                  <td className="t-num">{row.interval_hours}h</td>
                  <td className={`t-num ${tone(row.apr_percent)}`}>{apr(row.apr_percent, 0)}</td>
                  <td className="t-num">
                    <Countdown target={row.next_funding_time} />
                  </td>
                  <td className="t-num">{formatPrice(row.mark_price)}</td>
                  <td className="t-num">{row.premium_percent == null ? "—" : apr(row.premium_percent, 2)}</td>
                  <td className="t-num">{compactUsd(row.open_interest_usd)}</td>
                  <td className="t-num">{compactUsd(row.volume_24h_usd)}</td>
                  <td className="t-num">{row.max_leverage ? `${row.max_leverage}x` : "—"}</td>
                  <td className="t-num">
                    {bps(row.taker_fee_bps)} / {bps(row.maker_fee_bps)}
                  </td>
                  <td className="t-num" title="1 = the highest funding of the exchanges listing this coin">
                    {row.listed_on > 1 ? `${row.rank} of ${row.listed_on}` : "only here"}
                  </td>
                  <td className="t-muted">
                    {row.best_pair ? (
                      <>
                        {row.best_pair.role} vs {exchangeName(row.best_pair.other)} <span className="t-num t-receive">{apr(row.best_pair.spread_apr, 0)}</span>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length > limit ? (
          <button type="button" className="t-btn xc-more" onClick={() => setLimit(limit + 100)}>
            Show more ({rows.length - limit} left)
          </button>
        ) : null}
      </section>
    </main>
  );
}

/* ---------- One coin on one exchange ---------- */

function CoinView({ exchange, symbol }: { exchange: string; symbol: string }) {
  const { data, error } = useJson<CoinDetail>(`/exchanges/${encodeURIComponent(exchange)}/coins/${encodeURIComponent(symbol)}`, 30_000);
  if (error) return <main className="t-main td-page"><a className="td-back" href={`/exchanges/${exchange}`}>{exchangeName(exchange)}</a><div className="t-banner" role="alert">{error}</div></main>;
  if (!data) return <main className="t-main td-page"><div className="t-skel" style={{ height: 320, borderRadius: 14 }} aria-busy="true" /></main>;

  const feed = Object.entries(data.feed).filter(([key]) => !["source", "exchange_time", "feed_timestamp_ms"].includes(key));
  return (
    <main className="t-main td-page">
      <header className="td-head">
        <div>
          <a className="td-back" href={`/exchanges/${exchange}`}>{data.display_name}</a>
          <h1 className="td-title">
            {data.coin} <span className="t-muted xc-title-sub">on {data.display_name}</span>
          </h1>
          <p className="t-soft td-sub">
            {data.exchange_symbol} · settles every {data.interval_hours}h · {data.listed_on > 1 ? `listed on ${data.listed_on} exchanges Fundex watches` : "only listed here"}
          </p>
        </div>
        <div className="td-switches xc-links">
          <a className="t-btn" data-primary="true" href={data.trade_url} target="_blank" rel="noreferrer">
            Open on {data.display_name}
          </a>
          <a className="t-btn" href={`/compare/${encodeURIComponent(data.canonical_symbol)}`}>
            Compare exchanges
          </a>
          <a className="t-btn" href={`/trade/${encodeURIComponent(data.canonical_symbol)}`}>
            Trade
          </a>
        </div>
      </header>

      <section className="t-perf-kpis" aria-label="Coin at a glance">
        <div className="t-perf-lead">
          <span className="t-soft">Funding this settlement</span>
          <strong className={`t-num ${tone(data.funding_rate)}`}>{rate(data.funding_rate)}</strong>
          <span className="t-soft t-num">
            {apr(data.apr_percent)} a year · {data.funding_rate > 0 ? "longs pay shorts" : data.funding_rate < 0 ? "shorts pay longs" : "flat"}
          </span>
        </div>
        <div className="t-perf-kpi">
          <span>Next settlement</span>
          <b className="t-num">
            <Countdown target={data.next_funding_time} />
          </b>
          <small className="t-muted">{data.next_funding_time ? new Date(data.next_funding_time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}</small>
        </div>
        <div className="t-perf-kpi">
          <span>Mark / index</span>
          <b className="t-num">{formatPrice(data.mark_price)}</b>
          <small className="t-muted">
            index {formatPrice(data.index_price)}
            {data.premium_percent != null ? `, premium ${apr(data.premium_percent, 3)}` : ""}
          </small>
        </div>
        <div className="t-perf-kpi">
          <span>Open interest</span>
          <b className="t-num">{compactUsd(data.open_interest_usd)}</b>
          <small className="t-muted">24h volume {compactUsd(data.volume_24h_usd)}</small>
        </div>
        <div className="t-perf-kpi">
          <span>Fees per fill</span>
          <b className="t-num">{bps(data.taker_fee_bps)}</b>
          <small className="t-muted">taker; maker {bps(data.maker_fee_bps)}</small>
        </div>
        <div className="t-perf-kpi">
          <span>Max leverage</span>
          <b className="t-num">{data.max_leverage ? `${data.max_leverage}x` : "—"}</b>
        </div>
      </section>

      <div className="sl-bottom">
        <section className="t-panel">
          <h3>Contract specs from {data.display_name}</h3>
          {data.specs.length ? (
            <ul className="t-list">
              {data.specs.map((item) => (
                <li key={item.label}>
                  <span className="t-muted">{item.label}</span>
                  <span className="t-num">{item.value}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="t-muted">{data.display_name} didn't return contract specs for this coin just now.</p>
          )}
        </section>
        <section className="t-panel">
          <h3>Same coin on every exchange</h3>
          <div className="sl-table-wrap">
            <table className="sl-table">
              <thead>
                <tr>
                  <th>Exchange</th>
                  <th>Rate</th>
                  <th>Every</th>
                  <th>A year</th>
                  <th>Taker</th>
                  <th>Open interest</th>
                </tr>
              </thead>
              <tbody>
                {data.venues.map((venue) => (
                  <tr key={venue.exchange} data-current={venue.exchange === exchange || undefined}>
                    <td>
                      <a href={`/exchanges/${venue.exchange}/${encodeURIComponent(data.canonical_symbol)}`}>{venue.display_name}</a>
                    </td>
                    <td className={`t-num ${tone(venue.funding_rate)}`}>{rate(venue.funding_rate)}</td>
                    <td className="t-num">{venue.interval_hours}h</td>
                    <td className={`t-num ${tone(venue.apr_percent)}`}>{apr(venue.apr_percent, 0)}</td>
                    <td className="t-num">{bps(venue.taker_fee_bps)}</td>
                    <td className="t-num">{compactUsd(venue.open_interest_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.best_pair ? (
            <p className="t-muted sl-note" style={{ margin: "10px 0 0" }}>
              Best pairing right now: <strong>{data.best_pair.role}</strong> against {exchangeName(data.best_pair.other)}, a spread of{" "}
              <span className="t-num t-receive">{apr(data.best_pair.spread_apr)}</span> a year before costs.
            </p>
          ) : null}
        </section>
      </div>

      <section className="t-panel td-section" style={{ marginTop: 16 }}>
        <h3>Order-book depth</h3>
        <DepthBlock symbol={data.canonical_symbol} longExchange={exchange} shortExchange={data.best_pair?.other ?? exchange} />
      </section>

      <section className="t-panel td-section" style={{ marginTop: 16 }}>
        <h3>Predicted vs settled funding</h3>
        <SettledBlock symbol={data.canonical_symbol} />
      </section>

      {feed.length ? (
        <section className="t-panel td-section" style={{ marginTop: 16 }}>
          <h3>Raw feed fields</h3>
          <ul className="t-list xc-feed">
            {feed.map(([key, value]) => (
              <li key={key}>
                <span className="t-muted">{key.replace(/_/g, " ")}</span>
                <span className="t-num">{String(value)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}

export function Exchanges({ exchange, coin }: { exchange?: string; coin?: string }) {
  if (exchange && coin) return <CoinView exchange={exchange} symbol={coin} />;
  if (exchange) return <ExchangeView exchange={exchange} />;
  return <Overview />;
}
