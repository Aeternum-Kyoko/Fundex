export interface ExecutionLegPlan {
  exchange: string;
  display_name: string;
  exchange_symbol: string;
  side: "buy" | "sell";
  reference_price: number;
  notional_usd: number;
  estimated_quantity: number;
  leverage: number;
  initial_margin_usd: number;
  taker_fee_percent: number;
  estimated_entry_fee_usd: number;
  estimated_exit_fee_usd: number;
  trade_url: string;
}

export interface ExecutionPlanResponse {
  phase: "phase-2-dry-run";
  scenario: "best" | "reverse";
  canonical_symbol: string;
  capital_input_usd: number | null;
  notional_usd: number;
  leverage: number;
  holding_periods: number;
  capital_required_usd: number;
  estimated_total_fees_usd: number;
  estimated_total_slippage_usd: number;
  estimated_funding_pnl_usd: number;
  estimated_basis_risk_reserve_usd: number;
  expected_net_pnl_usd: number;
  expected_net_return_on_capital_percent: number;
  confidence_score: number;
  warnings: string[];
  entry_steps: string[];
  exit_rules: string[];
  long_leg: ExecutionLegPlan;
  short_leg: ExecutionLegPlan;
}
