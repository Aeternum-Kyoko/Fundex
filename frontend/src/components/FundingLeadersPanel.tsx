import { FundingSparkline } from "./FundingSparkline";
import { exchangeToneClass, formatCountdown, formatPct, formatUsd } from "../lib/monitor";
import type { ExchangeFundingLeaders, FundingLeader, FundingTrendPoint } from "../lib/types";

interface FundingLeadersPanelProps {
  exchanges: ExchangeFundingLeaders[];
  pinnedSymbols: string[];
  trendMap: Record<string, Record<string, FundingTrendPoint[]>>;
  trendLoading: boolean;
  nowTimestamp: number;
  onOpenSymbol: (canonicalSymbol: string) => void;
  onTogglePin: (symbol: string) => void;
}

interface FundingLeaderListProps {
  title: string;
  leaders: FundingLeader[];
  pinnedSymbols: string[];
  trendMap: Record<string, Record<string, FundingTrendPoint[]>>;
  trendLoading: boolean;
  nowTimestamp: number;
  onOpenSymbol: (canonicalSymbol: string) => void;
  onTogglePin: (symbol: string) => void;
}

function FundingLeaderList({
  title,
  leaders,
  pinnedSymbols,
  trendMap,
  trendLoading,
  nowTimestamp,
  onOpenSymbol,
  onTogglePin,
}: FundingLeaderListProps) {
  return (
    <section className="funding-list-card">
      <div className="overview-card-header">
        <strong>{title}</strong>
        <span className="subtle">{leaders.length} symbols</span>
      </div>
      {leaders.length ? (
        <div className="funding-list">
          {leaders.map((leader) => {
            const trendPoints = trendMap[leader.canonical_symbol]?.[leader.exchange] ?? [];
            const pinned = pinnedSymbols.includes(leader.canonical_symbol);

            return (
              <article key={`${leader.exchange}-${leader.exchange_symbol}`} className="funding-item">
                <div className="funding-item-top funding-item-actions">
                  <button type="button" className="leader-open-button" onClick={() => onOpenSymbol(leader.canonical_symbol)}>
                    <strong>{leader.canonical_symbol}</strong>
                    <span className={leader.funding_rate >= 0 ? "positive" : "negative"}>
                      {formatPct(leader.funding_rate * 100, 3)}
                    </span>
                  </button>
                  <button
                    type="button"
                    className={pinned ? "watch-button active-watch" : "watch-button"}
                    onClick={() => onTogglePin(leader.canonical_symbol)}
                  >
                    {pinned ? "Pinned" : "Pin"}
                  </button>
                </div>

                <div className="subtle">{leader.exchange_symbol}</div>

                <div className="funding-sparkline-row">
                  <FundingSparkline points={trendPoints} positive={leader.funding_rate >= 0} />
                  <span className="subtle">{trendLoading ? "Loading trend" : "Recent trend"}</span>
                </div>

                <div className="funding-item-meta">
                  <span>{formatCountdown(leader.next_funding_time, nowTimestamp)}</span>
                  <span>{formatUsd(leader.open_interest_usd)}</span>
                </div>

                <div className="funding-item-footer">
                  <button type="button" className="inline-link button-link" onClick={() => onOpenSymbol(leader.canonical_symbol)}>
                    Open overview
                  </button>
                  <a href={leader.trade_url} target="_blank" rel="noreferrer" className="inline-link">
                    Open exchange
                  </a>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="empty-state compact-empty">
          <p>No symbols match this funding direction right now.</p>
        </div>
      )}
    </section>
  );
}

export function FundingLeadersPanel({
  exchanges,
  pinnedSymbols,
  trendMap,
  trendLoading,
  nowTimestamp,
  onOpenSymbol,
  onTogglePin,
}: FundingLeadersPanelProps) {
  if (!exchanges.length) {
    return null;
  }

  return (
    <section className="funding-leaders-grid">
      {exchanges.map((exchange) => (
        <article className={`overview-card funding-exchange-card ${exchangeToneClass(exchange.exchange)}`} key={exchange.exchange}>
          <div className="overview-card-header">
            <div>
              <p className="eyebrow">Funding Leaders</p>
              <strong>{exchange.display_name}</strong>
            </div>
            <span className="subtle">Pin rows, open overview, and scan short-term trend</span>
          </div>

          <div className="funding-lists-grid">
            <FundingLeaderList
              title="Top Positive Rates"
              leaders={exchange.top_positive}
              pinnedSymbols={pinnedSymbols}
              trendMap={trendMap}
              trendLoading={trendLoading}
              nowTimestamp={nowTimestamp}
              onOpenSymbol={onOpenSymbol}
              onTogglePin={onTogglePin}
            />
            <FundingLeaderList
              title="Top Negative Rates"
              leaders={exchange.top_negative}
              pinnedSymbols={pinnedSymbols}
              trendMap={trendMap}
              trendLoading={trendLoading}
              nowTimestamp={nowTimestamp}
              onOpenSymbol={onOpenSymbol}
              onTogglePin={onTogglePin}
            />
          </div>
        </article>
      ))}
    </section>
  );
}
