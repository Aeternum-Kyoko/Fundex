export type ExchangeName = "binance" | "delta" | "coindcx" | "coinswitch" | "wazirx";

export interface TrustCheck {
  key: string;
  label: string;
  status: "pass" | "warn" | "fail" | "info";
  detail: string;
}

export type TrustLevel = "high" | "medium" | "low";

export interface CaptureLeg {
  exchange: ExchangeName;
  display_name: string;
  exchange_symbol: string;
  funding_rate: number;
  funding_interval_hours: number;
  next_funding_time: string | null;
  settles_in_window: boolean;
  /** Funding this leg pays you at the captured settlement (fraction of notional; negative = you pay). */
  payment: number;
  taker_fee_bps: number;
  slippage_round_trip_percent: number;
  slippage_measured: boolean;
  trade_url: string;
}

/** Enter just before the next settlement, collect it, exit right after. */
export interface CaptureSetup {
  settles_at: string;
  long_leg: CaptureLeg;
  short_leg: CaptureLeg;
  settling: "both" | "long" | "short";
  capture_percent: number;
  fee_percent: number;
  slippage_percent: number;
  cost_percent: number;
  net_percent: number;
  data_trust_level: TrustLevel;
}

export interface OpportunityLeg {
  exchange: ExchangeName;
  display_name: string;
  exchange_symbol: string;
  funding_rate: number;
  max_leverage: number | null;
  mark_price: number | null;
  open_interest_usd: number | null;
  volume_24h: number | null;
  taker_fee_bps: number;
  next_funding_time: string | null;
  funding_interval_hours?: number | null;
  funding_rate_hourly?: number | null;
  interval_source?: string | null;
  slippage_round_trip_percent?: number | null;
  depth_fillable?: boolean | null;
  depth_measured_at?: string | null;
  top_of_book_spread_percent?: number | null;
  trade_url: string;
  best_bid_size: number | null;
  best_ask_size: number | null;
}

export interface ArbitrageOpportunity {
  canonical_symbol: string;
  base_asset: string;
  quote_asset: string;
  long_leg: OpportunityLeg;
  short_leg: OpportunityLeg;
  /** Spread per 8 hours after normalising each leg to an hourly rate. */
  spread_rate: number;
  spread_rate_hourly: number;
  /** Shortest settlement interval of the two legs. */
  funding_interval_hours: number;
  gross_apr_percent: number;
  /** Annualised net return for a `holding_horizon_hours` hold, costs paid once. */
  net_apr_percent: number;
  estimated_round_trip_fee_percent: number;
  estimated_slippage_percent: number;
  estimated_total_cost_percent: number;
  holding_horizon_hours: number;
  expected_funding_percent: number;
  net_return_percent: number;
  break_even_hours: number | null;
  slippage_source: "orderbook" | "mixed" | "estimate";
  reference_notional_usd: number;
  trust_level: TrustLevel;
  trust_checks: TrustCheck[];
  capture: CaptureSetup | null;
  combined_open_interest_usd: number | null;
  price_dislocation_percent: number | null;
  max_leg_age_seconds?: number | null;
  confidence_score: number;
  warnings: string[];
  updated_at: string;
}

export interface ExchangeStatus {
  exchange: ExchangeName;
  display_name: string;
  enabled: boolean;
  configured: boolean;
  healthy: boolean;
  last_success_at: string | null;
  last_error: string | null;
  snapshot_count: number;
}

export interface OpportunitiesResponse {
  phase: "monitor-only";
  total: number;
  exchanges_in_backend: ExchangeName[];
  frontend_optional_exchanges: ExchangeName[];
  opportunities: ArbitrageOpportunity[];
}

export interface FundingLeader {
  exchange: ExchangeName;
  display_name: string;
  canonical_symbol: string;
  exchange_symbol: string;
  base_asset: string;
  funding_rate: number;
  funding_interval_hours?: number;
  max_leverage: number | null;
  next_funding_time: string | null;
  mark_price: number | null;
  open_interest_usd: number | null;
  trade_url: string;
}

export interface ExchangeFundingLeaders {
  exchange: ExchangeName;
  display_name: string;
  top_positive: FundingLeader[];
  top_negative: FundingLeader[];
}

export interface FundingLeadersResponse {
  total_exchanges: number;
  exchanges: ExchangeFundingLeaders[];
}

export interface FundingSettlementItem {
  exchange: ExchangeName;
  display_name: string;
  canonical_symbol: string;
  exchange_symbol: string;
  funding_rate: number;
  funding_interval_hours: number;
  max_leverage: number | null;
  next_funding_time: string | null;
  mark_price: number | null;
  open_interest_usd: number | null;
  trade_url: string;
}

export interface FundingSettlementResponse {
  total: number;
  items: FundingSettlementItem[];
}

export interface FundingTrendPoint {
  recorded_at: string;
  funding_rate: number;
}

export interface FundingTrendSeries {
  canonical_symbol: string;
  exchange: ExchangeName;
  points: FundingTrendPoint[];
}

export interface FundingTrendsResponse {
  total_series: number;
  series: FundingTrendSeries[];
}

export interface SymbolComparisonExchangeSnapshot {
  exchange: ExchangeName;
  display_name: string;
  exchange_symbol: string;
  funding_rate: number;
  estimated_funding_rate: number | null;
  funding_interval_hours: number;
  max_leverage: number | null;
  mark_price: number | null;
  open_interest_usd: number | null;
  volume_24h: number | null;
  next_funding_time: string | null;
  maker_fee_bps: number;
  taker_fee_bps: number;
  trade_url: string;
  data_age_seconds: number | null;
}

export interface SymbolComparisonResponse {
  canonical_symbol: string;
  base_asset: string;
  quote_asset: string;
  total_exchanges: number;
  requested_exchanges: ExchangeName[];
  exchanges: SymbolComparisonExchangeSnapshot[];
  best_opportunity: ArbitrageOpportunity | null;
}

export interface OpportunityHistoryPoint {
  recorded_at: string;
  net_apr_percent: number;
  gross_apr_percent: number;
  spread_rate: number;
  confidence_score: number;
}

export interface OpportunityHistoryResponse {
  canonical_symbol: string;
  total: number;
  points: OpportunityHistoryPoint[];
}
