import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../lib/api";
import type { FundingTrendSeries, FundingTrendsResponse } from "../lib/types";

export function useFundingTrends(symbols: string[], exchanges: string[], limit = 16) {
  const [series, setSeries] = useState<FundingTrendSeries[]>([]);
  const [loading, setLoading] = useState(false);

  const normalizedSymbols = useMemo(
    () => Array.from(new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))).slice(0, 20),
    [symbols],
  );
  const normalizedExchanges = useMemo(
    () => Array.from(new Set(exchanges.map((exchange) => exchange.trim().toLowerCase()).filter(Boolean))),
    [exchanges],
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
          exchanges: normalizedExchanges.join(","),
          limit: String(limit),
        });
        const response = await apiFetch(`/exchanges/funding-trends?${params.toString()}`);
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
  }, [limit, normalizedExchanges, normalizedSymbols]);

  return { series, loading };
}
