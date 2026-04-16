import { useCallback, useEffect, useState } from "react";
import type { TradeCreateRequest, TradeSessionResponse } from "../lib/trade-types";

const API_BASE = import.meta.env.VITE_API_URL ?? "/api";
const TRADE_HISTORY_KEY = "arbradar-trade-history";
const TRADE_HISTORY_LIMIT = 40;

function getActiveTradeKey(scope: string) {
  return `arbradar-active-trade:${scope}`;
}

function readTradeHistory(): TradeSessionResponse[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(TRADE_HISTORY_KEY);
    return raw ? (JSON.parse(raw) as TradeSessionResponse[]) : [];
  } catch {
    return [];
  }
}

function writeTradeHistory(next: TradeSessionResponse[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(TRADE_HISTORY_KEY, JSON.stringify(next.slice(0, TRADE_HISTORY_LIMIT)));
}

function upsertTradeHistory(session: TradeSessionResponse) {
  const history = readTradeHistory();
  const next = [session, ...history.filter((item) => item.id !== session.id)];
  writeTradeHistory(next);
  return next;
}

export function useTradeSession(scope = "global") {
  const [session, setSession] = useState<TradeSessionResponse | null>(null);
  const [history, setHistory] = useState<TradeSessionResponse[]>(() => readTradeHistory());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeTradeKey = getActiveTradeKey(scope);

  const persistSessionState = useCallback(
    (payload: TradeSessionResponse) => {
      setSession(payload);
      setHistory(upsertTradeHistory(payload));
      if (typeof window === "undefined") return;
      if (["completed", "failed", "cancelled"].includes(payload.status)) {
        window.sessionStorage.removeItem(activeTradeKey);
      } else {
        window.sessionStorage.setItem(activeTradeKey, payload.id);
      }
    },
    [activeTradeKey],
  );

  const refreshSession = useCallback(async (sessionId: string) => {
    const response = await fetch(`${API_BASE}/trade/sessions/${encodeURIComponent(sessionId)}`);
    if (!response.ok) {
      throw new Error("Failed to refresh trade session.");
    }
    const payload = (await response.json()) as TradeSessionResponse;
    persistSessionState(payload);
    return payload;
  }, [persistSessionState]);

  const createSession = useCallback(async (payload: TradeCreateRequest) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/trade/sessions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const errorPayload = (await response.json().catch(() => null)) as { detail?: string } | null;
        throw new Error(errorPayload?.detail ?? "Failed to arm trade session.");
      }
      const created = (await response.json()) as TradeSessionResponse;
      persistSessionState(created);
      return created;
    } catch (createError) {
      const message = createError instanceof Error ? createError.message : "Failed to arm trade session.";
      setError(message);
      throw createError;
    } finally {
      setLoading(false);
    }
  }, [persistSessionState]);

  const cancelSession = useCallback(async (sessionId: string) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/trade/sessions/${encodeURIComponent(sessionId)}/cancel`, {
        method: "POST",
      });
      if (!response.ok) {
        const errorPayload = (await response.json().catch(() => null)) as { detail?: string } | null;
        throw new Error(errorPayload?.detail ?? "Failed to cancel trade session.");
      }
      const cancelled = (await response.json()) as TradeSessionResponse;
      persistSessionState(cancelled);
      return cancelled;
    } catch (cancelError) {
      const message = cancelError instanceof Error ? cancelError.message : "Failed to cancel trade session.";
      setError(message);
      throw cancelError;
    } finally {
      setLoading(false);
    }
  }, [persistSessionState]);

  const clearHistory = useCallback(() => {
    setHistory([]);
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(TRADE_HISTORY_KEY);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || session?.id) {
      return;
    }
    const activeSessionId = window.sessionStorage.getItem(activeTradeKey);
    if (!activeSessionId) {
      return;
    }
    void refreshSession(activeSessionId).catch(() => {
      window.sessionStorage.removeItem(activeTradeKey);
    });
  }, [activeTradeKey, refreshSession, session?.id]);

  useEffect(() => {
    if (!session?.id || ["completed", "failed", "cancelled"].includes(session.status)) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      void refreshSession(session.id).catch((pollError) => {
        setError(pollError instanceof Error ? pollError.message : "Failed to refresh trade session.");
      });
    }, 2000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [refreshSession, session?.id, session?.status]);

  return {
    session,
    history,
    loading,
    error,
    createSession,
    refreshSession,
    cancelSession,
    clearHistory,
  };
}
