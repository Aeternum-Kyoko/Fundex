import { useMemo, useState } from "react";
import { useCurrencyRates } from "../hooks/useCurrencyRates";
import { useExecutionPlan } from "../hooks/useExecutionPlan";
import { useSymbolComparison } from "../hooks/useSymbolComparison";
import { formatLeverage, formatPrice, formatUsd, getExchangeTrustBadge } from "../lib/monitor";
import type { SymbolComparisonExchangeSnapshot } from "../lib/types";
import { CaptureBlock, type CaptureRow, dollars, whoPays } from "./capture";
import { tradeHref } from "./pairs";
import { TrendBlock } from "./trends";
import { Countdown, EXCHANGE_SHORT, hoursLabel, Icon, pct, TrustBadge } from "./primitives";
import "./design.css";

function hourly(row: SymbolComparisonExchangeSnapshot) {
  return row.funding_rate / Math.max(row.funding_interval_hours || 8, 1);
}

// Exchanges at (almost) the same rate share one label instead of printing on top of each other.
function groupLabels(rows: SymbolComparisonExchangeSnapshot[], x: (rate: number) => number) {
  const groups: Array<{ at: number; names: string }> = [];
  for (const row of [...rows].sort((a, b) => x(hourly(a)) - x(hourly(b)))) {
    const at = x(hourly(row));
    const last = groups[groups.length - 1];
    if (last && Math.abs(last.at - at) < 7) last.names += `, ${EXCHANGE_SHORT[row.exchange]}`;
    else groups.push({ at, names: EXCHANGE_SHORT[row.exchange] ?? row.exchange });
  }
  return groups;
}

