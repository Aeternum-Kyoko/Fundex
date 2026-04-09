import { exchangeToneClass, formatCountdown, formatPct, formatUsd } from "../lib/monitor";
import type { ExchangeFundingLeaders, FundingLeader } from "../lib/types";

interface FundingLeadersPanelProps {
  exchanges: ExchangeFundingLeaders[];
  nowTimestamp: number;
  onOpenSymbol: (canonicalSymbol: string) => void;
}

interface FundingLeaderListProps {
  title: string;
  leaders: FundingLeader[];
  nowTimestamp: number;
  onOpenSymbol: (canonicalSymbol: string) => void;
}

function FundingLeaderList({
  title,
  leaders,
  nowTimestamp,
  onOpenSymbol,
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
            return (
              <article key={`${leader.exchange}-${leader.exchange_symbol}`} className="funding-item">
                <div className="funding-item-top">
                  <button type="button" className="leader-open-button" onClick={() => onOpenSymbol(leader.canonical_symbol)}>
                    <strong>{leader.canonical_symbol}</strong>
                    <span className={leader.funding_rate >= 0 ? "positive" : "negative"}>
                      {formatPct(leader.funding_rate * 100, 3)}
                    </span>
                  </button>
                </div>

                <div className="subtle">{leader.exchange_symbol}</div>

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
  nowTimestamp,
  onOpenSymbol,
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
            <span className="subtle">Open overview, scan leaders, and jump straight to the exchange.</span>
          </div>

          <div className="funding-lists-grid">
            <FundingLeaderList
              title="Top Positive Rates"
              leaders={exchange.top_positive}
              nowTimestamp={nowTimestamp}
              onOpenSymbol={onOpenSymbol}
            />
            <FundingLeaderList
              title="Top Negative Rates"
              leaders={exchange.top_negative}
              nowTimestamp={nowTimestamp}
              onOpenSymbol={onOpenSymbol}
            />
          </div>
        </article>
      ))}
    </section>
  );
}
