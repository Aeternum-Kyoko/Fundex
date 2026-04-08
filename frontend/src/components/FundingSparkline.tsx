import type { FundingTrendPoint } from "../lib/types";

function buildPolyline(points: FundingTrendPoint[], width: number, height: number) {
  if (!points.length) {
    return "";
  }

  const values = points.map((point) => point.funding_rate);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const spread = max - min || 1;

  return points
    .map((point, index) => {
      const x = (index / Math.max(points.length - 1, 1)) * width;
      const y = height - ((point.funding_rate - min) / spread) * height;
      return `${x},${y}`;
    })
    .join(" ");
}

export function FundingSparkline({ points, positive }: { points: FundingTrendPoint[]; positive: boolean }) {
  if (points.length < 2) {
    return <div className="sparkline-placeholder" aria-hidden="true" />;
  }

  const stroke = positive ? "#7ee0c3" : "#ff7d7d";
  const glow = positive ? "rgba(126, 224, 195, 0.28)" : "rgba(255, 125, 125, 0.25)";
  const polyline = buildPolyline(points, 120, 30);

  return (
    <svg viewBox="0 0 120 30" className="funding-sparkline" preserveAspectRatio="none" aria-hidden="true">
      <polyline fill="none" stroke={glow} strokeWidth="7" points={polyline} />
      <polyline fill="none" stroke={stroke} strokeWidth="2.5" points={polyline} />
    </svg>
  );
}
