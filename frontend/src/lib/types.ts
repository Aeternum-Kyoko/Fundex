export type ExchangeName = "binance" | "delta" | "coindcx" | "coinswitch";

export interface OpportunityLeg {
  exchange: ExchangeName;
  display_name: string;
  exchange_symbol: string;
  funding_rate: number;
  mark_price: number | null;
  open_interest_usd: number | null;
  volume_24h: number | null;
  taker_fee_bps: number;
  next_funding_time: string | null;
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
  spread_rate: number;
  funding_interval_hours: number;
  gross_apr_percent: number;
  net_apr_percent: number;
  estimated_round_trip_fee_percent: number;
  estimated_slippage_percent: number;
  combined_open_interest_usd: number | null;
  price_dislocation_percent: number | null;
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
