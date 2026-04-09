import type { ArbitrageOpportunity, ExchangeName, FundingSettlementItem, SymbolComparisonExchangeSnapshot } from "./types";

export function formatPct(value: number, digits = 2) {
  return `${value.toFixed(digits)}%`;
}

export function formatFundingRate(value: number | null | undefined, digits = 3) {
  if (value == null) {
    return "n/a";
  }
  if (Math.abs(value) < 0.000005) {
    return "flat";
  }
  return formatPct(value * 100, digits);
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

export function exchangeToneClass(exchange: ExchangeName) {
  switch (exchange) {
    case "binance":
      return "exchange-binance";
    case "delta":
      return "exchange-delta";
    case "coindcx":
      return "exchange-coindcx";
    case "coinswitch":
      return "exchange-coinswitch";
    default:
      return "";
  }
}

export function exchangeLabel(exchange: ExchangeName) {
  switch (exchange) {
    case "binance":
      return "Binance";
    case "delta":
      return "Delta";
    case "coindcx":
      return "CoinDCX";
    case "coinswitch":
      return "CoinSwitch";
    default:
      return exchange;
  }
}

export function intervalBadge(intervalHours: number | null | undefined) {
  if (!intervalHours) {
    return "n/a";
  }
  return `${intervalHours}h`;
}

export function qualityBadges(opportunity: ArbitrageOpportunity) {
  const badges: Array<{ label: string; tone: "positive" | "warning" | "danger" | "neutral" }> = [];

  if (opportunity.confidence_score >= 0.82 && (opportunity.combined_open_interest_usd ?? 0) >= 2_000_000) {
    badges.push({ label: "Strong", tone: "positive" });
  }
  if ((opportunity.combined_open_interest_usd ?? 0) < 1_000_000) {
    badges.push({ label: "Low OI", tone: "warning" });
  }
  if ((opportunity.max_leg_age_seconds ?? 999) > 30) {
    badges.push({ label: "Stale", tone: "danger" });
  }
  if (Math.abs(opportunity.spread_rate) >= 0.0035) {
    badges.push({ label: "High spread", tone: "neutral" });
  }
  if (!badges.length) {
    badges.push({ label: "Live", tone: "neutral" });
  }

  return badges.slice(0, 3);
}

export function settlementBucket(item: FundingSettlementItem, nowTimestamp = Date.now()) {
  const next = item.next_funding_time ? new Date(item.next_funding_time).getTime() : Number.POSITIVE_INFINITY;
  const remainingMinutes = (next - nowTimestamp) / 60_000;
  if (remainingMinutes <= 15) {
    return "due-soon";
  }
  if (remainingMinutes <= 60) {
    return "next-hour";
  }
  return "later";
}

export function explainNoPair(exchanges: SymbolComparisonExchangeSnapshot[]) {
  if (!exchanges.length) {
    return "This symbol is not in the live comparison set right now.";
  }
  const missingFundingTime = exchanges.some((exchange) => !exchange.next_funding_time);
  const stale = exchanges.every((exchange) => (exchange.data_age_seconds ?? 999) > 45);
  const missingOi = exchanges.every((exchange) => exchange.open_interest_usd == null);
  const rates = exchanges.map((exchange) => exchange.funding_rate);
  const spread = rates.length > 1 ? Math.max(...rates) - Math.min(...rates) : 0;

  if (stale) {
    return "Live snapshots are currently stale, so a clean pair is being withheld.";
  }
  if (missingFundingTime) {
    return "One or more exchanges are missing funding timing, so the pair timing is not trustworthy yet.";
  }
  if (missingOi) {
    return "Open interest is missing across the available venues, so the pair is present but quality is weak.";
  }
  if (spread <= 0) {
    return "There is no positive cross-exchange funding edge right now.";
  }
  return "The symbol is live, but the current spread does not clear the quality filters for a best pair.";
}
