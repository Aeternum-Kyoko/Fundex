import { useEffect, useState } from "react";
import type { ExecutionPlanResponse } from "../lib/execution-types";

const API_BASE = import.meta.env.VITE_API_URL ?? "/api";

interface ExecutionPlanOptions {
  capitalUsd?: number;
  leverage?: number;
  holdingPeriods?: number;
  reverse?: boolean;
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
  const holdingPeriods = options.holdingPeriods ?? 1;
  const reverse = options.reverse ?? false;

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
        const reverseSuffix = reverse ? "&reverse=true" : "";
        const response = await fetch(
          `${API_BASE}/opportunities/${encodeURIComponent(canonicalSymbol)}/execution-plan?capital_usd=${encodeURIComponent(capitalUsd)}&leverage=${encodeURIComponent(leverage)}&holding_periods=${encodeURIComponent(holdingPeriods)}&basis_risk_buffer_percent=0.35${reverseSuffix}${exchangeSuffix}`,
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
  }, [canonicalSymbol, enabled, exchangeQuery, capitalUsd, leverage, holdingPeriods, reverse]);

  return { plan, loading, error };
}
