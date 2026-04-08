import { useCallback, useEffect, useMemo, useState } from "react";
import type { ExchangeFundingLeaders, ExchangeStatus, FundingLeadersResponse, OpportunitiesResponse } from "../lib/types";

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
  const [fundingLeaders, setFundingLeaders] = useState<ExchangeFundingLeaders[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const [statusResponse, opportunitiesResponse, fundingLeadersResponse] = await Promise.all([
        fetch(`${API_BASE}/exchanges/status`),
        fetch(`${API_BASE}/arbitrage-opportunities`),
        fetch(`${API_BASE}/exchanges/funding-leaders`),
      ]);

      if (!statusResponse.ok || !opportunitiesResponse.ok || !fundingLeadersResponse.ok) {
        throw new Error("Failed to fetch market data.");
      }

      const [statusPayload, opportunitiesPayload, fundingLeadersPayload] = (await Promise.all([
        statusResponse.json(),
        opportunitiesResponse.json(),
        fundingLeadersResponse.json(),
      ])) as [ExchangeStatus[], OpportunitiesResponse, FundingLeadersResponse];

      setStatuses(statusPayload);
      setData(opportunitiesPayload);
      setFundingLeaders(fundingLeadersPayload.exchanges);
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
      fundingLeaders,
      error,
      isLoading,
      lastUpdatedAt,
      refresh: load,
    }),
    [data, statuses, fundingLeaders, error, isLoading, lastUpdatedAt, load],
  );
}
