import { useMemo } from "react";
import { FundingTrendChart } from "../components/FundingTrendChart";
import { useExecutionPlan } from "../hooks/useExecutionPlan";
import { useFundingTrends } from "../hooks/useFundingTrends";
import { useSymbolComparison } from "../hooks/useSymbolComparison";
import { formatCountdown, formatPct, formatTimestamp, formatUsd } from "../lib/monitor";

function buildExchangeDiagnostics(exchange: {
  data_age_seconds: number | null;
  next_funding_time: string | null;
  open_interest_usd: number | null;
  mark_price: number | null;
  estimated_funding_rate: number | null;
}) {
  const diagnostics: string[] = [];

  if (exchange.data_age_seconds == null) {
    diagnostics.push("Data age is unavailable.");
  } else if (exchange.data_age_seconds > 45) {
    diagnostics.push("Feed looks stale.");
  } else if (exchange.data_age_seconds > 15) {
    diagnostics.push("Feed timing is slightly delayed.");
  }

  if (exchange.open_interest_usd == null) {
    diagnostics.push("Open interest is missing.");
  }

  if (exchange.mark_price == null) {
    diagnostics.push("Mark price is missing.");
  }

  if (exchange.estimated_funding_rate == null) {
    diagnostics.push("Estimated funding is unavailable.");
  }

  if (!exchange.next_funding_time) {
    diagnostics.push("Next funding time is unavailable.");
  }

  return diagnostics;
}

