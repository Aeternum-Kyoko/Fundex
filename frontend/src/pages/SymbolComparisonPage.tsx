import { useDeferredValue, useMemo, useState } from "react";
import { useCurrencyRates } from "../hooks/useCurrencyRates";
import { useExecutionPlan } from "../hooks/useExecutionPlan";
import { useSymbolComparison } from "../hooks/useSymbolComparison";
import { useNow } from "../hooks/useNow";
import {
  exchangeLabel,
  exchangeToneClass,
  explainNoPair,
  formatCountdown,
  formatFundingRate,
  formatLeverage,
  formatPct,
  formatTimestamp,
  formatUsd,
  getExchangeCapabilityBadges,
  getExchangeTrustBadge,
  getExchangeTrustReasons,
  getOpportunityTrustBadge,
} from "../lib/monitor";

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

function formatLocalizedCurrency(amountUsd: number, currency: string, rates: Record<string, number>) {
  const rate = rates[currency] ?? 1;
  const converted = amountUsd * rate;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    notation: Math.abs(converted) >= 1_000_000 ? "compact" : "standard",
    maximumFractionDigits: 2,
  }).format(converted);
}

function buildLeverageComfortWarnings(input: {
  longDisplayName: string;
  shortDisplayName: string;
  requestedLeverage: number;
  longMaxLeverage: number | null | undefined;
  shortMaxLeverage: number | null | undefined;
}) {
  const warnings: string[] = [];

  const evaluateVenue = (label: string, maxLeverage: number | null | undefined) => {
    if (maxLeverage == null || !Number.isFinite(maxLeverage) || maxLeverage <= 0) {
      warnings.push(`${label} does not expose max leverage in this feed, so size should be verified on the exchange before entry.`);
      return;
    }

    if (input.requestedLeverage > maxLeverage) {
      warnings.push(
        `${label} exposes ${formatLeverage(maxLeverage)} max leverage, but this setup models ${formatLeverage(input.requestedLeverage)}. This may require more leverage than the venue exposes.`,
      );
      return;
    }

    if (input.requestedLeverage / maxLeverage >= 0.8) {
      warnings.push(
        `${label} only leaves a narrow leverage buffer at ${formatLeverage(maxLeverage)} max, so execution room is tight for this setup.`,
      );
    }
  };

  evaluateVenue(input.longDisplayName, input.longMaxLeverage);
  evaluateVenue(input.shortDisplayName, input.shortMaxLeverage);

  return warnings;
}

