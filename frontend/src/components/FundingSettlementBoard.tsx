import { exchangeToneClass, formatCountdown, formatLeverage, formatPct, formatUsd, settlementBucket } from "../lib/monitor";
import type { FundingSettlementItem } from "../lib/types";

interface FundingSettlementBoardProps {
  items: FundingSettlementItem[];
  nowTimestamp: number;
  onOpenSymbol: (canonicalSymbol: string) => void;
}

export function FundingSettlementBoard({ items, nowTimestamp, onOpenSymbol }: FundingSettlementBoardProps) {
  if (!items.length) {
    return null;
  }

  const groups = [
    {
      key: "due-soon",
      title: "Due soon",
      description: "Funding about to realize first.",
      items: items.filter((item) => settlementBucket(item, nowTimestamp) === "due-soon"),
    },
    {
      key: "next-hour",
      title: "Next hour",
      description: "Contracts settling in the next hour.",
      items: items.filter((item) => settlementBucket(item, nowTimestamp) === "next-hour"),
    },
    {
      key: "later",
      title: "Later",
      description: "Upcoming events beyond the first hour.",
      items: items.filter((item) => settlementBucket(item, nowTimestamp) === "later"),
    },
  ];

  const visibleCount = groups.reduce((total, group) => total + group.items.length, 0);

  return (
    <section className="panel settlement-panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Funding Settlement Board</p>
          <h2>Next funding events across exchanges</h2>
          <div className="subtle">
            A tighter funding timeline so all settlement rows stay inside this section with their own scroll instead of pushing the main table lower.
          </div>
        </div>
        <div className="panel-note">{visibleCount} timeline rows shown</div>
      </div>

      <div className="settlement-timeline">
        {groups.map((group) => (
          <section className="settlement-column" key={group.key}>
            <div className="settlement-column-header">
              <div>
                <strong>{group.title}</strong>
                <div className="subtle">{group.description}</div>
              </div>
              <span className="timeline-count">{group.items.length}</span>
            </div>

            {group.items.length ? (
              <div className="settlement-grid settlement-grid-scroll">
                {group.items.map((item) => (
                  <article className="settlement-card settlement-row-card" key={`${item.exchange}-${item.exchange_symbol}`}>
                    <div className="settlement-row-main">
                      <div className="settlement-row-title">
                        <button
                          type="button"
                          className="leader-open-button settlement-open-button"
                          onClick={() => onOpenSymbol(item.canonical_symbol)}
                        >
                          <strong>{item.canonical_symbol}</strong>
                        </button>
                        <span className={`settlement-exchange-line ${exchangeToneClass(item.exchange)}`}>
                          {item.display_name} | {item.exchange_symbol}
                        </span>
                      </div>

                      <div className="settlement-row-metrics">
                        <div className="settlement-metric">
                          <span className="subtle">Time left</span>
                          <strong>{formatCountdown(item.next_funding_time, nowTimestamp)}</strong>
                        </div>
                        <div className="settlement-metric">
                          <span className="subtle">Cycle</span>
                          <strong>{item.funding_interval_hours}h</strong>
                        </div>
                        <div className="settlement-metric">
                          <span className="subtle">Max leverage</span>
                          <strong>{formatLeverage(item.max_leverage)}</strong>
                        </div>
                        <div className="settlement-metric">
                          <span className="subtle">Mark</span>
                          <strong>{formatUsd(item.mark_price)}</strong>
                        </div>
                        <div className="settlement-metric">
                          <span className="subtle">OI</span>
                          <strong>{formatUsd(item.open_interest_usd)}</strong>
                        </div>
                      </div>
                    </div>

                    <div className="settlement-row-actions">
                      <span className={item.funding_rate >= 0 ? "phase-pill" : "overview-badge negative-badge"}>
                        {formatPct(item.funding_rate * 100, 3)}
                      </span>
                      <div className="funding-item-footer settlement-footer">
                        <button type="button" className="inline-link button-link" onClick={() => onOpenSymbol(item.canonical_symbol)}>
                          Open overview
                        </button>
                        <a href={item.trade_url} target="_blank" rel="noreferrer" className="inline-link">
                          Open exchange
                        </a>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty-state compact-empty settlement-empty">
                <p>No contracts in this window.</p>
                <span>The next set of funding events is grouped into the other timeline columns.</span>
              </div>
            )}
          </section>
        ))}
      </div>
    </section>
  );
}
