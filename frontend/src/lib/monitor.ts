import type { ArbitrageOpportunity } from "./types";

export function formatPct(value: number, digits = 2) {
  return `${value.toFixed(digits)}%`;
}

export function formatUsd(value: number | null) {
  if (!value) {
    return "n/a";
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: value >= 1_000_000 ? "compact" : "standard",
    maximumFractionDigits: 2,
  }).format(value);
}

export function getNextFundingTime(opportunity: ArbitrageOpportunity): string | null {
  const timestamps = [opportunity.long_leg.next_funding_time, opportunity.short_leg.next_funding_time]
    .filter((value): value is string => Boolean(value))
    .map((value) => new Date(value).getTime())
    .filter((value) => Number.isFinite(value));

  if (!timestamps.length) {
    return null;
  }

  return new Date(Math.min(...timestamps)).toISOString();
}

export function formatCountdown(timestamp: string | null, nowTimestamp = Date.now()) {
  if (!timestamp) {
    return "n/a";
  }

  const remainingMs = new Date(timestamp).getTime() - nowTimestamp;
  if (!Number.isFinite(remainingMs)) {
    return "n/a";
  }

  if (remainingMs <= 60_000) {
    return "due now";
  }

  const totalMinutes = Math.floor(remainingMs / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return `${days}d ${hours}h`;
  }

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  return `${minutes}m`;
}

export function formatTimestamp(value: string | null) {
  if (!value) {
    return "n/a";
  }

  return new Date(value).toLocaleString();
}

export function buildOpportunityCsv(opportunities: ArbitrageOpportunity[]) {
  const rows = opportunities.map((opportunity) => ({
    symbol: opportunity.canonical_symbol,
    base_asset: opportunity.base_asset,
    lower_funding_exchange: opportunity.long_leg.display_name,
    higher_funding_exchange: opportunity.short_leg.display_name,
    spread_percent: (opportunity.spread_rate * 100).toFixed(3),
    net_apr_percent: opportunity.net_apr_percent.toFixed(2),
    gross_apr_percent: opportunity.gross_apr_percent.toFixed(2),
    confidence_score: (opportunity.confidence_score * 100).toFixed(0),
    next_funding_time: getNextFundingTime(opportunity) ?? "",
    combined_open_interest_usd: opportunity.combined_open_interest_usd ?? "",
    price_dislocation_percent: opportunity.price_dislocation_percent?.toFixed(3) ?? "",
    updated_at: opportunity.updated_at,
  }));

  if (!rows.length) {
    return "";
  }

  const headers = Object.keys(rows[0]);
  const escapeCell = (value: string | number) => `"${String(value).split('"').join('""')}"`;
  return [headers.join(","), ...rows.map((row) => headers.map((header) => escapeCell(row[header as keyof typeof row])).join(","))].join(
    "\n",
  );
}
