import type { ArbitrageOpportunity, ExchangeName, FundingSettlementItem, SymbolComparisonExchangeSnapshot } from "./types";

export interface TrustBadge {
  label: string;
  tone: "positive" | "warning" | "danger" | "neutral";
}

export interface CapabilityBadge {
  label: string;
  tone: "positive" | "warning" | "neutral";
}

export function formatPct(value: number, digits = 2) {
  return `${value.toFixed(digits)}%`;
}

export function formatFundingRate(value: number | null | undefined, digits = 4) {
  if (value == null) {
    return "n/a";
  }
  if (Math.abs(value) < 0.0000005) {
    return "flat";
  }
  return formatPct(value * 100, digits);
}

export function formatUsd(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) {
    return "n/a";
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: value >= 1_000_000 ? "compact" : "standard",
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatPrice(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value) || value <= 0) {
    return "n/a";
  }
  // Keep at least 4 significant digits so sub-cent contracts are not rounded to $0.00.
  const digits = value >= 1000 ? 2 : value >= 1 ? 4 : Math.min(10, Math.max(4, 3 - Math.floor(Math.log10(value)) + 1));
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: digits })}`;
}

export function formatHours(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) {
    return "never (30d+)";
  }
  if (value < 1) {
    return `${Math.max(1, Math.round(value * 60))}m`;
  }
  if (value < 48) {
    return `${value.toFixed(value < 10 ? 1 : 0)}h`;
  }
  return `${(value / 24).toFixed(1)}d`;
}

export function horizonLabel(hours: number | null | undefined) {
  if (!hours) {
    return "hold";
  }
  return hours % 24 === 0 ? `${hours / 24}d` : `${hours}h`;
}

export function legInterval(leg: { funding_interval_hours?: number | null }, fallback: number) {
  return leg.funding_interval_hours ?? fallback;
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

  if (remainingMs <= 0) {
    return "due now";
  }

  const totalSeconds = Math.floor(remainingMs / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const padded = (value: number) => String(value).padStart(2, "0");

  if (days > 0) {
    return `${days}d ${padded(hours)}h ${padded(minutes)}m ${padded(seconds)}s`;
  }

  return `${padded(hours)}:${padded(minutes)}:${padded(seconds)}`;
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
    long_funding_rate_percent: (opportunity.long_leg.funding_rate * 100).toFixed(5),
    long_interval_hours: legInterval(opportunity.long_leg, opportunity.funding_interval_hours),
    short_funding_rate_percent: (opportunity.short_leg.funding_rate * 100).toFixed(5),
    short_interval_hours: legInterval(opportunity.short_leg, opportunity.funding_interval_hours),
    spread_per_8h_percent: (opportunity.spread_rate * 100).toFixed(5),
    gross_apr_percent: opportunity.gross_apr_percent.toFixed(2),
    total_cost_percent: opportunity.estimated_total_cost_percent.toFixed(4),
    holding_horizon_hours: opportunity.holding_horizon_hours,
    expected_funding_percent: opportunity.expected_funding_percent.toFixed(4),
    net_return_percent: opportunity.net_return_percent.toFixed(4),
    net_apr_percent: opportunity.net_apr_percent.toFixed(2),
    break_even_hours: opportunity.break_even_hours?.toFixed(2) ?? "",
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
    case "wazirx":
      return "exchange-wazirx";
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
    case "wazirx":
      return "WazirX";
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

export function formatLeverage(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value) || value <= 0) {
    return "n/a";
  }
  return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}x`;
}

const TRUST_TONE: Record<string, "positive" | "warning" | "danger"> = { high: "positive", medium: "warning", low: "danger" };

/** Badges come from the backend's trust checks so every screen agrees on the same thresholds. */
export function qualityBadges(opportunity: ArbitrageOpportunity) {
  const badges: Array<{ label: string; tone: "positive" | "warning" | "danger" | "neutral" }> = [getOpportunityTrustBadge(opportunity)];
  if (opportunity.slippage_source === "orderbook") {
    badges.push({ label: "Books measured", tone: "positive" });
  } else {
    badges.push({ label: "Est. slippage", tone: "neutral" });
  }
  const failing = opportunity.trust_checks.find((check) => check.status === "fail");
  if (failing) {
    badges.push({ label: failing.label, tone: "danger" });
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

export function getExchangeTrustBadge(exchange: SymbolComparisonExchangeSnapshot): TrustBadge {
  const isStale = exchange.data_age_seconds != null && exchange.data_age_seconds > 45;
  const isDelayed = exchange.data_age_seconds != null && exchange.data_age_seconds > 15;
  const missingCore = !exchange.next_funding_time || exchange.mark_price == null;
  const missingLiquidity = exchange.open_interest_usd == null;

  if (isStale) {
    return { label: "Stale feed", tone: "danger" };
  }
  if (missingCore) {
    return { label: "Partial feed", tone: "warning" };
  }
  if (isDelayed || missingLiquidity) {
    return { label: "Usable feed", tone: "warning" };
  }
  return { label: "Verified feed", tone: "positive" };
}

export function getExchangeTrustReasons(exchange: SymbolComparisonExchangeSnapshot): string[] {
  const reasons: string[] = [];

  if (exchange.data_age_seconds == null) {
    reasons.push("Feed age unavailable");
  } else if (exchange.data_age_seconds > 45) {
    reasons.push(`Stale by ${Math.round(exchange.data_age_seconds)}s`);
  } else if (exchange.data_age_seconds > 15) {
    reasons.push(`Delayed by ${Math.round(exchange.data_age_seconds)}s`);
  } else {
    reasons.push("Fresh timing");
  }

  if (exchange.next_funding_time) {
    reasons.push("Funding time confirmed");
  } else {
    reasons.push("Funding time missing");
  }

  if (exchange.mark_price != null) {
    reasons.push("Mark price confirmed");
  } else {
    reasons.push("Mark price missing");
  }

  if (exchange.open_interest_usd != null) {
    reasons.push("Liquidity visible");
  } else {
    reasons.push("Liquidity partial");
  }

  return reasons.slice(0, 4);
}

export function getExchangeCapabilityBadges(exchange: SymbolComparisonExchangeSnapshot): CapabilityBadge[] {
  const badges: CapabilityBadge[] = [];

  if (exchange.next_funding_time) {
    badges.push({ label: "Exact funding time", tone: "positive" });
  } else if (exchange.estimated_funding_rate != null) {
    badges.push({ label: "Estimated funding only", tone: "warning" });
  } else {
    badges.push({ label: "Funding timing partial", tone: "neutral" });
  }

  if (exchange.open_interest_usd != null) {
    badges.push({ label: "OI available", tone: "positive" });
  }

  if (exchange.max_leverage != null) {
    badges.push({ label: "Max leverage available", tone: "positive" });
  }

  return badges;
}

export function getOpportunityTrustBadge(opportunity: ArbitrageOpportunity): TrustBadge {
  const level = opportunity.trust_level ?? "medium";
  return { label: `${level[0].toUpperCase()}${level.slice(1)} trust`, tone: TRUST_TONE[level] ?? "neutral" };
}
