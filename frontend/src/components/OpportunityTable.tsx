import {
  exchangeLabel,
  exchangeToneClass,
  formatCountdown,
  formatLeverage,
  formatPct,
  formatUsd,
  getNextFundingTime,
  intervalBadge,
  qualityBadges,
} from "../lib/monitor";
import type { ArbitrageOpportunity, ExchangeName } from "../lib/types";

interface OpportunityTableProps {
  opportunities: ArbitrageOpportunity[];
  selectedSymbol: string | null;
  selectedExchanges: ExchangeName[];
  nowTimestamp: number;
  onSelect: (opportunity: ArbitrageOpportunity) => void;
}

export function OpportunityTable({
  opportunities,
  selectedSymbol,
  selectedExchanges,
  nowTimestamp,
  onSelect,
}: OpportunityTableProps) {
  const compareHref = (canonicalSymbol: string) => {
    const query = selectedExchanges.length ? `?exchanges=${encodeURIComponent(selectedExchanges.join(","))}` : "";
    return `/compare/${encodeURIComponent(canonicalSymbol)}${query}`;
  };

  if (!opportunities.length) {
    return (
      <div className="empty-state table-empty-state">
        <p>No rows match the current desk filters.</p>
        <span>Try clearing search, widening the view filter, or switching sort away from the narrowest setup.</span>
      </div>
    );
  }

  return (
    <>
      <div className="table-shell desktop-table-shell">
        <table className="opportunity-table">
          <thead>
            <tr>
              <th className="sticky-column">Coin</th>
              <th>Lower Funding</th>
              <th>Lower Rate</th>
              <th>Higher Funding</th>
              <th>Higher Rate</th>
              <th>Next Funding</th>
              <th>Spread</th>
              <th>Net APR</th>
              <th>Confidence</th>
              <th>Open Interest</th>
              <th>Mark Gap</th>
            </tr>
          </thead>
          <tbody>
            {opportunities.map((opportunity) => {
              const active = opportunity.canonical_symbol === selectedSymbol;
              const nextFunding = getNextFundingTime(opportunity);
              const badges = qualityBadges(opportunity);

              return (
                <tr
                  key={`${opportunity.canonical_symbol}-${opportunity.long_leg.exchange}-${opportunity.short_leg.exchange}`}
                  className={active ? "selected-row" : undefined}
                  onClick={() => onSelect(opportunity)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelect(opportunity);
                    }
                  }}
                  tabIndex={0}
                  aria-label={`Open overview for ${opportunity.canonical_symbol}`}
                >
                  <td className="sticky-column coin-column">
                    <div className="coin-cell">
                      <div className="coin-primary">
                        <div className="coin-title-row">
                          <strong>{opportunity.base_asset}</strong>
                          <div className="quality-badge-row">
                            {badges.map((badge) => (
                              <span key={badge.label} className={`quality-badge quality-${badge.tone}`}>
                                {badge.label}
                              </span>
                            ))}
                          </div>
                        </div>
                        <div className="subtle">{opportunity.canonical_symbol}</div>
                      </div>
                      <div className="coin-actions">
                        <button
                          type="button"
                          className="overview-button"
                          onClick={(event) => {
                            event.stopPropagation();
                            onSelect(opportunity);
                          }}
                        >
                          Overview
                        </button>
                        <a
                          className="overview-button compare-button-link"
                          href={compareHref(opportunity.canonical_symbol)}
                          onClick={(event) => event.stopPropagation()}
                        >
                          Compare
                        </a>
                      </div>
                    </div>
                  </td>
                  <td>
                    <div className={`table-pill ${exchangeToneClass(opportunity.long_leg.exchange)}`}>
                      {exchangeLabel(opportunity.long_leg.exchange)}
                    </div>
                    <strong>{opportunity.long_leg.display_name}</strong>
                    <div className="subtle">
                      {opportunity.long_leg.exchange_symbol} - {intervalBadge(opportunity.funding_interval_hours)}
                    </div>
                    <div className="subtle">Timer {formatCountdown(opportunity.long_leg.next_funding_time, nowTimestamp)}</div>
                    <div className="subtle">Max leverage {formatLeverage(opportunity.long_leg.max_leverage)}</div>
                  </td>
                  <td className={opportunity.long_leg.funding_rate >= 0 ? "positive" : "negative"}>
                    {formatPct(opportunity.long_leg.funding_rate * 100, 3)}
                  </td>
                  <td>
                    <div className={`table-pill ${exchangeToneClass(opportunity.short_leg.exchange)}`}>
                      {exchangeLabel(opportunity.short_leg.exchange)}
                    </div>
                    <strong>{opportunity.short_leg.display_name}</strong>
                    <div className="subtle">
                      {opportunity.short_leg.exchange_symbol} - {intervalBadge(opportunity.funding_interval_hours)}
                    </div>
                    <div className="subtle">Timer {formatCountdown(opportunity.short_leg.next_funding_time, nowTimestamp)}</div>
                    <div className="subtle">Max leverage {formatLeverage(opportunity.short_leg.max_leverage)}</div>
                  </td>
                  <td className={opportunity.short_leg.funding_rate >= 0 ? "positive" : "negative"}>
                    {formatPct(opportunity.short_leg.funding_rate * 100, 3)}
                  </td>
                  <td>
                    <strong>{formatCountdown(nextFunding, nowTimestamp)}</strong>
                    <div className="subtle">{nextFunding ? "earliest pair funding" : "not available"}</div>
                    <div className="subtle">
                      {exchangeLabel(opportunity.long_leg.exchange)} {formatCountdown(opportunity.long_leg.next_funding_time, nowTimestamp)}
                    </div>
                    <div className="subtle">
                      {exchangeLabel(opportunity.short_leg.exchange)} {formatCountdown(opportunity.short_leg.next_funding_time, nowTimestamp)}
                    </div>
                  </td>
                  <td>{formatPct(opportunity.spread_rate * 100, 3)}</td>
                  <td className={opportunity.net_apr_percent >= 0 ? "positive" : "negative"}>
                    {formatPct(opportunity.net_apr_percent)}
                  </td>
                  <td>
                    {(opportunity.confidence_score * 100).toFixed(0)}
                    <span className="subtle">/100</span>
                  </td>
                  <td>{formatUsd(opportunity.combined_open_interest_usd)}</td>
                  <td>{opportunity.price_dislocation_percent ? formatPct(opportunity.price_dislocation_percent, 3) : "n/a"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mobile-opportunity-list">
        {opportunities.map((opportunity) => {
          const active = opportunity.canonical_symbol === selectedSymbol;
          const nextFunding = getNextFundingTime(opportunity);

          return (
            <article
              key={`${opportunity.canonical_symbol}-mobile`}
              className={active ? "mobile-opportunity-card selected-mobile-card" : "mobile-opportunity-card"}
            >
              <button type="button" className="mobile-card-main" onClick={() => onSelect(opportunity)}>
                <div className="mobile-card-header">
                  <div>
                    <strong>{opportunity.base_asset}</strong>
                    <div className="subtle">{opportunity.canonical_symbol}</div>
                    <div className="quality-badge-row mobile-quality-row">
                      {qualityBadges(opportunity).map((badge) => (
                        <span key={badge.label} className={`quality-badge quality-${badge.tone}`}>
                          {badge.label}
                        </span>
                      ))}
                    </div>
                  </div>
                  <span className={opportunity.net_apr_percent >= 0 ? "positive" : "negative"}>
                    {formatPct(opportunity.net_apr_percent)}
                  </span>
                </div>

                <div className="mobile-card-grid">
                  <div>
                    <span className="subtle">
                      {opportunity.long_leg.display_name} - {intervalBadge(opportunity.funding_interval_hours)}
                    </span>
                    <strong className={opportunity.long_leg.funding_rate >= 0 ? "positive" : "negative"}>
                      {formatPct(opportunity.long_leg.funding_rate * 100, 3)}
                    </strong>
                    <span className="subtle">Timer {formatCountdown(opportunity.long_leg.next_funding_time, nowTimestamp)}</span>
                    <span className="subtle">Max leverage {formatLeverage(opportunity.long_leg.max_leverage)}</span>
                  </div>
                  <div>
                    <span className="subtle">
                      {opportunity.short_leg.display_name} - {intervalBadge(opportunity.funding_interval_hours)}
                    </span>
                    <strong className={opportunity.short_leg.funding_rate >= 0 ? "positive" : "negative"}>
                      {formatPct(opportunity.short_leg.funding_rate * 100, 3)}
                    </strong>
                    <span className="subtle">Timer {formatCountdown(opportunity.short_leg.next_funding_time, nowTimestamp)}</span>
                    <span className="subtle">Max leverage {formatLeverage(opportunity.short_leg.max_leverage)}</span>
                  </div>
                  <div>
                    <span className="subtle">Spread</span>
                    <strong>{formatPct(opportunity.spread_rate * 100, 3)}</strong>
                  </div>
                  <div>
                    <span className="subtle">Funding</span>
                    <strong>{formatCountdown(nextFunding, nowTimestamp)}</strong>
                    <span className="subtle">Pair earliest</span>
                  </div>
                  <div>
                    <span className="subtle">Lower funding</span>
                    <strong>{opportunity.long_leg.display_name}</strong>
                  </div>
                  <div>
                    <span className="subtle">Open interest</span>
                    <strong>{formatUsd(opportunity.combined_open_interest_usd)}</strong>
                  </div>
                </div>
              </button>

              <div className="mobile-card-actions">
                <button type="button" className="overview-button" onClick={() => onSelect(opportunity)}>
                  Overview
                </button>
                <a className="overview-button compare-button-link" href={compareHref(opportunity.canonical_symbol)}>
                  Compare
                </a>
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}
