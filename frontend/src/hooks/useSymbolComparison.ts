import { useEffect, useState } from "react";
import type { SymbolComparisonResponse } from "../lib/types";

const API_BASE = import.meta.env.VITE_API_URL ?? "/api";

export function useSymbolComparison(canonicalSymbol: string | null, selectedExchanges: string[] = [], strategy: "capture" | "hold" = "hold") {
  const [comparison, setComparison] = useState<SymbolComparisonResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const exchangeQuery = selectedExchanges.join(",");

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      if (!canonicalSymbol) {
        setComparison(null);
        setError("Missing symbol.");
        return;
      }

      setComparison(null);
      setError(null);
      setLoading(true);
      try {
        const suffix = `?strategy=${strategy}${exchangeQuery ? `&exchanges=${encodeURIComponent(exchangeQuery)}` : ""}`;
        const response = await fetch(`${API_BASE}/symbols/${encodeURIComponent(canonicalSymbol)}/comparison${suffix}`);
        if (!response.ok) {
          throw new Error("Failed to load symbol comparison.");
        }

        const payload = (await response.json()) as SymbolComparisonResponse;
        if (!cancelled) {
          setComparison(payload);
          setError(null);
        }
      } catch (loadError) {
        if (!cancelled) {
          setComparison(null);
          setError(loadError instanceof Error ? loadError.message : "Failed to load symbol comparison.");
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
  }, [canonicalSymbol, exchangeQuery, strategy]);

  return { comparison, loading, error };
}
