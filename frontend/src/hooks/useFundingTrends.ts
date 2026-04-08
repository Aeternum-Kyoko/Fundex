import { useEffect, useMemo, useState } from "react";
import type { FundingTrendSeries, FundingTrendsResponse } from "../lib/types";

const API_BASE = import.meta.env.VITE_API_URL ?? "/api";

export function useFundingTrends(symbols: string[], limit = 16) {
  const [series, setSeries] = useState<FundingTrendSeries[]>([]);
  const [loading, setLoading] = useState(false);

  const normalizedSymbols = useMemo(
    () => Array.from(new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))).slice(0, 20),
    [symbols],
  );

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      if (!normalizedSymbols.length) {
        setSeries([]);
        return;
      }

      setLoading(true);
      try {
        const params = new URLSearchParams({
          symbols: normalizedSymbols.join(","),
          exchanges: "binance,delta",
          limit: String(limit),
        });
        const response = await fetch(`${API_BASE}/exchanges/funding-trends?${params.toString()}`);
        if (!response.ok) {
          throw new Error("Failed to load funding trends.");
        }

        const payload = (await response.json()) as FundingTrendsResponse;
        if (!cancelled) {
          setSeries(payload.series);
        }
      } catch {
        if (!cancelled) {
          setSeries([]);
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
  }, [limit, normalizedSymbols]);

  return { series, loading };
}
