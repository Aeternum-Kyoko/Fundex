import type { OpportunityHistoryPoint } from "../lib/types";

const SERIES_CONFIG = [
  {
    key: "spread_rate" as const,
    label: "Spread %",
    color: "#7ee0c3",
    transform: (point: OpportunityHistoryPoint) => point.spread_rate * 100,
  },
  {
    key: "net_apr_percent" as const,
    label: "Net APR %",
    color: "#8ab4ff",
    transform: (point: OpportunityHistoryPoint) => point.net_apr_percent,
  },
  {
    key: "confidence_score" as const,
    label: "Confidence",
    color: "#ffca7a",
    transform: (point: OpportunityHistoryPoint) => point.confidence_score * 100,
  },
];

function buildPolyline(values: number[], width: number, height: number, min: number, max: number) {
  const spread = max - min || 1;
  return values
    .map((value, index) => {
      const x = (index / Math.max(values.length - 1, 1)) * width;
      const y = height - ((value - min) / spread) * height;
      return `${x},${y}`;
    })
    .join(" ");
}

export function OpportunityHistoryChart({ points }: { points: OpportunityHistoryPoint[] }) {
  if (points.length < 2) {
    return <div className="chart-empty subtle">Spread, APR, and confidence history will appear here after more polling cycles.</div>;
  }

  const width = 760;
  const height = 150;

  return (
    <div className="comparison-metric-chart-grid">
      {SERIES_CONFIG.map((series) => {
        const values = points.map((point) => series.transform(point));
        const min = Math.min(...values);
        const max = Math.max(...values);
        const latest = values.length ? values[values.length - 1] : undefined;

        return (
          <div className="chart-card comparison-metric-card" key={series.key}>
            <div className="chart-meta comparison-chart-meta">
              <strong>{series.label}</strong>
              <span className="subtle">{latest == null ? "n/a" : latest.toFixed(2)}</span>
            </div>
            <svg viewBox={`0 0 ${width} ${height}`} className="history-chart comparison-history-chart" preserveAspectRatio="none">
              <polyline
                fill="none"
                stroke={series.color}
                strokeWidth="3"
                points={buildPolyline(values, width, height, min, max)}
              />
            </svg>
          </div>
        );
      })}
    </div>
  );
}
