import { formatCountdown, formatPct, formatUsd, getNextFundingTime } from "../lib/monitor";
import type { ArbitrageOpportunity } from "../lib/types";

interface OpportunityTableProps {
  opportunities: ArbitrageOpportunity[];
  selectedSymbol: string | null;
  watchlist: string[];
  nowTimestamp: number;
  onSelect: (opportunity: ArbitrageOpportunity) => void;
  onToggleWatchlist: (symbol: string) => void;
}

export function OpportunityTable({
  opportunities,
  selectedSymbol,
  watchlist,
  nowTimestamp,
  onSelect,
  onToggleWatchlist,
}: OpportunityTableProps) {
  if (!opportunities.length) {
    return (
      <div className="empty-state">
        <p>No rows match the current search and filter settings.</p>
        <span>Clear the search or switch the filter back to All rows to widen the monitor.</span>
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
              <th>Binance FR</th>
              <th>Delta FR</th>
              <th>Lower Funding</th>
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
              const binanceLeg = opportunity.long_leg.exchange === "binance" ? opportunity.long_leg : opportunity.short_leg;
              const deltaLeg = opportunity.long_leg.exchange === "delta" ? opportunity.long_leg : opportunity.short_leg;
              const active = opportunity.canonical_symbol === selectedSymbol;
              const watched = watchlist.includes(opportunity.canonical_symbol);
              const nextFunding = getNextFundingTime(opportunity);

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
                      <div>
                        <strong>{opportunity.base_asset}</strong>
                        <div className="subtle">{opportunity.canonical_symbol}</div>
                      </div>
                      <div className="coin-actions">
                        <button
                          type="button"
                          className={watched ? "watch-button active-watch" : "watch-button"}
                          onClick={(event) => {
                            event.stopPropagation();
                            onToggleWatchlist(opportunity.canonical_symbol);
                          }}
                        >
                          {watched ? "Watching" : "Watch"}
                        </button>
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
                      </div>
                    </div>
                  </td>
                  <td>
                    <div className="table-pill binance-pill">Binance</div>
                    <div className={binanceLeg.funding_rate >= 0 ? "positive" : "negative"}>
                      {formatPct(binanceLeg.funding_rate * 100, 3)}
                    </div>
                  </td>
                  <td>
                    <div className="table-pill delta-pill">Delta</div>
                    <div className={deltaLeg.funding_rate >= 0 ? "positive" : "negative"}>
                      {formatPct(deltaLeg.funding_rate * 100, 3)}
                    </div>
                  </td>
                  <td>
                    <strong>{opportunity.long_leg.display_name}</strong>
                    <div className="subtle">{opportunity.long_leg.exchange_symbol}</div>
                  </td>
                  <td>
                    <strong>{formatCountdown(nextFunding, nowTimestamp)}</strong>
                    <div className="subtle">{nextFunding ? "earliest funding" : "not available"}</div>
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
          const binanceLeg = opportunity.long_leg.exchange === "binance" ? opportunity.long_leg : opportunity.short_leg;
          const deltaLeg = opportunity.long_leg.exchange === "delta" ? opportunity.long_leg : opportunity.short_leg;
          const watched = watchlist.includes(opportunity.canonical_symbol);
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
                  </div>
                  <span className={opportunity.net_apr_percent >= 0 ? "positive" : "negative"}>
                    {formatPct(opportunity.net_apr_percent)}
                  </span>
                </div>

                <div className="mobile-card-grid">
                  <div>
                    <span className="subtle">Binance FR</span>
                    <strong className={binanceLeg.funding_rate >= 0 ? "positive" : "negative"}>
                      {formatPct(binanceLeg.funding_rate * 100, 3)}
                    </strong>
                  </div>
                  <div>
                    <span className="subtle">Delta FR</span>
                    <strong className={deltaLeg.funding_rate >= 0 ? "positive" : "negative"}>
                      {formatPct(deltaLeg.funding_rate * 100, 3)}
                    </strong>
                  </div>
                  <div>
                    <span className="subtle">Spread</span>
                    <strong>{formatPct(opportunity.spread_rate * 100, 3)}</strong>
                  </div>
                  <div>
                    <span className="subtle">Funding</span>
                    <strong>{formatCountdown(nextFunding, nowTimestamp)}</strong>
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
                <button
                  type="button"
                  className={watched ? "watch-button active-watch" : "watch-button"}
                  onClick={() => onToggleWatchlist(opportunity.canonical_symbol)}
                >
                  {watched ? "Pinned" : "Pin"}
                </button>
                <button type="button" className="overview-button" onClick={() => onSelect(opportunity)}>
                  Overview
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}
