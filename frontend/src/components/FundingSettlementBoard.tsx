import { formatCountdown, formatPct, formatUsd } from "../lib/monitor";
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

  return (
    <section className="panel settlement-panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Funding Settlement Board</p>
          <h2>Next funding events across exchanges</h2>
          <div className="subtle">Sorted by nearest settlement so you can see what is about to realize first.</div>
        </div>
        <div className="panel-note">{items.length} upcoming events</div>
      </div>

      <div className="settlement-grid">
        {items.map((item) => (
          <article className="settlement-card" key={`${item.exchange}-${item.exchange_symbol}`}>
            <div className="settlement-card-top">
              <button type="button" className="leader-open-button settlement-open-button" onClick={() => onOpenSymbol(item.canonical_symbol)}>
                <strong>{item.canonical_symbol}</strong>
              </button>
              <span className={item.funding_rate >= 0 ? "phase-pill" : "overview-badge negative-badge"}>
                {formatPct(item.funding_rate * 100, 3)}
              </span>
            </div>

            <div className="subtle">
              {item.display_name} · {item.exchange_symbol}
            </div>

            <div className="settlement-metrics">
              <div>
                <span className="subtle">Time left</span>
                <strong>{formatCountdown(item.next_funding_time, nowTimestamp)}</strong>
              </div>
              <div>
                <span className="subtle">Funding cycle</span>
                <strong>{item.funding_interval_hours}h</strong>
              </div>
              <div>
                <span className="subtle">Mark price</span>
                <strong>{formatUsd(item.mark_price)}</strong>
              </div>
              <div>
                <span className="subtle">Open interest</span>
                <strong>{formatUsd(item.open_interest_usd)}</strong>
              </div>
            </div>

            <div className="funding-item-footer">
              <button type="button" className="inline-link button-link" onClick={() => onOpenSymbol(item.canonical_symbol)}>
                Open overview
              </button>
              <a href={item.trade_url} target="_blank" rel="noreferrer" className="inline-link">
                Open exchange
              </a>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
