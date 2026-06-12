import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ExchangeFundingLeaders,
  ExchangeStatus,
  FundingLeadersResponse,
  FundingSettlementItem,
  FundingSettlementResponse,
  OpportunitiesResponse,
} from "../lib/types";
import { apiFetch } from "../lib/api";

const emptyResponse: OpportunitiesResponse = {
  phase: "monitor-only",
  total: 0,
  exchanges_in_backend: [],
  frontend_optional_exchanges: [],
  opportunities: [],
};

export function useMarketFeed(refreshIntervalMs = 5000, selectedExchanges: string[] = []) {
  const [data, setData] = useState<OpportunitiesResponse>(emptyResponse);
  const [statuses, setStatuses] = useState<ExchangeStatus[]>([]);
  const [fundingLeaders, setFundingLeaders] = useState<ExchangeFundingLeaders[]>([]);
  const [fundingSettlements, setFundingSettlements] = useState<FundingSettlementItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);

  const exchangeQuery = selectedExchanges.join(",");

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const suffix = exchangeQuery ? `?exchanges=${encodeURIComponent(exchangeQuery)}` : "";
      const [statusResponse, opportunitiesResponse, fundingLeadersResponse, fundingSettlementsResponse] = await Promise.all([
        apiFetch("/exchanges/status"),
        apiFetch(`/arbitrage-opportunities${suffix}`),
        apiFetch(`/exchanges/funding-leaders${suffix}`),
        apiFetch(`/exchanges/funding-settlements${suffix}`),
      ]);

      if (!statusResponse.ok || !opportunitiesResponse.ok || !fundingLeadersResponse.ok || !fundingSettlementsResponse.ok) {
        throw new Error("Failed to fetch market data.");
      }

      const [statusPayload, opportunitiesPayload, fundingLeadersPayload, fundingSettlementsPayload] = (await Promise.all([
        statusResponse.json(),
        opportunitiesResponse.json(),
        fundingLeadersResponse.json(),
        fundingSettlementsResponse.json(),
      ])) as [ExchangeStatus[], OpportunitiesResponse, FundingLeadersResponse, FundingSettlementResponse];

      setStatuses(statusPayload);
      setData(opportunitiesPayload);
      setFundingLeaders(fundingLeadersPayload.exchanges);
      setFundingSettlements(fundingSettlementsPayload.items);
      setLastUpdatedAt(new Date().toISOString());
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to fetch market data.");
    } finally {
      setIsLoading(false);
    }
  }, [exchangeQuery]);

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
      fundingSettlements,
      error,
      isLoading,
      lastUpdatedAt,
      refresh: load,
    }),
    [data, statuses, fundingLeaders, fundingSettlements, error, isLoading, lastUpdatedAt, load],
  );
}
