import { useCallback, useEffect, useMemo, useState } from "react";
import type { ExchangeStatus, OpportunitiesResponse } from "../lib/types";

const API_BASE = import.meta.env.VITE_API_URL ?? "/api";

const emptyResponse: OpportunitiesResponse = {
  phase: "monitor-only",
  total: 0,
  exchanges_in_backend: [],
  frontend_optional_exchanges: [],
  opportunities: [],
};

export function useMarketFeed(refreshIntervalMs = 5000) {
  const [data, setData] = useState<OpportunitiesResponse>(emptyResponse);
  const [statuses, setStatuses] = useState<ExchangeStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const [statusResponse, opportunitiesResponse] = await Promise.all([
        fetch(`${API_BASE}/exchanges/status`),
        fetch(`${API_BASE}/arbitrage-opportunities`),
      ]);

      if (!statusResponse.ok || !opportunitiesResponse.ok) {
        throw new Error("Failed to fetch market data.");
      }

      const [statusPayload, opportunitiesPayload] = (await Promise.all([
        statusResponse.json(),
        opportunitiesResponse.json(),
      ])) as [ExchangeStatus[], OpportunitiesResponse];

      setStatuses(statusPayload);
      setData(opportunitiesPayload);
      setLastUpdatedAt(new Date().toISOString());
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to fetch market data.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let intervalId: number | null = null;

    const guardedLoad = async () => {
      if (cancelled) {
        return;
      }
      await load();
    };

    void guardedLoad();

    if (refreshIntervalMs > 0) {
      intervalId = window.setInterval(() => {
        void guardedLoad();
      }, refreshIntervalMs);
    }

    return () => {
      cancelled = true;
      if (intervalId) {
        window.clearInterval(intervalId);
      }
    };
  }, [load, refreshIntervalMs]);

  return useMemo(
    () => ({
      data,
      statuses,
      error,
      isLoading,
      lastUpdatedAt,
      refresh: load,
    }),
    [data, statuses, error, isLoading, lastUpdatedAt, load],
  );
}