/** Every exchange for one coin on a single per-hour axis: the widest gap is the hold edge. */
function ExchangeAxis({ rows }: { rows: SymbolComparisonExchangeSnapshot[] }) {
  const max = Math.max(...rows.map((row) => Math.abs(hourly(row))), 1e-7);
  const x = (rate: number) => 50 + Math.sign(rate) * Math.sqrt(Math.abs(rate) / max) * 46;
  return (
    <div className="cp-axis">
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="cp-axis-svg" aria-hidden="true">
        <line x1="0" x2="100" y1="20" y2="20" stroke="var(--t-line-strong)" vectorEffect="non-scaling-stroke" />
        <line x1="50" x2="50" y1="12" y2="28" stroke="var(--t-line-strong)" vectorEffect="non-scaling-stroke" />
        {rows.map((row) => (
          <line
            key={row.exchange}
            x1={x(hourly(row))}
            x2={x(hourly(row))}
            y1="20"
            y2="20.01"
            stroke={`var(--x-${row.exchange})`}
            strokeWidth="13"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      <div className="cp-axis-labels">
        {groupLabels(rows, x).map((group) => (
          <span key={group.names} style={{ left: `${group.at}%` }}>
            {group.names}
          </span>
        ))}
      </div>
      <div className="t-timeline-scale">
        <span>Longs get paid</span>
        <span>0</span>
        <span>Shorts get paid</span>
      </div>
    </div>
  );
}

export function ComparePage({ canonicalSymbol }: { canonicalSymbol: string }) {
  const selectedExchanges = useMemo(() => {
    const exchanges = new URLSearchParams(window.location.search).get("exchanges");
    return exchanges ? exchanges.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean) : [];
  }, []);
  const exchangesQuery = selectedExchanges.length ? `?exchanges=${encodeURIComponent(selectedExchanges.join(","))}` : "";
  const { comparison, loading, error } = useSymbolComparison(canonicalSymbol, selectedExchanges, "hold");
  const { rates } = useCurrencyRates();
  const [capitalInput, setCapitalInput] = useState("1000");
  const [currency, setCurrency] = useState("USD");
  const [planStrategy, setPlanStrategy] = useState<"capture" | "hold">("capture");
  const capitalUsd = Number(capitalInput) > 0 ? Number(capitalInput) : 1000;
  const hold = comparison?.best_opportunity ?? null;
  const capture = hold?.capture ? (hold as CaptureRow) : null;
  const notional = hold?.reference_notional_usd ?? 1000;

  const { plan, loading: planLoading } = useExecutionPlan(hold?.canonical_symbol ?? null, Boolean(hold), selectedExchanges, {
    capitalUsd,
    leverage: 2,
    holdingPeriods: 1,
    strategy: planStrategy,
  });
  const { plan: reversePlan } = useExecutionPlan(hold?.canonical_symbol ?? null, Boolean(hold), selectedExchanges, {
    capitalUsd,
    leverage: 2,
    holdingPeriods: 1,
    reverse: true,
    strategy: planStrategy,
  });

  const rows = useMemo(() => [...(comparison?.exchanges ?? [])].sort((a, b) => hourly(b) - hourly(a)), [comparison]);
  const rate = currency === "USD" ? 1 : rates[currency] ?? 1;
  const local = (usd: number | null | undefined) => {
    if (usd == null || !Number.isFinite(usd)) return "—";
    const value = usd * rate;
    const sign = value < 0 ? "−" : "";
    return currency === "USD" ? `${sign}$${Math.abs(value).toFixed(2)}` : `${sign}${Math.abs(value).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${currency}`;
  };
  const base = (comparison?.canonical_symbol ?? canonicalSymbol).split("-")[0];

  return (
    <main className="t-main td-page">
      <header className="td-head">
        <div>
          <a className="td-back" href="/">Dashboard</a>
          <h1 className="td-title">{base} across exchanges</h1>
          <p className="t-soft td-sub">
            {comparison
              ? `${comparison.total_exchanges} exchanges list ${base}. Each rate is what longs pay shorts at that exchange's next settlement.`
              : loading
                ? "Loading every exchange…"
                : "This coin is not in the live set right now."}
          </p>
        </div>
        <div className="td-switches">
          <a className="t-btn" data-primary="true" href={tradeHref(canonicalSymbol, exchangesQuery)}>
            Trade {base}
          </a>
        </div>
      </header>

      {error ? <div className="t-banner" role="alert">{error}</div> : null}

      {hold ? (
        <div className="cp-setups">
          <section className="t-panel">
            <h3>
              Next settlement
              {capture ? <TrustBadge level={capture.capture.data_trust_level} compact /> : null}
            </h3>
            {capture ? (
              <CaptureBlock row={capture} notional={notional} exchangesQuery={exchangesQuery} />
            ) : (
              <p className="t-muted">No exchange pair settles together in a way that pays right now.</p>
            )}
          </section>
          <section className="t-panel">
            <h3>
              Hold the hedge
              <TrustBadge level={hold.trust_level} compact />
            </h3>
            <p className="t-detail-sentence" style={{ marginTop: 4 }}>
              Buy on <strong>{hold.long_leg.display_name}</strong>, sell on <strong>{hold.short_leg.display_name}</strong> and keep it on. Spread{" "}
              <strong className="t-num">{pct(hold.spread_rate * 100, 4)}</strong> per 8h after normalising intervals.
            </p>
            <dl className="t-kv">
              <div><dt>Funding over {hold.holding_horizon_hours / 24} days</dt><dd className="t-num t-receive">{pct(hold.expected_funding_percent, 3, true)}</dd></div>
              <div><dt>Costs, paid once</dt><dd className="t-num t-pay">{pct(-hold.estimated_total_cost_percent, 3, true)}</dd></div>
              <div><dt>Break-even</dt><dd className="t-num">{hoursLabel(hold.break_even_hours)}</dd></div>
              <div data-total="true">
                <dt>Net over {hold.holding_horizon_hours / 24} days</dt>
                <dd className={`t-num ${hold.net_return_percent > 0 ? "t-receive" : "t-pay"}`}>
                  {pct(hold.net_return_percent, 3, true)} ≈ {dollars(hold.net_return_percent, notional)}
                </dd>
              </div>
            </dl>
            <div className="t-actions">
              <a className="t-btn" href={tradeHref(canonicalSymbol, exchangesQuery, "hold")}>
                Trade the hold
              </a>
            </div>
          </section>
        </div>
      ) : null}

      {rows.length ? (
        <section className="t-panel td-section" style={{ marginTop: 16 }}>
          <h3>Where every exchange sits, per hour</h3>
          <ExchangeAxis rows={rows} />
        </section>
      ) : null}

      {rows.length ? (
        <section className="t-panel td-section" style={{ marginTop: 16 }}>
          <h3>Funding rate history</h3>
          <TrendBlock
            symbol={canonicalSymbol}
            exchanges={rows.map((row) => row.exchange)}
            intervals={Object.fromEntries(rows.map((row) => [row.exchange, row.funding_interval_hours]))}
          />
        </section>
      ) : null}

      {rows.length ? (
        <section className="t-panel td-section" style={{ marginTop: 16, padding: 0 }}>
          <h3 style={{ padding: "14px 16px 0" }}>Exchanges</h3>
          <div className="cp-table" role="table">
            <div className="cp-row cp-headrow" role="row">
              <span>Exchange</span>
              <span className="t-right">Rate</span>
              <span className="t-right">Per hour</span>
              <span className="t-right">Settles in</span>
              <span className="t-right">Mark</span>
              <span className="t-right">Open interest</span>
              <span className="t-right">Taker fee</span>
              <span className="t-right">Max lev.</span>
              <span>Feed</span>
            </div>
            {rows.map((row) => {
              const badge = getExchangeTrustBadge(row);
              const inPair = hold && [hold.long_leg.exchange, hold.short_leg.exchange].includes(row.exchange);
              return (
                <a key={row.exchange} role="row" className="cp-row" href={row.trade_url} target="_blank" rel="noreferrer" data-in-pair={inPair}>
                  <span>
                    <strong style={{ color: `var(--x-${row.exchange})` }}>{row.display_name}</strong> <span className="t-muted">{row.exchange_symbol}</span>
                  </span>
                  <span className="t-right t-num">
                    {pct(row.funding_rate * 100, 4, true)} <span className="t-muted">/{row.funding_interval_hours}h</span>
                  </span>
                  <span className="t-right t-num t-soft">{pct(hourly(row) * 100, 5, true)}</span>
                  <span className="t-right"><Countdown target={row.next_funding_time} /></span>
                  <span className="t-right t-num">{formatPrice(row.mark_price)}</span>
                  <span className="t-right t-num">{formatUsd(row.open_interest_usd)}</span>
                  <span className="t-right t-num">{pct(row.taker_fee_bps / 100, 3)}</span>
                  <span className="t-right t-num">{formatLeverage(row.max_leverage)}</span>
                  <span className={badge.tone === "positive" ? "t-receive" : badge.tone === "danger" ? "t-pay" : "t-soft"} title={`Data age ${Math.round(row.data_age_seconds ?? 0)}s`}>
                    {badge.label}
                  </span>
                </a>
              );
            })}
          </div>
        </section>
      ) : null}

      {hold ? (
        <section className="t-panel td-section" style={{ marginTop: 16 }}>
          <h3>
            What your capital does
            <span className="td-switches">
              <span className="t-segmented" role="group" aria-label="Strategy">
                <button type="button" aria-pressed={planStrategy === "capture"} onClick={() => setPlanStrategy("capture")}>Next funding</button>
                <button type="button" aria-pressed={planStrategy === "hold"} onClick={() => setPlanStrategy("hold")}>Hold</button>
              </span>
            </span>
          </h3>
          <div className="td-fields" style={{ marginBottom: 14 }}>
            <label className="t-field">
              Capital (USD)
              <input type="number" min="1" inputMode="decimal" value={capitalInput} onChange={(event) => setCapitalInput(event.target.value)} />
            </label>
            <label className="t-field">
              Show money in
              <select value={currency} onChange={(event) => setCurrency(event.target.value)}>
                {["USD", "INR", ...Object.keys(rates).filter((code) => code !== "USD" && code !== "INR").sort()].map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {plan ? (
            <div className="cp-plans">
              {[
                { label: "Best side", value: plan },
                { label: "Reverse side", value: reversePlan },
              ].map(({ label, value }) =>
                value ? (
                  <div key={label} className="t-leg">
                    <span className="t-leg-side">{label}: buy {value.long_leg.display_name}, sell {value.short_leg.display_name}</span>
                    <strong className={`t-num cp-plan-net ${value.expected_net_pnl_usd >= 0 ? "t-receive" : "t-pay"}`}>{local(value.expected_net_pnl_usd)}</strong>
                    <dl className="t-kv">
                      <div><dt>Funding</dt><dd className="t-num">{local(value.estimated_funding_pnl_usd)}</dd></div>
                      <div><dt>Fees</dt><dd className="t-num">{local(-value.estimated_total_fees_usd)}</dd></div>
                      <div><dt>Slippage</dt><dd className="t-num">{local(-value.estimated_total_slippage_usd)}</dd></div>
                      <div><dt>Size per leg</dt><dd className="t-num">{local(value.notional_usd)}</dd></div>
                      <div><dt>Quantity</dt><dd className="t-num">{value.long_leg.estimated_quantity.toFixed(4)} {base}</dd></div>
                      <div><dt>Margin, both legs</dt><dd className="t-num">{local(value.long_leg.initial_margin_usd + value.short_leg.initial_margin_usd)}</dd></div>
                    </dl>
                  </div>
                ) : null,
              )}
            </div>
          ) : (
            <p className="t-muted">{planLoading ? "Calculating…" : "No plan for this setup right now."}</p>
          )}
          <p className="t-muted" style={{ fontSize: 13, margin: "10px 0 0" }}>
            At 2x leverage with taker fees. {capture ? `${whoPays(capture.capture)} at the next settlement.` : ""}
          </p>
        </section>
      ) : null}

      {hold ? (
        <section className="t-panel td-section" style={{ marginTop: 16 }}>
          <h3>Why this trust level</h3>
          <ul className="t-checks">
            {hold.trust_checks.map((check) => (
              <li key={`${check.key}-${check.detail}`} className="t-check" data-status={check.status}>
                {Icon[check.status]}
                <div>
                  <strong>{check.label}</strong>
                  <span>{check.detail}</span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
