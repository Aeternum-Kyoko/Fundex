import type { OpportunityHistoryPoint } from "../lib/types";

function buildPoints(points: OpportunityHistoryPoint[], width: number, height: number) {
  if (!points.length) {
    return "";
  }

  const values = points.map((point) => point.net_apr_percent);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const spread = max - min || 1;

  return points
    .map((point, index) => {
      const x = (index / Math.max(points.length - 1, 1)) * width;
      const y = height - ((point.net_apr_percent - min) / spread) * height;
      return `${x},${y}`;
    })
    .join(" ");
}

export function HistoryChart({ points }: { points: OpportunityHistoryPoint[] }) {
  if (!points.length) {
    return <div className="chart-empty subtle">History will appear here after a few polling cycles.</div>;
  }

  const polylinePoints = buildPoints(points, 520, 180);
  const latest = points[points.length - 1];

  return (
    <div className="chart-card">
      <div className="chart-meta">
        <strong>{latest.net_apr_percent.toFixed(2)}% net APR</strong>
        <span className="subtle">{points.length} persisted points</span>
      </div>
      <svg viewBox="0 0 520 180" className="history-chart" preserveAspectRatio="none">
        <polyline fill="none" stroke="rgba(85,230,165,0.25)" strokeWidth="10" points={polylinePoints} />
        <polyline fill="none" stroke="#55e6a5" strokeWidth="3" points={polylinePoints} />
      </svg>
    </div>
  );
}

