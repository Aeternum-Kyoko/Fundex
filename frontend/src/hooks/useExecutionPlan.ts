import { useEffect, useState } from "react";
import type { ExecutionPlanResponse } from "../lib/execution-types";

const API_BASE = import.meta.env.VITE_API_URL ?? "/api";
// Stable default: a fresh {} per render would re-trigger the fetch effect forever.
const NO_OVERRIDES: Record<string, number> = {};

interface ExecutionPlanOptions {
  capitalUsd?: number;
  leverage?: number;
  leverageByExchange?: Record<string, number>;
  holdingPeriods?: number;
  reverse?: boolean;
  strategy?: "capture" | "hold";
}

export function useExecutionPlan(
  canonicalSymbol: string | null,
  enabled = true,
  selectedExchanges: string[] = [],
  options: ExecutionPlanOptions = {},
) {
  const [plan, setPlan] = useState<ExecutionPlanResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const exchangeQuery = selectedExchanges.join(",");
  const capitalUsd = options.capitalUsd ?? 1000;
  const leverage = options.leverage ?? 2;
  const leverageByExchange = options.leverageByExchange ?? NO_OVERRIDES;
  const holdingPeriods = options.holdingPeriods ?? 1;
  const reverse = options.reverse ?? false;
  const strategy = options.strategy ?? "hold";

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      if (!canonicalSymbol || !enabled) {
        setPlan(null);
        setError(null);
        setLoading(false);
        return;
      }

      setError(null);
      setLoading(true);
      try {
        const exchangeSuffix = exchangeQuery ? `&exchanges=${encodeURIComponent(exchangeQuery)}` : "";
        const reverseSuffix = `${reverse ? "&reverse=true" : ""}&strategy=${strategy}`;
        const leverageOverrideEntries = Object.entries(leverageByExchange).filter(([, value]) => Number.isFinite(value) && value >= 1);
        const leverageOverrideSuffix = leverageOverrideEntries.length
          ? `&leverage_overrides=${encodeURIComponent(JSON.stringify(Object.fromEntries(leverageOverrideEntries)))}`
          : "";
        const response = await fetch(
          `${API_BASE}/opportunities/${encodeURIComponent(canonicalSymbol)}/execution-plan?capital_usd=${encodeURIComponent(capitalUsd)}&leverage=${encodeURIComponent(leverage)}&holding_periods=${encodeURIComponent(holdingPeriods)}&basis_risk_buffer_percent=0.35${reverseSuffix}${exchangeSuffix}${leverageOverrideSuffix}`,
        );
        if (!response.ok) {
          throw new Error("Failed to load execution helper.");
        }

        const payload = (await response.json()) as ExecutionPlanResponse;
        if (!cancelled) {
          setPlan(payload);
          setError(null);
        }
      } catch (loadError) {
        if (!cancelled) {
          setPlan(null);
          setError(loadError instanceof Error ? loadError.message : "Failed to load execution helper.");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [canonicalSymbol, enabled, exchangeQuery, capitalUsd, leverage, leverageByExchange, holdingPeriods, reverse, strategy]);

  return { plan, loading, error };
}