export function SymbolComparisonPage({ canonicalSymbol }: { canonicalSymbol: string }) {
  const { comparison, loading, error } = useSymbolComparison(canonicalSymbol);
  const exchangeNames = useMemo(
    () => comparison?.exchanges.map((exchange) => exchange.exchange) ?? [],
    [comparison],
  );
  const { series, loading: trendsLoading } = useFundingTrends(
    comparison ? [comparison.canonical_symbol] : [],
    exchangeNames,
    24,
  );

  const bestOpportunity = comparison?.best_opportunity ?? null;
  const { plan, loading: planLoading } = useExecutionPlan(bestOpportunity?.canonical_symbol ?? null, Boolean(bestOpportunity));
  const nowTimestamp = Date.now();
  const pairFundingTime = useMemo(() => {
    if (!bestOpportunity) {
      return null;
    }

    const timestamps = [bestOpportunity.long_leg.next_funding_time, bestOpportunity.short_leg.next_funding_time]
      .filter((value): value is string => Boolean(value))
      .map((value) => new Date(value).getTime())
      .filter((value) => Number.isFinite(value));

    if (!timestamps.length) {
      return null;
    }

    return new Date(Math.min(...timestamps)).toISOString();
  }, [bestOpportunity]);

  return (
    <main className="page compare-page">
      <section className="hero compare-hero">
        <div>
          <p className="eyebrow">Symbol Compare</p>
          <h1>{comparison?.canonical_symbol ?? canonicalSymbol}</h1>
          <p className="lede">
            One symbol across every active exchange, with live funding, mark, fees, next funding timing, confidence, and
            per-exchange funding history in one place.
          </p>
          <div className="compare-top-actions">
            <a href="/" className="action-button secondary-button compare-link">
              Back to dashboard
            </a>
          </div>
        </div>

        <div className="hero-card">
          <span className="chip">Best live pair</span>
          {bestOpportunity ? (
            <>
              <strong>{formatPct(bestOpportunity.spread_rate * 100, 3)}</strong>
              <p>
                Long on {bestOpportunity.long_leg.display_name}, short on {bestOpportunity.short_leg.display_name}, with{" "}
                {(bestOpportunity.confidence_score * 100).toFixed(0)}/100 confidence.
              </p>
            </>
          ) : (
            <>
              <strong>No active pair</strong>
              <p>This symbol is live, but there is no positive cross-exchange funding pair right now.</p>
            </>
          )}
        </div>
      </section>

      {error ? <div className="banner banner-error">{error}</div> : null}

      <section className="summary-grid compare-summary-grid">
        <article className="summary-card">
          <span className="subtle">Live exchanges</span>
          <strong>{comparison?.total_exchanges ?? 0}</strong>
        </article>
        <article className="summary-card">
          <span className="subtle">Best spread</span>
          <strong>{bestOpportunity ? formatPct(bestOpportunity.spread_rate * 100, 3) : "n/a"}</strong>
        </article>
        <article className="summary-card">
          <span className="subtle">Best net APR</span>
          <strong>{bestOpportunity ? formatPct(bestOpportunity.net_apr_percent) : "n/a"}</strong>
        </article>
        <article className="summary-card">
          <span className="subtle">Pair funding</span>
          <strong>{pairFundingTime ? formatCountdown(pairFundingTime, nowTimestamp) : "n/a"}</strong>
        </article>
        <article className="summary-card">
          <span className="subtle">Confidence</span>
          <strong>{bestOpportunity ? `${(bestOpportunity.confidence_score * 100).toFixed(0)}/100` : "n/a"}</strong>
        </article>
      </section>

      {loading && !comparison ? (
        <section className="panel">
          <div className="empty-state">
            <p>Loading symbol comparison...</p>
          </div>
        </section>
      ) : null}

      {comparison ? (
        <>
          <section className="panel compare-panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Exchange View</p>
                <h2>{comparison.total_exchanges} exchanges for {comparison.base_asset}</h2>
                <div className="subtle">
                  Sorted by funding rate from lowest to highest. The main dashboard uses the earliest pair funding time; these cards show each venue's own funding cycle.
                </div>
              </div>
            </div>

            <div className="compare-card-grid">
              {comparison.exchanges.map((exchange) => (
                <article className="overview-card compare-exchange-card" key={`${exchange.exchange}-${exchange.exchange_symbol}`}>
                  <div className="overview-card-header">
                    <div>
                      <p className="eyebrow">Exchange</p>
                      <strong>{exchange.display_name}</strong>
                    </div>
                    <span className={exchange.funding_rate >= 0 ? "phase-pill" : "overview-badge negative-badge"}>
                      {formatPct(exchange.funding_rate * 100, 3)}
                    </span>
                  </div>

                  <div className="detail-grid compare-detail-grid">
                    <div>
                      <span className="subtle">Exchange symbol</span>
                      <strong>{exchange.exchange_symbol}</strong>
                    </div>
                    <div>
                      <span className="subtle">Funding interval</span>
                      <strong>{exchange.funding_interval_hours}h</strong>
                    </div>
                    <div>
                      <span className="subtle">Mark price</span>
                      <strong>{formatUsd(exchange.mark_price)}</strong>
                    </div>
                    <div>
                      <span className="subtle">Open interest</span>
                      <strong>{formatUsd(exchange.open_interest_usd)}</strong>
                    </div>
                    <div>
                      <span className="subtle">24h volume</span>
                      <strong>{formatUsd(exchange.volume_24h)}</strong>
                    </div>
                    <div>
                      <span className="subtle">Maker / taker fee</span>
                      <strong>
                        {exchange.maker_fee_bps.toFixed(2)} / {exchange.taker_fee_bps.toFixed(2)} bps
                      </strong>
                    </div>
                    <div>
                      <span className="subtle">Estimated funding</span>
                      <strong>
                        {exchange.estimated_funding_rate == null
                          ? "n/a"
                          : formatPct(exchange.estimated_funding_rate * 100, 3)}
                      </strong>
                    </div>
                    <div>
                      <span className="subtle">Venue next funding</span>
                      <strong>{formatCountdown(exchange.next_funding_time, nowTimestamp)}</strong>
                    </div>
                    <div>
                      <span className="subtle">Funding timestamp</span>
                      <strong>{formatTimestamp(exchange.next_funding_time)}</strong>
                    </div>
                    <div>
                      <span className="subtle">Data age</span>
                      <strong>{exchange.data_age_seconds == null ? "n/a" : `${Math.round(exchange.data_age_seconds)}s`}</strong>
                    </div>
                  </div>

                  <div className="compare-card-actions">
                    <a href={exchange.trade_url} target="_blank" rel="noreferrer" className="action-button secondary-button compare-link">
                      Open exchange
                    </a>
                  </div>

                  <div className="compare-diagnostics">
                    <div className="overview-card-header">
                      <strong>Exchange health</strong>
                      <span className="subtle">{buildExchangeDiagnostics(exchange).length ? "Needs review" : "Healthy enough"}</span>
                    </div>
                    {buildExchangeDiagnostics(exchange).length ? (
                      <ul className="warning-list compare-warning-list">
                        {buildExchangeDiagnostics(exchange).map((warning) => (
                          <li key={warning}>{warning}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="subtle">Feed timing, mark quality, and funding fields look usable for monitoring.</p>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="panel compare-panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Manual Helper</p>
                <h2>What to do</h2>
                <div className="subtle">Read-only execution guidance with symbols, fees, countdown, and direct exchange links.</div>
              </div>
              <div className="panel-note">{planLoading ? "Building helper" : plan ? "Dry-run ready" : "No live pair"}</div>
            </div>

            {plan && bestOpportunity ? (
              <div className="compare-manual-grid">
                <article className="overview-card compare-execution-card">
                  <div className="overview-card-header">
                    <div>
                      <p className="eyebrow">Long leg</p>
                      <strong>{plan.long_leg.display_name}</strong>
                    </div>
                    <span className="phase-pill">Buy / Long</span>
                  </div>
                  <div className="detail-grid compare-detail-grid">
                    <div>
                      <span className="subtle">Exchange symbol</span>
                      <strong>{plan.long_leg.exchange_symbol}</strong>
                    </div>
                    <div>
                      <span className="subtle">Reference price</span>
                      <strong>{formatUsd(plan.long_leg.reference_price)}</strong>
                    </div>
                    <div>
                      <span className="subtle">Taker fee</span>
                      <strong>{formatPct(plan.long_leg.taker_fee_percent, 3)}</strong>
                    </div>
                    <div>
                      <span className="subtle">Next funding</span>
                      <strong>{formatCountdown(bestOpportunity.long_leg.next_funding_time, nowTimestamp)}</strong>
                    </div>
                  </div>
                  <div className="compare-card-actions">
                    <a href={plan.long_leg.trade_url} target="_blank" rel="noreferrer" className="action-button secondary-button compare-link">
                      Open long exchange
                    </a>
                  </div>
                </article>

                <article className="overview-card compare-execution-card">
                  <div className="overview-card-header">
                    <div>
                      <p className="eyebrow">Short leg</p>
                      <strong>{plan.short_leg.display_name}</strong>
                    </div>
                    <span className="overview-badge negative-badge">Sell / Short</span>
                  </div>
                  <div className="detail-grid compare-detail-grid">
                    <div>
                      <span className="subtle">Exchange symbol</span>
                      <strong>{plan.short_leg.exchange_symbol}</strong>
                    </div>
                    <div>
                      <span className="subtle">Reference price</span>
                      <strong>{formatUsd(plan.short_leg.reference_price)}</strong>
                    </div>
                    <div>
                      <span className="subtle">Taker fee</span>
                      <strong>{formatPct(plan.short_leg.taker_fee_percent, 3)}</strong>
                    </div>
                    <div>
                      <span className="subtle">Next funding</span>
                      <strong>{formatCountdown(bestOpportunity.short_leg.next_funding_time, nowTimestamp)}</strong>
                    </div>
                  </div>
                  <div className="compare-card-actions">
                    <a href={plan.short_leg.trade_url} target="_blank" rel="noreferrer" className="action-button secondary-button compare-link">
                      Open short exchange
                    </a>
                  </div>
                </article>

                <article className="overview-card compare-execution-summary">
                  <div className="overview-card-header">
                    <div>
                      <p className="eyebrow">Trade summary</p>
                      <strong>{plan.canonical_symbol}</strong>
                    </div>
                    <span className={plan.expected_net_pnl_usd >= 0 ? "phase-pill" : "overview-badge negative-badge"}>
                      {formatPct(plan.expected_net_return_on_capital_percent)}
                    </span>
                  </div>
                  <div className="detail-grid compare-detail-grid">
                    <div>
                      <span className="subtle">Total fees</span>
                      <strong>{formatUsd(plan.estimated_total_fees_usd)}</strong>
                    </div>
                    <div>
                      <span className="subtle">Funding countdown</span>
                      <strong>{formatCountdown(bestOpportunity.long_leg.next_funding_time, nowTimestamp)}</strong>
                    </div>
                    <div>
                      <span className="subtle">Funding PnL</span>
                      <strong>{formatUsd(plan.estimated_funding_pnl_usd)}</strong>
                    </div>
                    <div>
                      <span className="subtle">Capital required</span>
                      <strong>{formatUsd(plan.capital_required_usd)}</strong>
                    </div>
                  </div>
                  <ul className="warning-list compare-warning-list">
                    {plan.entry_steps.slice(0, 2).map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ul>
                </article>
              </div>
            ) : (
              <div className="empty-state">
                <p>No manual execution helper is available right now.</p>
                <span>This appears when the symbol has a live best pair across exchanges.</span>
              </div>
            )}
          </section>

          <section className="panel compare-panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Funding History</p>
                <h2>Per-exchange funding lines</h2>
                <div className="subtle">Historical funding snapshots for this symbol across Binance, Delta, and CoinDCX.</div>
              </div>
              <div className="panel-note">{trendsLoading ? "Loading history" : `${series.length} series`}</div>
            </div>

            <FundingTrendChart series={series} />
          </section>
        </>
      ) : null}
    </main>
  );
}
