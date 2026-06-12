import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import type { OpportunityHistoryResponse } from "../lib/types";

export function useOpportunityHistory(canonicalSymbol: string | null, limit = 48) {
  const [history, setHistory] = useState<OpportunityHistoryResponse | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      if (!canonicalSymbol) {
        setHistory(null);
        return;
      }

      setLoading(true);
      try {
        const response = await apiFetch(`/opportunities/${encodeURIComponent(canonicalSymbol)}/history?limit=${limit}`);
        if (!response.ok) {
          throw new Error("Failed to load opportunity history.");
        }

        const payload = (await response.json()) as OpportunityHistoryResponse;
        if (!cancelled) {
          setHistory(payload);
        }
      } catch {
        if (!cancelled) {
          setHistory(null);
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
  }, [canonicalSymbol, limit]);

  return { points: history?.points ?? [], history, loading };
}
