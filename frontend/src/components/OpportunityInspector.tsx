import { useEffect } from "react";
import { formatCountdown, formatPct, formatTimestamp, formatUsd, getNextFundingTime } from "../lib/monitor";
import type { ArbitrageOpportunity, OpportunityHistoryResponse } from "../lib/types";
import { HistoryChart } from "./HistoryChart";

interface OpportunityInspectorProps {
  opportunity: ArbitrageOpportunity | null;
  history: OpportunityHistoryResponse | null;
  loading: boolean;
  isOpen: boolean;
  isWatched: boolean;
  nowTimestamp: number;
  onClose: () => void;
  onToggleWatchlist: (symbol: string) => void;
}

export function OpportunityInspector({
  opportunity,
  history,
  loading,
  isOpen,
  isWatched,
  nowTimestamp,
  onClose,
  onToggleWatchlist,
}: OpportunityInspectorProps) {
  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose]);

  if (!isOpen || !opportunity) {
    return null;
  }

  const nextFunding = getNextFundingTime(opportunity);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <aside
        className="inspector-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="overview-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="inspector-header">
          <div>
            <p className="eyebrow">Overview</p>
            <h3 id="overview-title">{opportunity.canonical_symbol}</h3>
            <p className="subtle">
              Lower funding on {opportunity.long_leg.display_name}, higher funding on {opportunity.short_leg.display_name}
            </p>
          </div>
          <div className="inspector-actions">
            <button
              type="button"
              className={isWatched ? "watch-button active-watch" : "watch-button"}
              onClick={() => onToggleWatchlist(opportunity.canonical_symbol)}
            >
              {isWatched ? "Watching" : "Watch"}
            </button>
            <div className={opportunity.net_apr_percent >= 0 ? "phase-pill" : "overview-badge negative-badge"}>
              {formatPct(opportunity.net_apr_percent)}
            </div>
            <button type="button" className="close-button" onClick={onClose} aria-label="Close overview">
              Close
            </button>
          </div>
        </div>

        <div className="inspector-top">
          <a className="inspector-leg" href={opportunity.long_leg.trade_url} target="_blank" rel="noreferrer">
            <span className="leg leg-long">Lower funding</span>
            <strong>{opportunity.long_leg.display_name}</strong>
            <span className="subtle">{opportunity.long_leg.exchange_symbol}</span>
            <span>{formatPct(opportunity.long_leg.funding_rate * 100, 3)}</span>
          </a>
          <a className="inspector-leg" href={opportunity.short_leg.trade_url} target="_blank" rel="noreferrer">
            <span className="leg leg-short">Higher funding</span>
            <strong>{opportunity.short_leg.display_name}</strong>
            <span className="subtle">{opportunity.short_leg.exchange_symbol}</span>
            <span>{formatPct(opportunity.short_leg.funding_rate * 100, 3)}</span>
          </a>
        </div>

        <div className="metric-grid">
          <div className="metric-card">
            <span className="subtle">Spread</span>
            <strong>{formatPct(opportunity.spread_rate * 100, 3)}</strong>
          </div>
          <div className="metric-card">
            <span className="subtle">Gross APR</span>
            <strong>{formatPct(opportunity.gross_apr_percent)}</strong>
          </div>
          <div className="metric-card">
            <span className="subtle">Net APR</span>
            <strong className={opportunity.net_apr_percent >= 0 ? "positive" : "negative"}>
              {formatPct(opportunity.net_apr_percent)}
            </strong>
          </div>
          <div className="metric-card">
            <span className="subtle">Next funding</span>
            <strong>{formatCountdown(nextFunding, nowTimestamp)}</strong>
          </div>
          <div className="metric-card">
            <span className="subtle">Combined OI</span>
            <strong>{formatUsd(opportunity.combined_open_interest_usd)}</strong>
          </div>
          <div className="metric-card">
            <span className="subtle">Mark gap</span>
            <strong>{opportunity.price_dislocation_percent ? formatPct(opportunity.price_dislocation_percent, 3) : "n/a"}</strong>
          </div>
        </div>

        <div className="overview-grid">
          <section className="overview-card">
            <div className="overview-card-header">
              <strong>Market detail</strong>
              <span className="subtle">Live snapshot</span>
            </div>
            <div className="detail-grid">
              <div>
                <span className="subtle">Funding interval</span>
                <strong>{opportunity.funding_interval_hours}h</strong>
              </div>
              <div>
                <span className="subtle">Confidence</span>
                <strong>{(opportunity.confidence_score * 100).toFixed(0)}/100</strong>
              </div>
              <div>
                <span className="subtle">Binance mark</span>
                <strong>
                  {opportunity.long_leg.exchange === "binance"
                    ? formatUsd(opportunity.long_leg.mark_price)
                    : formatUsd(opportunity.short_leg.mark_price)}
                </strong>
              </div>
              <div>
                <span className="subtle">Delta mark</span>
                <strong>
                  {opportunity.long_leg.exchange === "delta"
                    ? formatUsd(opportunity.long_leg.mark_price)
                    : formatUsd(opportunity.short_leg.mark_price)}
                </strong>
              </div>
              <div>
                <span className="subtle">Binance next funding</span>
                <strong>
                  {opportunity.long_leg.exchange === "binance"
                    ? formatTimestamp(opportunity.long_leg.next_funding_time)
                    : formatTimestamp(opportunity.short_leg.next_funding_time)}
                </strong>
              </div>
              <div>
                <span className="subtle">Delta next funding</span>
                <strong>
                  {opportunity.long_leg.exchange === "delta"
                    ? formatTimestamp(opportunity.long_leg.next_funding_time)
                    : formatTimestamp(opportunity.short_leg.next_funding_time)}
                </strong>
              </div>
            </div>
          </section>

          <section className="overview-card">
            <div className="overview-card-header">
              <strong>Warnings</strong>
              <span className="subtle">{opportunity.warnings.length ? "Review before acting" : "No active warnings"}</span>
            </div>
            {opportunity.warnings.length ? (
              <ul className="warning-list">
                {opportunity.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : (
              <p className="subtle">This row is clean enough for monitoring. The modal keeps the raw comparison visible either way.</p>
            )}
          </section>
        </div>

        <div className="history-section">
          <div className="status-topline">
            <strong>Spread history</strong>
            <span className="subtle">{loading ? "Loading..." : `${history?.total ?? 0} persisted points`}</span>
          </div>
          <HistoryChart points={history?.points ?? []} />
        </div>
      </aside>
    </div>
  );
}
