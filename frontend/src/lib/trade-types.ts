import type { ExchangeName } from "./types";

export interface TradeCredentialInput {
  exchange: ExchangeName;
  api_key: string;
  api_secret: string;
  extra?: Record<string, string>;
}

export interface TradeScheduleRequest {
  entry_seconds_before_funding: number;
  exit_seconds_after_funding: number;
}

export interface TradeCreateRequest {
  canonical_symbol: string;
  selected_exchanges: ExchangeName[];
  mode: "paper" | "live";
  scenario: "best" | "reverse";
  capital_usd: number;
  leverage: number;
  leverage_overrides?: Partial<Record<ExchangeName, number>>;
  holding_periods: number;
  basis_risk_buffer_percent: number;
  schedule: TradeScheduleRequest;
  credentials: TradeCredentialInput[];
}

export interface TradeCredentialVerificationRequest {
  required_exchanges: ExchangeName[];
  credentials: TradeCredentialInput[];
}

export interface TradeCredentialVerificationResult {
  exchange: ExchangeName;
  ok: boolean;
  message: string;
  wallet_balance_usd?: number | null;
  wallet_balance_note?: string | null;
}

export interface TradeCredentialVerificationResponse {
  ok: boolean;
  checked_at: string;
  results: TradeCredentialVerificationResult[];
}

export interface TradeEvent {
  at: string;
  phase: string;
  message: string;
  level: "info" | "warning" | "error";
}

export interface TradeLegExecution {
  exchange: ExchangeName;
  display_name: string;
  exchange_symbol: string;
  side: "buy" | "sell";
  reference_price: number;
  estimated_quantity: number;
  leverage: number;
  max_leverage: number | null;
  notional_usd: number;
  initial_margin_usd: number;
  trade_url: string;
  live_supported: boolean;
  support_note: string | null;
  status: "pending" | "submitted" | "filled" | "closed" | "failed" | "skipped";
  entry_order_id: string | null;
  exit_order_id: string | null;
  entry_fill_price: number | null;
  exit_fill_price: number | null;
  raw_entry_response: Record<string, unknown> | null;
  raw_exit_response: Record<string, unknown> | null;
}

export interface TradeSessionResponse {
  id: string;
  canonical_symbol: string;
  mode: "paper" | "live";
  scenario: "best" | "reverse";
  status: "armed" | "entering" | "entered" | "exiting" | "completed" | "failed" | "cancelled";
  current_phase: string;
  created_at: string;
  updated_at: string;
  pair_funding_time: string | null;
  scheduled_entry_at: string | null;
  scheduled_exit_at: string | null;
  cancellable_until: string | null;
  capital_input_usd: number;
  leverage: number;
  holding_periods: number;
  expected_net_pnl_usd: number;
  expected_funding_pnl_usd: number;
  estimated_total_fees_usd: number;
  expected_net_return_on_capital_percent: number;
  realized_price_pnl_usd: number | null;
  realized_funding_pnl_usd: number | null;
  realized_total_fees_usd: number | null;
  realized_net_pnl_usd: number | null;
  warnings: string[];
  events: TradeEvent[];
  long_leg: TradeLegExecution;
  short_leg: TradeLegExecution;
}
