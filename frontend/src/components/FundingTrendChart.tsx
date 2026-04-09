import type { FundingTrendSeries } from "../lib/types";

const SERIES_COLORS = ["#7ee0c3", "#8ab4ff", "#ffca7a", "#ff8a8a"];
const EXCHANGE_NAMES: Record<string, string> = {
  binance: "Binance",
  delta: "Delta Exchange India",
  coindcx: "CoinDCX",
  coinswitch: "CoinSwitch",
};

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

export function FundingTrendChart({ series }: { series: FundingTrendSeries[] }) {
  const filteredSeries = series.filter((entry) => entry.points.length > 1);
  if (!filteredSeries.length) {
    return <div className="chart-empty subtle">Funding history will appear here after a few polling cycles.</div>;
  }

  const width = 760;
  const height = 240;
  const allValues = filteredSeries.flatMap((entry) => entry.points.map((point) => point.funding_rate * 100));
  const min = Math.min(...allValues);
  const max = Math.max(...allValues);

  return (
    <div className="chart-card comparison-chart-card">
      <div className="chart-meta comparison-chart-meta">
        <strong>Funding history by exchange</strong>
        <span className="subtle">{filteredSeries.length} live series</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="history-chart comparison-history-chart" preserveAspectRatio="none">
        {filteredSeries.map((entry, index) => {
          const values = entry.points.map((point) => point.funding_rate * 100);
          return (
            <polyline
              key={`${entry.exchange}-${entry.canonical_symbol}`}
              fill="none"
              stroke={SERIES_COLORS[index % SERIES_COLORS.length]}
              strokeWidth="3"
              points={buildPolyline(values, width, height, min, max)}
            />
          );
        })}
      </svg>
      <div className="comparison-legend">
        {filteredSeries.map((entry, index) => (
          <div className="comparison-legend-item" key={`${entry.exchange}-legend`}>
            <span
              className="comparison-legend-swatch"
              style={{ backgroundColor: SERIES_COLORS[index % SERIES_COLORS.length] }}
            />
            <span>{EXCHANGE_NAMES[entry.exchange] ?? entry.exchange}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
