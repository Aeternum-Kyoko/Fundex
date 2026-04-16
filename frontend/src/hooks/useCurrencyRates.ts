import { useEffect, useState } from "react";

interface CurrencyRatesState {
  rates: Record<string, number>;
  loading: boolean;
  error: string | null;
  date: string | null;
}

const DEFAULT_RATES: Record<string, number> = {
  USD: 1,
};

export function useCurrencyRates() {
  const [state, setState] = useState<CurrencyRatesState>({
    rates: DEFAULT_RATES,
    loading: true,
    error: null,
    date: null,
  });

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const primaryResponse = await fetch("https://open.er-api.com/v6/latest/USD");
        let resolvedRates: Record<string, number> | null = null;
        let resolvedDate: string | null = null;

        if (primaryResponse.ok) {
          const primaryPayload = (await primaryResponse.json()) as {
            result?: string;
            time_last_update_utc?: string;
            rates?: Record<string, number>;
          };

          if (primaryPayload.result === "success" && primaryPayload.rates) {
            resolvedRates = primaryPayload.rates;
            resolvedDate = primaryPayload.time_last_update_utc ?? null;
          }
        }

        if (!resolvedRates) {
          const fallbackResponse = await fetch("https://api.frankfurter.dev/v2/rates?base=USD");
          if (!fallbackResponse.ok) {
            throw new Error("Failed to load currency rates.");
          }

          const fallbackPayload = (await fallbackResponse.json()) as {
            date?: string;
            rates?: Record<string, number>;
          };

          resolvedRates = fallbackPayload.rates ?? null;
          resolvedDate = fallbackPayload.date ?? null;
        }

        if (!resolvedRates) {
          throw new Error("Failed to load currency rates.");
        }

        if (!cancelled) {
          setState({
            rates: {
              USD: 1,
              ...resolvedRates,
            },
            loading: false,
            error: null,
            date: resolvedDate,
          });
        }
      } catch (error) {
        if (!cancelled) {
          setState({
            rates: DEFAULT_RATES,
            loading: false,
            error: error instanceof Error ? error.message : "Failed to load currency rates.",
            date: null,
          });
        }
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