export function SymbolComparisonPage({ canonicalSymbol }: { canonicalSymbol: string }) {
  const [capitalUsdInput, setCapitalUsdInput] = useState("1000");
  const [displayCurrency, setDisplayCurrency] = useState("USD");
  const [executionScenario, setExecutionScenario] = useState<"best" | "reverse">("best");
  const capitalUsd = Number(capitalUsdInput) > 0 ? Number(capitalUsdInput) : 1000;
  const deferredCapitalUsd = useDeferredValue(capitalUsd);
  const selectedExchanges = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    const exchanges = params.get("exchanges");
    return exchanges ? exchanges.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean) : [];
  }, []);
  const { rates, loading: ratesLoading, error: ratesError, date: ratesDate } = useCurrencyRates();
  const currencyOptions = useMemo(() => Object.keys(rates).sort(), [rates]);
  const { comparison, loading, error } = useSymbolComparison(canonicalSymbol, selectedExchanges);

  const bestOpportunity = comparison?.best_opportunity ?? null;
  const { plan: bestPlan, loading: bestPlanLoading } = useExecutionPlan(
    bestOpportunity?.canonical_symbol ?? null,
    Boolean(bestOpportunity),
    selectedExchanges,
    {
      capitalUsd: deferredCapitalUsd,
      leverage: 2,
      holdingPeriods: 1,
      reverse: false,
    },
  );
  const { plan: reversePlan, loading: reversePlanLoading } = useExecutionPlan(
    bestOpportunity?.canonical_symbol ?? null,
    Boolean(bestOpportunity),
    selectedExchanges,
    {
      capitalUsd: deferredCapitalUsd,
      leverage: 2,
      holdingPeriods: 1,
      reverse: true,
    },
  );
  const plan = executionScenario === "reverse" ? reversePlan : bestPlan;
  const planLoading = executionScenario === "reverse" ? reversePlanLoading : bestPlanLoading;
  const nowTimestamp = useNow(1000);
  const noPairReason = useMemo(
    () => (comparison && !bestOpportunity ? explainNoPair(comparison.exchanges) : null),
    [bestOpportunity, comparison],
  );
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
  const missingExchanges = useMemo(() => {
    if (!comparison) {
      return [];
    }
    const listed = new Set(comparison.exchanges.map((exchange) => exchange.exchange));
    return comparison.requested_exchanges.filter((exchange) => !listed.has(exchange));
  }, [comparison]);
  const longSnapshot = useMemo(
    () => comparison?.exchanges.find((exchange) => exchange.exchange === bestOpportunity?.long_leg.exchange) ?? null,
    [bestOpportunity?.long_leg.exchange, comparison?.exchanges],
  );
  const shortSnapshot = useMemo(
    () => comparison?.exchanges.find((exchange) => exchange.exchange === bestOpportunity?.short_leg.exchange) ?? null,
    [bestOpportunity?.short_leg.exchange, comparison?.exchanges],
  );
  const decisionTrust = useMemo(() => (bestOpportunity ? getOpportunityTrustBadge(bestOpportunity) : null), [bestOpportunity]);
  const activeLongLeg = useMemo(
    () => (bestOpportunity ? (executionScenario === "reverse" ? bestOpportunity.short_leg : bestOpportunity.long_leg) : null),
    [bestOpportunity, executionScenario],
  );
  const activeShortLeg = useMemo(
    () => (bestOpportunity ? (executionScenario === "reverse" ? bestOpportunity.long_leg : bestOpportunity.short_leg) : null),
    [bestOpportunity, executionScenario],
  );
  const executionLeverageWarnings = useMemo(() => {
    if (!plan || !activeLongLeg || !activeShortLeg) {
      return [];
    }

    return buildLeverageComfortWarnings({
      longDisplayName: plan.long_leg.display_name,
      shortDisplayName: plan.short_leg.display_name,
      requestedLeverage: plan.leverage,
      longMaxLeverage: activeLongLeg.max_leverage,
      shortMaxLeverage: activeShortLeg.max_leverage,
    });
  }, [activeLongLeg, activeShortLeg, plan]);
  const selectedRate = rates[displayCurrency] ?? 1;
  const fxSummary = useMemo(() => {
    if (displayCurrency === "USD") {
      return "Universal base: USD";
    }
    return `1 USD = ${selectedRate.toFixed(4)} ${displayCurrency}`;
  }, [displayCurrency, selectedRate]);
  const formatMoney = (amountUsd: number) =>
    displayCurrency === "USD"
      ? formatUsd(amountUsd)
      : `${formatUsd(amountUsd)} (${formatLocalizedCurrency(amountUsd, displayCurrency, rates)})`;

  return (
    <main className="page compare-page">
      <section className="hero compare-hero">
        <div>
          <p className="eyebrow">Symbol Compare</p>
          <h1>{comparison?.canonical_symbol ?? canonicalSymbol}</h1>
          <p className="lede">
            One symbol across every active exchange, with live funding, mark, fees, next funding timing, confidence, and
            manual action guidance in one place.
          </p>
          <div className="compare-top-actions">
            <a href="/" className="action-button secondary-button compare-link">
              Back to dashboard
            </a>
          </div>
        </div>

        <div className="hero-card compare-hero-card">
          <span className="chip">Best live pair</span>
          {bestOpportunity ? (
            <>
              <div className="compare-hero-callout">
                <strong>{formatPct(bestOpportunity.spread_rate * 100, 3)}</strong>
                <span>{formatPct(bestOpportunity.net_apr_percent)} net APR</span>
              </div>
              <p>
                Long on {bestOpportunity.long_leg.display_name}, short on {bestOpportunity.short_leg.display_name}, with{" "}
                {(bestOpportunity.confidence_score * 100).toFixed(0)}/100 confidence.
              </p>
              <div className="best-pair-strip">
                <div className={`best-pair-leg ${exchangeToneClass(bestOpportunity.long_leg.exchange)}`}>
                  Long {bestOpportunity.long_leg.display_name}
                </div>
                <div className={`best-pair-leg ${exchangeToneClass(bestOpportunity.short_leg.exchange)}`}>
                  Short {bestOpportunity.short_leg.display_name}
                </div>
              </div>
            </>
          ) : (
            <>
              <strong>No active pair</strong>
              <p>{noPairReason}</p>
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

      {bestOpportunity && plan ? (
        <section className="panel compare-panel decision-summary-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Decision Summary</p>
              <h2>Best action right now</h2>
              <div className="subtle">
                A tighter read on what to do, how trustworthy the feed looks, and what leverage room the two venues expose.
              </div>
            </div>
            {decisionTrust ? (
              <span className={`quality-badge quality-${decisionTrust.tone} decision-trust-badge`}>{decisionTrust.label}</span>
            ) : null}
          </div>

          <div className="decision-summary-grid">
            <article className="overview-card decision-summary-card">
              <div className="overview-card-header">
                <strong>Action</strong>
                <span className="subtle">{formatPct(plan.expected_net_return_on_capital_percent)} expected return</span>
              </div>
              <div className="decision-summary-stack">
                <div>
                  <span className="subtle">Long</span>
                  <strong>{plan.long_leg.display_name}</strong>
                  <div className="subtle">
                    {plan.long_leg.exchange_symbol} | {executionScenario === "reverse"
                      ? formatFundingRate(bestOpportunity.short_leg.funding_rate)
                      : formatFundingRate(bestOpportunity.long_leg.funding_rate)}
                  </div>
                </div>
                <div>
                  <span className="subtle">Short</span>
                  <strong>{plan.short_leg.display_name}</strong>
                  <div className="subtle">
                    {plan.short_leg.exchange_symbol} | {executionScenario === "reverse"
                      ? formatFundingRate(bestOpportunity.long_leg.funding_rate)
                      : formatFundingRate(bestOpportunity.short_leg.funding_rate)}
                  </div>
                </div>
              </div>
            </article>

            <article className="overview-card decision-summary-card">
              <div className="overview-card-header">
                <strong>Timing and cost</strong>
                <span className="subtle">Current live pair</span>
              </div>
              <div className="decision-summary-stack">
                <div>
                  <span className="subtle">Pair funding</span>
                  <strong>{pairFundingTime ? formatCountdown(pairFundingTime, nowTimestamp) : "n/a"}</strong>
                </div>
                <div>
                  <span className="subtle">Projected profit</span>
                  <strong>{formatMoney(plan.expected_net_pnl_usd)}</strong>
                </div>
                <div>
                  <span className="subtle">Fee impact</span>
                  <strong>{formatMoney(plan.estimated_total_fees_usd)}</strong>
                </div>
              </div>
            </article>

            <article className="overview-card decision-summary-card">
              <div className="overview-card-header">
                <strong>Leverage and trust</strong>
                <span className="subtle">Venue-specific checks</span>
              </div>
              <div className="decision-summary-stack">
                <div>
                  <span className="subtle">{plan.long_leg.display_name}</span>
                  <strong>{formatLeverage(executionScenario === "reverse" ? bestOpportunity.short_leg.max_leverage : bestOpportunity.long_leg.max_leverage)}</strong>
                  <div className="subtle">
                    {executionScenario === "reverse"
                      ? shortSnapshot ? getExchangeTrustBadge(shortSnapshot).label : "Trust unavailable"
                      : longSnapshot ? getExchangeTrustBadge(longSnapshot).label : "Trust unavailable"}
                  </div>
                </div>
                <div>
                  <span className="subtle">{plan.short_leg.display_name}</span>
                  <strong>{formatLeverage(executionScenario === "reverse" ? bestOpportunity.long_leg.max_leverage : bestOpportunity.short_leg.max_leverage)}</strong>
                  <div className="subtle">
                    {executionScenario === "reverse"
                      ? longSnapshot ? getExchangeTrustBadge(longSnapshot).label : "Trust unavailable"
                      : shortSnapshot ? getExchangeTrustBadge(shortSnapshot).label : "Trust unavailable"}
                  </div>
                </div>
              </div>
            </article>
          </div>
        </section>
      ) : null}

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
                <article
                  className={`overview-card compare-exchange-card ${exchangeToneClass(exchange.exchange)}`}
                  key={`${exchange.exchange}-${exchange.exchange_symbol}`}
                >
                  <div className="overview-card-header">
                    <div>
                      <p className="eyebrow">Exchange</p>
                      <strong>{exchange.display_name}</strong>
                    </div>
                    <div className="compare-card-top-badges">
                      <span className={`quality-badge quality-${getExchangeTrustBadge(exchange).tone}`}>
                        {getExchangeTrustBadge(exchange).label}
                      </span>
                      <span className={exchange.funding_rate >= 0 ? "phase-pill" : "overview-badge negative-badge"}>
                        {formatFundingRate(exchange.funding_rate)}
                      </span>
                    </div>
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
                      <span className="subtle">Max leverage</span>
                      <strong>{formatLeverage(exchange.max_leverage)}</strong>
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
                      <strong>Feed trust</strong>
                      <span className="subtle">{getExchangeTrustReasons(exchange).join(" | ")}</span>
                    </div>
                    <div className="quality-badge-row compare-capability-row">
                      {getExchangeCapabilityBadges(exchange).map((badge) => (
                        <span key={badge.label} className={`quality-badge quality-${badge.tone}`}>
                          {badge.label}
                        </span>
                      ))}
                    </div>
                    <div className="quality-badge-row compare-trust-row">
                      {getExchangeTrustReasons(exchange).map((reason) => (
                        <span key={reason} className="quality-badge quality-neutral">
                          {reason}
                        </span>
                      ))}
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

              {missingExchanges.map((exchange) => (
                <article
                  className={`overview-card compare-exchange-card compare-missing-card ${exchangeToneClass(exchange)}`}
                  key={`missing-${exchange}`}
                >
                  <div className="overview-card-header">
                    <div>
                      <p className="eyebrow">Exchange</p>
                      <strong>{exchangeLabel(exchange)}</strong>
                    </div>
                    <span className="overview-badge">Not listed</span>
                  </div>

                  <div className="empty-state compact-empty compare-missing-empty">
                    <p>This symbol is not listed on {exchangeLabel(exchange)} right now.</p>
                    <span>No live funding details are available for this venue in the current scope.</span>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="panel compare-panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Execution Size Helper</p>
                <h2>Capital, quantity, margin, and projected profit</h2>
                <div className="subtle">Give your capital and compare the normal hedge against the reversed setup before acting.</div>
              </div>
              <div className="panel-note">{planLoading ? "Building helper" : plan ? "Dry-run ready" : "No live pair"}</div>
            </div>

            {bestOpportunity ? (
              <>
                <div className="execution-controls">
                  <div className="execution-capital-group">
                    {[500, 1000, 5000, 10000].map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        className={`overview-button execution-chip ${capitalUsd === preset ? "execution-chip-active" : ""}`}
                        onClick={() => setCapitalUsdInput(String(preset))}
                      >
                        ${preset}
                      </button>
                    ))}
                    <label className="control execution-capital-input">
                      <span className="subtle">Your capital</span>
                      <input
                        type="number"
                        min="1"
                        step="any"
                        value={capitalUsdInput}
                        onChange={(event) => setCapitalUsdInput(event.target.value)}
                      />
                    </label>
                  </div>
                  <div className="execution-scenario-toggle">
                    <label className="control execution-currency-input">
                      <span className="subtle">Display currency</span>
                      <select value={displayCurrency} onChange={(event) => setDisplayCurrency(event.target.value)}>
                        {currencyOptions.map((currency) => (
                          <option key={currency} value={currency}>
                            {currency === "USD" ? "USD - 1.0000" : `${currency} - ${(rates[currency] ?? 0).toFixed(4)}`}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      className={`overview-button execution-chip ${executionScenario === "best" ? "execution-chip-active" : ""}`}
                      onClick={() => setExecutionScenario("best")}
                    >
                      Best setup
                    </button>
                    <button
                      type="button"
                      className={`overview-button execution-chip ${executionScenario === "reverse" ? "execution-chip-active" : ""}`}
                      onClick={() => setExecutionScenario("reverse")}
                    >
                      Reverse setup
                    </button>
                  </div>
                </div>
                <div className="subtle execution-fx-summary">
                  {fxSummary}
                  {ratesDate ? ` | rates date ${ratesDate}` : ""}
                  {ratesLoading ? " | updating FX..." : ""}
                  {ratesError ? ` | ${ratesError}` : ""}
                </div>

                {executionLeverageWarnings.length ? (
                  <div className="execution-validation-banner">
                    <strong>Leverage validation</strong>
                    <ul className="warning-list compare-warning-list">
                      {executionLeverageWarnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                <div className="execution-outcome-grid">
                  {[bestPlan, reversePlan].filter((item): item is NonNullable<typeof bestPlan> => Boolean(item)).map((candidate) => (
                    <article
                      key={candidate.scenario}
                      className={`overview-card execution-outcome-card ${candidate.scenario === executionScenario ? "execution-outcome-card-active" : ""}`}
                    >
                      <div className="overview-card-header">
                        <div>
                          <p className="eyebrow">{candidate.scenario === "best" ? "Current edge" : "Reverse edge"}</p>
                          <strong>{candidate.long_leg.display_name} / {candidate.short_leg.display_name}</strong>
                        </div>
                        <span className={candidate.expected_net_pnl_usd >= 0 ? "phase-pill" : "overview-badge negative-badge"}>
                          {formatMoney(candidate.expected_net_pnl_usd)}
                        </span>
                      </div>
                      <div className="detail-grid compare-detail-grid">
                        <div>
                          <span className="subtle">Capital used</span>
                          <strong>{formatMoney(candidate.capital_required_usd)}</strong>
                        </div>
                        <div>
                          <span className="subtle">Gross size / leg</span>
                          <strong>{formatMoney(candidate.notional_usd)}</strong>
                        </div>
                        <div>
                          <span className="subtle">Fee impact</span>
                          <strong>{formatMoney(candidate.estimated_total_fees_usd)}</strong>
                        </div>
                        <div>
                          <span className="subtle">Return on capital</span>
                          <strong>{formatPct(candidate.expected_net_return_on_capital_percent)}</strong>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>

                {plan ? (
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
                      <strong>{formatMoney(plan.long_leg.reference_price)}</strong>
                    </div>
                    <div>
                      <span className="subtle">Estimated quantity</span>
                      <strong>{plan.long_leg.estimated_quantity.toFixed(6)}</strong>
                    </div>
                    <div>
                      <span className="subtle">Taker fee</span>
                      <strong>{formatPct(plan.long_leg.taker_fee_percent, 3)}</strong>
                    </div>
                    <div>
                      <span className="subtle">Next funding</span>
                      <strong>{formatCountdown(plan.long_leg.side === "buy" ? bestOpportunity.long_leg.next_funding_time : bestOpportunity.short_leg.next_funding_time, nowTimestamp)}</strong>
                    </div>
                    <div>
                      <span className="subtle">Max leverage</span>
                      <strong>{formatLeverage(plan.long_leg.side === "buy" ? bestOpportunity.long_leg.max_leverage : bestOpportunity.short_leg.max_leverage)}</strong>
                    </div>
                    <div>
                      <span className="subtle">Margin required</span>
                      <strong>{formatMoney(plan.long_leg.initial_margin_usd)}</strong>
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
                      <strong>{formatMoney(plan.short_leg.reference_price)}</strong>
                    </div>
                    <div>
                      <span className="subtle">Estimated quantity</span>
                      <strong>{plan.short_leg.estimated_quantity.toFixed(6)}</strong>
                    </div>
                    <div>
                      <span className="subtle">Taker fee</span>
                      <strong>{formatPct(plan.short_leg.taker_fee_percent, 3)}</strong>
                    </div>
                    <div>
                      <span className="subtle">Next funding</span>
                      <strong>{formatCountdown(plan.short_leg.side === "sell" ? bestOpportunity.short_leg.next_funding_time : bestOpportunity.long_leg.next_funding_time, nowTimestamp)}</strong>
                    </div>
                    <div>
                      <span className="subtle">Max leverage</span>
                      <strong>{formatLeverage(plan.short_leg.side === "sell" ? bestOpportunity.short_leg.max_leverage : bestOpportunity.long_leg.max_leverage)}</strong>
                    </div>
                    <div>
                      <span className="subtle">Margin required</span>
                      <strong>{formatMoney(plan.short_leg.initial_margin_usd)}</strong>
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
                      <strong>{formatMoney(plan.estimated_total_fees_usd)}</strong>
                    </div>
                    <div>
                      <span className="subtle">Funding countdown</span>
                      <strong>{formatCountdown(bestOpportunity.long_leg.next_funding_time, nowTimestamp)}</strong>
                    </div>
                    <div>
                      <span className="subtle">Funding PnL</span>
                      <strong>{formatMoney(plan.estimated_funding_pnl_usd)}</strong>
                    </div>
                    <div>
                      <span className="subtle">Capital required</span>
                      <strong>{formatMoney(plan.capital_required_usd)}</strong>
                    </div>
                    <div>
                      <span className="subtle">Projected profit</span>
                      <strong>{formatMoney(plan.expected_net_pnl_usd)}</strong>
                    </div>
                    <div>
                      <span className="subtle">Projected return</span>
                      <strong>{formatPct(plan.expected_net_return_on_capital_percent)}</strong>
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
                    <p>Execution sizing is loading.</p>
                    <span>The compare page will fill in quantities, fees, and profit once the dry-run is ready.</span>
                  </div>
                )}
              </>
            ) : (
              <div className="empty-state">
                <p>No manual execution helper is available right now.</p>
                <span>This appears when the symbol has a live best pair across exchanges.</span>
              </div>
            )}
          </section>

        </>
      ) : null}
    </main>
  );
}
