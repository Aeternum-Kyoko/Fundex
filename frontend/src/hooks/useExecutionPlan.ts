import { useEffect, useState } from "react";
import type { ExecutionPlanResponse } from "../lib/execution-types";

const API_BASE = import.meta.env.VITE_API_URL ?? "/api";

export function useExecutionPlan(canonicalSymbol: string | null, enabled = true, selectedExchanges: string[] = []) {
  const [plan, setPlan] = useState<ExecutionPlanResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const exchangeQuery = selectedExchanges.join(",");

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      if (!canonicalSymbol || !enabled) {
        setPlan(null);
        setError(null);
        return;
      }

      setPlan(null);
      setError(null);
      setLoading(true);
      try {
        const exchangeSuffix = exchangeQuery ? `&exchanges=${encodeURIComponent(exchangeQuery)}` : "";
        const response = await fetch(
          `${API_BASE}/opportunities/${encodeURIComponent(canonicalSymbol)}/execution-plan?notional_usd=1000&leverage=2&holding_periods=1&basis_risk_buffer_percent=0.35${exchangeSuffix}`,
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
  }, [canonicalSymbol, enabled, exchangeQuery]);

  return { plan, loading, error };
}
