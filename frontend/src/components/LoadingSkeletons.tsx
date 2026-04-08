export function FundingLeadersSkeleton() {
  return (
    <section className="funding-leaders-grid" aria-hidden="true">
      {Array.from({ length: 2 }).map((_, exchangeIndex) => (
        <article className="overview-card funding-exchange-card skeleton-card" key={exchangeIndex}>
          <div className="skeleton-line skeleton-line-lg" />
          <div className="skeleton-line skeleton-line-md" />
          <div className="funding-lists-grid">
            {Array.from({ length: 2 }).map((__, listIndex) => (
              <section className="funding-list-card" key={listIndex}>
                <div className="skeleton-line skeleton-line-md" />
                <div className="skeleton-stack">
                  {Array.from({ length: 3 }).map((___, itemIndex) => (
                    <div className="skeleton-item" key={itemIndex}>
                      <div className="skeleton-line skeleton-line-md" />
                      <div className="skeleton-line skeleton-line-sm" />
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </article>
      ))}
    </section>
  );
}

export function OpportunityTableSkeleton() {
  return (
    <div className="table-shell skeleton-table" aria-hidden="true">
      <div className="skeleton-table-header">
        {Array.from({ length: 5 }).map((_, index) => (
          <div className="skeleton-line skeleton-line-sm" key={index} />
        ))}
      </div>
      <div className="skeleton-stack">
        {Array.from({ length: 7 }).map((_, index) => (
          <div className="skeleton-row" key={index}>
            <div className="skeleton-line skeleton-line-md" />
            <div className="skeleton-line skeleton-line-sm" />
            <div className="skeleton-line skeleton-line-sm" />
            <div className="skeleton-line skeleton-line-sm" />
          </div>
        ))}
      </div>
    </div>
  );
}
