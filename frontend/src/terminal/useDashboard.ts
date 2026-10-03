import { useCallback, useEffect, useRef, useState } from "react";
import type { ArbitrageOpportunity, ExchangeFundingLeaders, ExchangeStatus, FundingSettlementItem } from "../lib/types";

const API_BASE = import.meta.env.VITE_API_URL ?? "/api";

export interface RateRow {
  exchange: string;
  rate: number;
  interval_hours: number;
  next_funding_time: string | null;
}

export interface DashboardData {
  version: number;
  generated_at: string;
  selected_exchanges: string[];
  available_exchanges: string[];
  holding_horizon_hours: number;
  reference_notional_usd: number;
  statuses: ExchangeStatus[];
  opportunities: ArbitrageOpportunity[];
  leaders: ExchangeFundingLeaders[];
  settlements: FundingSettlementItem[];
  rates?: Record<string, RateRow[]>;
}

export type LinkState = "live" | "polling" | "paused";

/** Live dashboard: a tiny change stream triggers one compressed snapshot fetch; polling is the fallback. */
export function useDashboard(selectedExchanges: string[], paused = false) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<LinkState>("polling");
  const [receivedAt, setReceivedAt] = useState<number | null>(null);
  const scope = selectedExchanges.join(",");
  const inFlight = useRef(false);
  const queued = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) {
      queued.current = true;
      return;
    }
    inFlight.current = true;
    try {
      const suffix = scope ? `?exchanges=${encodeURIComponent(scope)}` : "";
      const response = await fetch(`${API_BASE}/dashboard${suffix}`);
      if (!response.ok) {
        throw new Error(`The market service answered ${response.status}.`);
      }
      setData((await response.json()) as DashboardData);
      setReceivedAt(Date.now());
      setError(null);
    } catch (loadError) {
      setError(
        loadError instanceof TypeError
          ? "Can't reach the market service. Check that the backend is running."
          : loadError instanceof Error
            ? loadError.message
            : "Loading market data failed.",
      );
    } finally {
      inFlight.current = false;
      if (queued.current) {
        queued.current = false;
        void load();
      }
    }
  }, [scope]);

  useEffect(() => {
    void load();
    if (paused) {
      setLink("paused" as LinkState);
      return;
    }
    let source: EventSource | null = null;
    let pollTimer: number | null = null;
    let lastVersion = -1;

    const startPolling = () => {
      setLink("polling");
      if (pollTimer === null) {
        pollTimer = window.setInterval(() => void load(), 8000);
      }
    };

    if (typeof EventSource !== "undefined") {
      source = new EventSource(`${API_BASE}/stream`);
      source.addEventListener("version", (event) => {
        setLink("live");
        if (pollTimer !== null) {
          window.clearInterval(pollTimer);
          pollTimer = null;
        }
        const version = JSON.parse((event as MessageEvent).data).version as number;
        if (version !== lastVersion) {
          lastVersion = version;
          void load();
        }
      });
      source.onerror = () => startPolling();
    } else {
      startPolling();
    }

    const onVisible = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      source?.close();
      if (pollTimer !== null) window.clearInterval(pollTimer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load, paused]);

  return { data, error, link, receivedAt, refresh: load };
}
