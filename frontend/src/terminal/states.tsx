import type { ReactNode } from "react";

/** Placeholder rows shaped like the content that is loading, so the page doesn't jump when data lands. */
export function SkeletonRows({ count = 6, height = 56, label = "Loading" }: { count?: number; height?: number; label?: string }) {
  return (
    <div className="t-skel-stack" aria-busy="true" aria-label={label} role="status">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="t-skel" style={{ height, animationDelay: `${index * 70}ms` }} />
      ))}
    </div>
  );
}

export function SkeletonPanels({ count = 4 }: { count?: number }) {
  return (
    <div className="t-grid-leaders" aria-busy="true" role="status" aria-label="Loading">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="t-panel">
          <div className="t-skel t-skel-line" style={{ width: "40%" }} />
          {Array.from({ length: 5 }, (_, row) => (
            <div key={row} className="t-skel t-skel-line" style={{ animationDelay: `${row * 80}ms` }} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function ErrorState({ message, onRetry, children }: { message: string; onRetry?: () => void; children?: ReactNode }) {
  return (
    <div className="t-empty" role="alert">
      <strong>Something went wrong</strong>
      {message}
      {children}
      {onRetry ? (
        <div style={{ marginTop: 14 }}>
          <button type="button" className="t-btn" onClick={onRetry}>
            Try again
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="t-empty">
      <strong>{title}</strong>
      {body}
    </div>
  );
}
