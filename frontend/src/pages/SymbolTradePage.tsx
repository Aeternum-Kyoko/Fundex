import { jsPDF } from "jspdf";
import { useEffect, useMemo, useRef, useState } from "react";
import { useExecutionPlan } from "../hooks/useExecutionPlan";
import { useNow } from "../hooks/useNow";
import { useSymbolComparison } from "../hooks/useSymbolComparison";
import { useTradeSession } from "../hooks/useTradeSession";
import {
  exchangeLabel,
  exchangeToneClass,
  formatCountdown,
  formatFundingRate,
  formatLeverage,
  formatPct,
  formatPrice,
  formatTimestamp,
  formatUsd,
  getExchangeCapabilityBadges,
  getNextFundingTime,
} from "../lib/monitor";
import type { ArbitrageOpportunity, ExchangeName } from "../lib/types";
import { whoPays } from "../terminal/capture";
import { Dialog } from "../terminal/panels";
import { clockTime, Countdown } from "../terminal/primitives";
import type {
  TradeCredentialInput,
  TradeCredentialVerificationResponse,
  TradeLegExecution,
  TradeSessionResponse,
} from "../lib/trade-types";

const TRADE_CREDENTIALS_KEY = "arbradar-trade-credentials";
const PAPER_GUIDE_KEY = "arbradar-paper-guide-seen";
const DEFAULT_COINSWITCH_EXCHANGE = "EXCHANGE_2";
const CANCEL_LOCK_WINDOW_MINUTES = 10;
const API_BASE = import.meta.env.VITE_API_URL ?? "/api";

type TradeCredentialState = Record<string, { api_key: string; api_secret: string; extra?: Record<string, string> }>;
type VerificationState =
  | { status: "idle"; message: null; checkedAt: null; results: null }
  | { status: "checking"; message: string; checkedAt: null; results: null }
  | { status: "success"; message: string; checkedAt: string; results: TradeCredentialVerificationResponse["results"] }
  | { status: "error"; message: string; checkedAt: string | null; results: TradeCredentialVerificationResponse["results"] | null };

function buildSupportNote(exchange: ExchangeName) {
  switch (exchange) {
    case "binance":
      return { live: true, note: "Requires Binance USD-M futures permission and Hedge Mode enabled." };
    case "coindcx":
      return { live: true, note: "CoinDCX live mode uses USDT futures market orders." };
    case "coinswitch":
      return { live: true, note: "CoinSwitch leverage must already be configured on the venue." };
    case "delta":
      return { live: true, note: "Delta live mode is supported with market orders and integer contract sizing." };
    case "wazirx":
      return { live: false, note: "WazirX is monitor-only for now; live order routing is not wired up." };
    default:
      return { live: false, note: "Live support unavailable." };
  }
}

// Mirrors backend reverse_opportunity: funding flips sign, but fees and slippage are still paid.
function reverseOpportunityView(opportunity: ArbitrageOpportunity): ArbitrageOpportunity {
  const netReturn = -opportunity.expected_funding_percent - opportunity.estimated_total_cost_percent;
  return {
    ...opportunity,
    long_leg: opportunity.short_leg,
    short_leg: opportunity.long_leg,
    spread_rate: -opportunity.spread_rate,
    spread_rate_hourly: -opportunity.spread_rate_hourly,
    gross_apr_percent: -opportunity.gross_apr_percent,
    expected_funding_percent: -opportunity.expected_funding_percent,
    net_return_percent: netReturn,
    net_apr_percent: (netReturn * 8760) / Math.max(opportunity.holding_horizon_hours, 1),
    break_even_hours: null,
  };
}

const FUNDING_STATUS_LABEL: Record<string, string> = {
  not_applicable: "No settlement inside this trade",
  pending: "Prediction (settled rate pending)",
  settled: "Settled rate from the exchange",
  partly_estimated: "Partly settled, partly estimated",
  estimated: "Estimated (venue publishes no history)",
};

function triggerFileDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  window.setTimeout(() => {
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, 1000);
}

function exportCredentialFile(credentials: TradeCredentialState) {
  const payload = {
    version: 1,
    generated_at: new Date().toISOString(),
    credentials,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  triggerFileDownload(blob, `fundex-trade-keys-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.json`);
}

function readPaperGuideSeen() {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(PAPER_GUIDE_KEY) === "true";
}

function buildDemoCredentials(exchanges: ExchangeName[]): TradeCredentialState {
  const next: TradeCredentialState = {};
  exchanges.forEach((exchange) => {
    next[exchange] = {
      api_key: `demo_${exchange}_key`,
      api_secret: `demo_${exchange}_secret`,
      extra: exchange === "coinswitch" ? { exchange: DEFAULT_COINSWITCH_EXCHANGE } : {},
    };
  });
  return next;
}

function normalizeCredentialState(input: unknown): TradeCredentialState {
  if (!input || typeof input !== "object") {
    return {};
  }

  const next: TradeCredentialState = {};
  for (const [exchange, value] of Object.entries(input as Record<string, unknown>)) {
    if (!value || typeof value !== "object") {
      continue;
    }

    const api_key = typeof (value as { api_key?: unknown }).api_key === "string" ? (value as { api_key: string }).api_key : "";
    const api_secret = typeof (value as { api_secret?: unknown }).api_secret === "string" ? (value as { api_secret: string }).api_secret : "";
    const extraSource = (value as { extra?: unknown }).extra;
    const extra =
      extraSource && typeof extraSource === "object"
        ? Object.fromEntries(Object.entries(extraSource as Record<string, unknown>).filter(([, item]) => typeof item === "string")) as Record<string, string>
        : {};

    if (!api_key && !api_secret && !Object.keys(extra).length) {
      continue;
    }

    next[exchange] = { api_key, api_secret, extra };
  }

  return next;
}

function hasAnySavedCredentials(credentials: TradeCredentialState) {
  return Object.values(credentials).some((item) => item.api_key || item.api_secret || Object.keys(item.extra ?? {}).length);
}

function getExportableCredentials(credentials: TradeCredentialState) {
  return normalizeCredentialState(credentials);
}

function readStoredCredentials(): TradeCredentialState {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(TRADE_CREDENTIALS_KEY);
    return raw ? normalizeCredentialState(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

function isTerminalTradeStatus(status: TradeSessionResponse["status"]) {
  return ["completed", "failed", "cancelled"].includes(status);
}

function getTradeResultTone(session: TradeSessionResponse) {
  const net = session.realized_net_pnl_usd ?? session.expected_net_pnl_usd;
  if (net > 0) return "positive";
  if (net < 0) return "danger";
  return "neutral";
}

function getTradeNetReturnPercent(session: TradeSessionResponse) {
  if (session.realized_net_pnl_usd != null && session.capital_input_usd > 0) {
    return (session.realized_net_pnl_usd / session.capital_input_usd) * 100;
  }
  return session.expected_net_return_on_capital_percent;
}

function getTradeLegLabel(leg: TradeLegExecution) {
  return leg.side === "buy" ? "Long leg" : "Short leg";
}

function canCancelTrade(session: TradeSessionResponse | null, nowTimestamp: number) {
  if (!session || session.status !== "armed" || !session.cancellable_until) {
    return false;
  }
  return new Date(session.cancellable_until).getTime() > nowTimestamp;
}

function getCancelTradeNote(session: TradeSessionResponse | null, nowTimestamp: number) {
  if (!session) {
    return "No armed trade yet.";
  }
  if (isTerminalTradeStatus(session.status)) {
    return `This trade is already ${session.status}.`;
  }
  if (session.status !== "armed") {
    return "Execution has already started, so cancellation is no longer available.";
  }
  if (!session.cancellable_until) {
    return `Trades lock ${CANCEL_LOCK_WINDOW_MINUTES} minutes before the entry window.`;
  }
  if (!canCancelTrade(session, nowTimestamp)) {
    return `Trades lock during the final ${CANCEL_LOCK_WINDOW_MINUTES} minutes before entry.`;
  }
  return `You can cancel for another ${formatCountdown(session.cancellable_until, nowTimestamp)}; after that the trade locks until it runs.`;
}

function formatPermissionLabel(level: "trading" | "read_only" | "unknown" | undefined) {
  if (level === "trading") return "Trading access";
  if (level === "read_only") return "Read-only access";
  return "Permission unknown";
}

function buildTradePdf(session: TradeSessionResponse) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 40;
  const usableWidth = pageWidth - margin * 2;
  let cursorY = margin;

  const ensureSpace = (height: number) => {
    if (cursorY + height <= pageHeight - margin) {
      return;
    }
    doc.addPage();
    cursorY = margin;
  };

  const addBlock = (text: string, options?: { size?: number; bold?: boolean; spacingBefore?: number; spacingAfter?: number }) => {
    const size = options?.size ?? 11;
    const lineHeight = size * 1.45;
    cursorY += options?.spacingBefore ?? 0;
    doc.setFont("helvetica", options?.bold ? "bold" : "normal");
    doc.setFontSize(size);
    const lines = doc.splitTextToSize(text, usableWidth) as string[];
    ensureSpace(lines.length * lineHeight + (options?.spacingAfter ?? 0));
    lines.forEach((line) => {
      doc.text(line, margin, cursorY);
      cursorY += lineHeight;
    });
    cursorY += options?.spacingAfter ?? 0;
  };

  const addRule = () => {
    ensureSpace(18);
    doc.setDrawColor(190, 198, 216);
    doc.line(margin, cursorY, pageWidth - margin, cursorY);
    cursorY += 14;
  };

  const addMetric = (label: string, value: string) => addBlock(`${label}: ${value}`);
  const addLegDetails = (title: string, leg: TradeLegExecution) => {
    addBlock(title, { size: 13, bold: true, spacingBefore: 8, spacingAfter: 4 });
    addMetric("Exchange", `${leg.display_name} (${leg.exchange_symbol})`);
    addMetric("Side", leg.side.toUpperCase());
    addMetric("Reference price", formatPrice(leg.reference_price));
    addMetric("Quantity", leg.estimated_quantity.toFixed(6));
    addMetric("Leverage", `${leg.leverage.toFixed(2)}x`);
    addMetric("Max leverage", formatLeverage(leg.max_leverage));
    addMetric("Notional", formatUsd(leg.notional_usd));
    addMetric("Initial margin", formatUsd(leg.initial_margin_usd));
    addMetric("Entry order ID", leg.entry_order_id ?? "pending");
    addMetric("Exit order ID", leg.exit_order_id ?? "pending");
    addMetric("Entry fill", formatPrice(leg.entry_fill_price));
    addMetric("Exit fill", formatPrice(leg.exit_fill_price));
    if (leg.support_note) {
      addMetric("Support note", leg.support_note);
    }
    addMetric("Trade URL", leg.trade_url);
  };

  addBlock(`Fundex Trade Report`, { size: 18, bold: true, spacingAfter: 6 });
  addBlock(`${session.canonical_symbol} | ${session.mode === "paper" ? "Paper" : "Live"} | ${session.scenario === "best" ? "Best setup" : "Reverse setup"}`, {
    size: 12,
    spacingAfter: 12,
  });
  addRule();
  addBlock("Summary", { size: 14, bold: true, spacingAfter: 4 });
  addMetric("Status", session.status);
  addMetric("Current phase", session.current_phase);
  addMetric("Created at", formatTimestamp(session.created_at));
  addMetric("Updated at", formatTimestamp(session.updated_at));
  addMetric("Pair funding time", formatTimestamp(session.pair_funding_time));
  addMetric("Scheduled entry", formatTimestamp(session.scheduled_entry_at));
  addMetric("Scheduled exit", formatTimestamp(session.scheduled_exit_at));
  addMetric("Cancel until", formatTimestamp(session.cancellable_until));
  addMetric("Capital", formatUsd(session.capital_input_usd));
  addMetric("Leverage", `${session.leverage.toFixed(2)}x`);
  addMetric("Projected net", formatUsd(session.expected_net_pnl_usd));
  addMetric("Projected return", formatPct(session.expected_net_return_on_capital_percent));
  addMetric("Projected funding capture", formatUsd(session.expected_funding_pnl_usd));
  addMetric("Estimated total fees", formatUsd(session.estimated_total_fees_usd));
  addMetric("Realized price PnL", formatUsd(session.realized_price_pnl_usd));
  addMetric("Realized funding PnL", formatUsd(session.realized_funding_pnl_usd));
  addMetric("Realized total fees", formatUsd(session.realized_total_fees_usd));
  addMetric("Realized net", formatUsd(session.realized_net_pnl_usd));
  addMetric("Net return on capital", formatPct(getTradeNetReturnPercent(session)));

  addRule();
  addLegDetails("Long side", session.long_leg);
  addRule();
  addLegDetails("Short side", session.short_leg);

  if (session.warnings.length) {
    addRule();
    addBlock("Warnings", { size: 14, bold: true, spacingAfter: 4 });
    session.warnings.forEach((warning, index) => addBlock(`${index + 1}. ${warning}`));
  }

  addRule();
  addBlock("Event log", { size: 14, bold: true, spacingAfter: 4 });
  session.events.forEach((event, index) => {
    addBlock(`${index + 1}. [${event.level.toUpperCase()}] ${formatTimestamp(event.at)} | ${event.phase} | ${event.message}`);
  });

  return doc;
}

function exportTradePdf(session: TradeSessionResponse) {
  const doc = buildTradePdf(session);
  doc.save(`fundex-trade-report-${session.canonical_symbol}-${session.id.slice(0, 8)}.pdf`);
}

const FUNDING_SOURCE_LABEL: Record<string, string> = {
  pending: "waiting",
  exchange_history: "settled, from exchange history",
  post_settlement_feed: "settled, from the exchange feed",
  estimate: "estimate (no history published)",
};

function money(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function TradeReportContent({ session }: { session: TradeSessionResponse; nowTimestamp: number }) {
  const net = session.realized_net_pnl_usd ?? session.expected_net_pnl_usd;
  const done = session.realized_net_pnl_usd != null;
  return (
    <div className="td-report">
      <div className="t-bigline">
        <strong className={`t-num ${net >= 0 ? "t-receive" : "t-pay"}`}>{money(net)}</strong>
        <span className="t-soft">
          {done ? "net result" : "projected net"}, {formatPct(getTradeNetReturnPercent(session))} of ${session.capital_input_usd.toLocaleString()} capital
        </span>
      </div>
      <p className="t-soft" style={{ margin: "0 0 14px" }}>
        {session.mode === "paper" ? "Paper" : "Live"} trade, {session.strategy === "capture" ? "next funding" : "hold"}, {session.scenario === "best" ? "best" : "reverse"} side. Status {session.status}:{" "}
        {session.current_phase}.
      </p>

      <dl className="t-kv">
        <div><dt>Funding</dt><dd className={`t-num ${(session.realized_funding_pnl_usd ?? session.expected_funding_pnl_usd) >= 0 ? "t-receive" : "t-pay"}`}>{money(session.realized_funding_pnl_usd ?? session.expected_funding_pnl_usd)}</dd></div>
        <div><dt>Price moves between legs</dt><dd className="t-num">{money(session.realized_price_pnl_usd)}</dd></div>
        <div><dt>Fees</dt><dd className="t-num t-pay">{money(session.realized_total_fees_usd != null ? -session.realized_total_fees_usd : -session.estimated_total_fees_usd)}</dd></div>
        <div><dt>Slippage, actual vs planned</dt><dd className="t-num">{formatUsd(session.realized_slippage_usd ?? null)} vs {formatUsd(session.expected_slippage_usd ?? null)}</dd></div>
        <div><dt>Funding source</dt><dd>{FUNDING_STATUS_LABEL[session.funding_status ?? "not_applicable"]}</dd></div>
      </dl>

      {session.funding_legs?.length ? (
        <div className="t-section">
          <h3>Funding per leg</h3>
          <ul className="t-list">
            {session.funding_legs.map((leg) => (
              <li key={`${leg.exchange}-${leg.side}`}>
                <span>
                  {exchangeLabel(leg.exchange)} {leg.side}: predicted {formatPct(leg.predicted_rate * 100, 4)}
                  {leg.actual_rate != null ? `, settled ${formatPct(leg.actual_rate * 100, 4)}` : ""}
                  <span className="t-muted"> ({FUNDING_SOURCE_LABEL[leg.source] ?? leg.source})</span>
                </span>
                <span className={`t-num ${(leg.payment_usd ?? 0) >= 0 ? "t-receive" : "t-pay"}`}>{money(leg.payment_usd)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="t-section">
        <h3>Legs</h3>
        <div className="t-leg-grid">
          {[session.long_leg, session.short_leg].map((leg) => (
            <div key={`${session.id}-${leg.exchange}`} className="t-leg">
              <span className="t-leg-side">{getTradeLegLabel(leg)}, {leg.status}</span>
              <strong style={{ color: `var(--x-${leg.exchange})` }}>{leg.display_name}</strong>
              <dl className="t-kv">
                <div><dt>Entry fill</dt><dd className="t-num">{formatPrice(leg.entry_fill_price)}</dd></div>
                <div><dt>Exit fill</dt><dd className="t-num">{formatPrice(leg.exit_fill_price)}</dd></div>
                <div><dt>Quantity</dt><dd className="t-num">{leg.estimated_quantity.toFixed(4)}</dd></div>
                <div><dt>Leverage</dt><dd className="t-num">{leg.leverage.toFixed(1)}x</dd></div>
                <div><dt>Order</dt><dd className="t-num t-muted">{leg.entry_order_id ?? "pending"}</dd></div>
              </dl>
            </div>
          ))}
        </div>
      </div>

      {session.warnings.length ? (
        <div className="t-section">
          <h3>Warnings</h3>
          <ul className="t-checks">
            {session.warnings.map((warning) => (
              <li key={warning} className="t-check" data-status="warn">
                <span aria-hidden="true">!</span>
                <span>{warning}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="t-section">
        <h3>What happened</h3>
        <ol className="td-log">
          {session.events.map((event) => (
            <li key={`${session.id}-${event.at}-${event.phase}-${event.message}`} data-level={event.level}>
              <span className="t-num t-muted">{new Date(event.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
              <span>{event.message}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

export function SymbolTradePage({ canonicalSymbol }: { canonicalSymbol: string }) {
  const [paperTradingEnabled, setPaperTradingEnabled] = useState(true);
  const [scenario, setScenario] = useState<"best" | "reverse">("best");
  // Same default as the dashboard: catch the next settlement. "hold" keeps the multi-day hedge.
  const [strategy, setStrategy] = useState<"capture" | "hold">(() =>
    new URLSearchParams(window.location.search).get("strategy") === "hold" ? "hold" : "capture",
  );
  const [capitalInput, setCapitalInput] = useState("1000");
  const [leverageInput, setLeverageInput] = useState("2");
  const [exchangeLeverageInput, setExchangeLeverageInput] = useState<Record<string, string>>({});
  const [entrySecondsBefore, setEntrySecondsBefore] = useState("30");
  const [exitSecondsAfter, setExitSecondsAfter] = useState("15");
  const [rememberCredentials, setRememberCredentials] = useState(() => Object.keys(readStoredCredentials()).length > 0);
  const [credentials, setCredentials] = useState<TradeCredentialState>(() => readStoredCredentials());
  const [isPaperGuideOpen, setIsPaperGuideOpen] = useState(() => !readPaperGuideSeen());
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const [credentialFileNotice, setCredentialFileNotice] = useState<string | null>(null);
  const [verification, setVerification] = useState<VerificationState>({ status: "idle", message: null, checkedAt: null, results: null });
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const nowTimestamp = useNow(1000);
  const selectedExchanges = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    const exchanges = params.get("exchanges");
    return exchanges ? exchanges.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean) : [];
  }, []);

  const { comparison, loading, error } = useSymbolComparison(canonicalSymbol, selectedExchanges, strategy);
  const bestOpportunity = comparison?.best_opportunity ?? null;
  const capitalUsd = Number(capitalInput) > 0 ? Number(capitalInput) : 1000;
  const leverage = Number(leverageInput) > 0 ? Number(leverageInput) : 2;
  const entryLeadSeconds = Math.max(0, Number(entrySecondsBefore) || 30);
  const exitLagSeconds = Math.max(0, Number(exitSecondsAfter) || 15);
  const leverageOverrides = useMemo(() => {
    const next: Record<string, number> = {};
    Object.entries(exchangeLeverageInput).forEach(([exchange, value]) => {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 1 && Math.abs(parsed - leverage) > 0.0001) {
        next[exchange] = parsed;
      }
    });
    return next;
  }, [exchangeLeverageInput, leverage]);

  const { plan: bestPlan, loading: bestPlanLoading, error: bestPlanError } = useExecutionPlan(bestOpportunity?.canonical_symbol ?? null, Boolean(bestOpportunity), selectedExchanges, {
    capitalUsd,
    leverage,
    leverageByExchange: leverageOverrides,
    holdingPeriods: 1,
    reverse: false,
    strategy,
  });
  const { plan: reversePlan, loading: reversePlanLoading, error: reversePlanError } = useExecutionPlan(bestOpportunity?.canonical_symbol ?? null, Boolean(bestOpportunity), selectedExchanges, {
    capitalUsd,
    leverage,
    leverageByExchange: leverageOverrides,
    holdingPeriods: 1,
    reverse: true,
    strategy,
  });
  const { session, history, loading: sessionLoading, error: sessionError, createSession, cancelSession } = useTradeSession(canonicalSymbol);

  const activePlan = scenario === "reverse" ? reversePlan : bestPlan;
  const planLoading = scenario === "reverse" ? reversePlanLoading : bestPlanLoading;
  const planError = scenario === "reverse" ? reversePlanError : bestPlanError;
  const activeOpportunity = useMemo(() => {
    if (!bestOpportunity) return null;
    return scenario === "reverse"
      ? reverseOpportunityView(bestOpportunity)
      : bestOpportunity;
  }, [bestOpportunity, scenario]);
  const fundingTime = useMemo(() => (activeOpportunity ? getNextFundingTime(activeOpportunity) : null), [activeOpportunity]);
  const scheduledEntryAt = fundingTime ? new Date(new Date(fundingTime).getTime() - entryLeadSeconds * 1000).toISOString() : null;
  const scheduledExitAt = fundingTime ? new Date(new Date(fundingTime).getTime() + exitLagSeconds * 1000).toISOString() : null;
  const longSupport = activeOpportunity ? buildSupportNote(activeOpportunity.long_leg.exchange) : null;
  const shortSupport = activeOpportunity ? buildSupportNote(activeOpportunity.short_leg.exchange) : null;
  const liveModeAvailable = Boolean(longSupport?.live && shortSupport?.live);
  const requiredExchanges = useMemo(
    () => (activeOpportunity ? Array.from(new Set([activeOpportunity.long_leg.exchange, activeOpportunity.short_leg.exchange])) : []),
    [activeOpportunity],
  );
  const leverageMaxByExchange = useMemo(() => {
    const next: Record<string, number | null> = {};
    if (!activeOpportunity) {
      return next;
    }
    next[activeOpportunity.long_leg.exchange] = activeOpportunity.long_leg.max_leverage;
    next[activeOpportunity.short_leg.exchange] = activeOpportunity.short_leg.max_leverage;
    return next;
  }, [activeOpportunity]);
  const mode = paperTradingEnabled ? "paper" : "live";
  const demoCredentials = useMemo(() => buildDemoCredentials(requiredExchanges), [requiredExchanges]);
  const displayedCredentials = paperTradingEnabled ? demoCredentials : credentials;

  const credentialInputs = useMemo(
    () =>
      requiredExchanges.map((exchange) => ({
        exchange,
        displayName: exchangeLabel(exchange),
        support: buildSupportNote(exchange),
        value: displayedCredentials[exchange] ?? { api_key: "", api_secret: "", extra: exchange === "coinswitch" ? { exchange: DEFAULT_COINSWITCH_EXCHANGE } : {} },
      })),
    [displayedCredentials, requiredExchanges],
  );

  const persistCredentials = (enabled: boolean, nextCredentials: TradeCredentialState) => {
    if (!enabled) {
      window.localStorage.removeItem(TRADE_CREDENTIALS_KEY);
      return;
    }
    window.localStorage.setItem(TRADE_CREDENTIALS_KEY, JSON.stringify(nextCredentials));
  };

  const setCredentialValue = (exchange: ExchangeName, field: "api_key" | "api_secret", value: string) => {
    setCredentials((current) => {
      const next = {
        ...current,
        [exchange]: {
          ...(current[exchange] ?? { api_key: "", api_secret: "", extra: exchange === "coinswitch" ? { exchange: DEFAULT_COINSWITCH_EXCHANGE } : {} }),
          [field]: value,
        },
      };
      if (rememberCredentials) persistCredentials(true, next);
      return next;
    });
  };

  const setCredentialExtra = (exchange: ExchangeName, key: string, value: string) => {
    setCredentials((current) => {
      const next = {
        ...current,
        [exchange]: {
          ...(current[exchange] ?? { api_key: "", api_secret: "", extra: {} }),
          extra: { ...(current[exchange]?.extra ?? {}), [key]: value },
        },
      };
      if (rememberCredentials) persistCredentials(true, next);
      return next;
    });
  };

  const liveCredentialPayload = useMemo(
    () =>
      credentialInputs
        .filter((item) => item.value.api_key && item.value.api_secret)
        .map(
          (item) =>
            ({
              exchange: item.exchange,
              api_key: item.value.api_key,
              api_secret: item.value.api_secret,
              extra: item.value.extra ?? {},
            }) satisfies TradeCredentialInput,
        ),
    [credentialInputs],
  );
  const liveReadyForVerification = requiredExchanges.length > 0 && liveCredentialPayload.length === requiredExchanges.length;
  const liveVerificationPassed = useMemo(() => {
    if (verification.status !== "success") {
      return false;
    }
    return requiredExchanges.every((exchange) => verification.results.some((result) => result.exchange === exchange && result.ok));
  }, [requiredExchanges, verification]);
  const liveArmBlockedReason = !paperTradingEnabled
    ? (!liveModeAvailable
      ? "Live mode is unavailable for one of the selected exchanges."
      : !liveVerificationPassed
        ? "Verify both exchange APIs before arming a live trade."
        : null)
    : null;
  const livePanelsLocked = !paperTradingEnabled && !liveVerificationPassed;

  useEffect(() => {
    setVerification({ status: "idle", message: null, checkedAt: null, results: null });
  }, [paperTradingEnabled, requiredExchanges.join(","), JSON.stringify(liveCredentialPayload)]);

  // The server journal is the source of truth: browser-stored copies go stale (an "armed" trade that
  // later completed would stay "armed"). Anything only stored locally is kept as a fallback.
  const [journal, setJournal] = useState<TradeSessionResponse[]>([]);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch(`${API_BASE}/trade/journal?limit=200`)
        .then((response) => (response.ok ? response.json() : []))
        .then((rows: TradeSessionResponse[]) => !cancelled && setJournal(rows))
        .catch(() => undefined);
    void load();
    const timer = window.setInterval(load, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);
  const localTradeHistory = useMemo(() => {
    const merged = new Map<string, TradeSessionResponse>();
    for (const item of history) merged.set(item.id, item);
    for (const item of journal) merged.set(item.id, item);
    return [...merged.values()]
      .filter((item) => item.canonical_symbol.toUpperCase() === canonicalSymbol.toUpperCase())
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }, [canonicalSymbol, history, journal]);
  const reportSessions = useMemo(() => {
    const next = new Map<string, TradeSessionResponse>();
    if (session) {
      next.set(session.id, session);
    }
    localTradeHistory.forEach((item) => {
      if (!next.has(item.id)) {
        next.set(item.id, item);
      }
    });
    return next;
  }, [localTradeHistory, session]);
  const selectedReportSession = selectedReportId ? reportSessions.get(selectedReportId) ?? null : null;
  const completedSession = session && isTerminalTradeStatus(session.status) ? session : null;
  const sessionCanCancel = canCancelTrade(session, nowTimestamp);
  const cancelTradeNote = getCancelTradeNote(session, nowTimestamp);

  const armTrade = async () => {
    if (!activeOpportunity) return;
    if (!paperTradingEnabled && !liveVerificationPassed) {
      setVerification({
        status: "error",
        message: "Verify both exchange APIs first, then arm the live trade.",
        checkedAt: verification.checkedAt,
        results: verification.results,
      });
      return;
    }
    await createSession({
      canonical_symbol: activeOpportunity.canonical_symbol,
      selected_exchanges: selectedExchanges as ExchangeName[],
      mode,
      scenario,
      strategy,
      capital_usd: capitalUsd,
      leverage,
      leverage_overrides: leverageOverrides as Partial<Record<ExchangeName, number>>,
      holding_periods: 1,
      basis_risk_buffer_percent: 0.35,
      schedule: { entry_seconds_before_funding: entryLeadSeconds, exit_seconds_after_funding: exitLagSeconds },
      credentials: mode === "live" ? liveCredentialPayload : [],
    });
  };

  const verifyLiveCredentials = async () => {
    if (paperTradingEnabled) {
      return;
    }
    if (!liveReadyForVerification) {
      setVerification({
        status: "error",
        message: "Enter API key/secret for both exchanges before verification.",
        checkedAt: null,
        results: null,
      });
      return;
    }

    setVerification({ status: "checking", message: "Verifying exchange APIs...", checkedAt: null, results: null });
    try {
      const response = await fetch(`${API_BASE}/trade/verify-credentials`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          required_exchanges: requiredExchanges,
          credentials: liveCredentialPayload,
        }),
      });
      const payload = (await response.json()) as TradeCredentialVerificationResponse | { detail?: string };
      if (!response.ok) {
        throw new Error((payload as { detail?: string }).detail ?? "Credential verification failed.");
      }
      const verificationPayload = payload as TradeCredentialVerificationResponse;
      if (verificationPayload.ok) {
        setVerification({
          status: "success",
          message: "All required exchange APIs verified. Live arming is now enabled.",
          checkedAt: verificationPayload.checked_at,
          results: verificationPayload.results,
        });
      } else {
        setVerification({
          status: "error",
          message: "One or more exchange APIs failed verification. Fix them and verify again.",
          checkedAt: verificationPayload.checked_at,
          results: verificationPayload.results,
        });
      }
    } catch (verificationError) {
      setVerification({
        status: "error",
        message: verificationError instanceof Error ? verificationError.message : "Credential verification failed.",
        checkedAt: null,
        results: null,
      });
    }
  };

  const setLeverageOverrideValue = (exchange: ExchangeName, value: string) => {
    setExchangeLeverageInput((current) => {
      if (!value.trim()) {
        const next = { ...current };
        delete next[exchange];
        return next;
      }
      return { ...current, [exchange]: value };
    });
  };

  const handlePaperTradingToggle = (enabled: boolean) => {
    setPaperTradingEnabled(enabled);
    if (enabled) {
      setIsPaperGuideOpen(true);
    }
  };

  const closePaperGuide = () => {
    setIsPaperGuideOpen(false);
    window.localStorage.setItem(PAPER_GUIDE_KEY, "true");
  };

  const exportKeysFile = () => {
    const exportableCredentials = getExportableCredentials(credentials);
    if (!hasAnySavedCredentials(exportableCredentials)) {
      setCredentialFileNotice("No live credentials are ready to export yet. Enter your real exchange keys first, then export them.");
      return;
    }
    exportCredentialFile(exportableCredentials);
    setCredentialFileNotice(`Credential file exported locally for ${Object.keys(exportableCredentials).join(", ")}. Keep it somewhere safe.`);
  };

  const importKeysFile = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as { credentials?: unknown } | unknown;
      const imported = normalizeCredentialState(
        parsed && typeof parsed === "object" && "credentials" in (parsed as Record<string, unknown>)
          ? (parsed as { credentials?: unknown }).credentials
          : parsed,
      );
      if (!hasAnySavedCredentials(imported)) {
        throw new Error("This file does not contain any usable exchange credentials.");
      }
      setCredentials(imported);
      if (rememberCredentials) {
        persistCredentials(true, imported);
      }
      setCredentialFileNotice(`Imported credentials for ${Object.keys(imported).join(", ")}.`);
    } catch (importError) {
      setCredentialFileNotice(importError instanceof Error ? importError.message : "Could not import this credential file.");
    }
  };

  const settlementAt = fundingTime;
  const cancelLockAt = scheduledEntryAt ? new Date(new Date(scheduledEntryAt).getTime() - CANCEL_LOCK_WINDOW_MINUTES * 60_000).toISOString() : null;
  const capture = bestOpportunity?.capture ?? null;
  const steps: Array<{ key: string; label: string; at: string | null }> = [
    { key: "armed", label: "Armed", at: session?.created_at ?? null },
    { key: "entering", label: "Enter", at: session?.scheduled_entry_at ?? scheduledEntryAt },
    { key: "settle", label: "Settles", at: session?.pair_funding_time ?? settlementAt },
    { key: "exiting", label: "Exit", at: session?.scheduled_exit_at ?? scheduledExitAt },
    { key: "completed", label: "Result", at: null },
  ];
  const stepIndex = !session
    ? -1
    : session.status === "armed"
      ? 0
      : session.status === "entering" || session.status === "entered"
        ? 1
        : session.status === "exiting"
          ? 3
          : 4;
  const symbolBase = (comparison?.canonical_symbol ?? canonicalSymbol).split("-")[0];

  return (
    <main className="t-main td-page">
      <header className="td-head">
        <div>
          <a className="td-back" href="/">Dashboard</a>
          <h1 className="td-title">{symbolBase}</h1>
          <p className="t-soft td-sub">
            {activeOpportunity
              ? `Buy on ${activeOpportunity.long_leg.display_name}, sell on ${activeOpportunity.short_leg.display_name}. ${
                  strategy === "capture" ? "In just before the settlement, out right after." : "Hold the hedge across settlements."
                }`
              : loading
                ? "Loading the live setup…"
                : "No live setup for this coin in the current exchange scope."}
          </p>
        </div>
        <div className="td-switches">
          <div className="t-segmented t-strategy" role="group" aria-label="Strategy">
            <button type="button" aria-pressed={strategy === "capture"} onClick={() => setStrategy("capture")}>Live funding</button>
            <button type="button" aria-pressed={strategy === "hold"} onClick={() => setStrategy("hold")}>Hold</button>
          </div>
          <div className="t-segmented" role="group" aria-label="Side">
            <button type="button" aria-pressed={scenario === "best"} onClick={() => setScenario("best")}>Best side</button>
            <button type="button" aria-pressed={scenario === "reverse"} onClick={() => setScenario("reverse")}>Reverse</button>
          </div>
          <div className="t-segmented td-mode" role="group" aria-label="Mode" data-live={!paperTradingEnabled}>
            <button type="button" aria-pressed={paperTradingEnabled} onClick={() => handlePaperTradingToggle(true)}>Paper</button>
            <button type="button" aria-pressed={!paperTradingEnabled} onClick={() => handlePaperTradingToggle(false)}>Live</button>
          </div>
        </div>
      </header>

      {[error, planError, sessionError].filter(Boolean).map((message) => (
        <div key={message} className="t-banner" role="alert">{message}</div>
      ))}
      {credentialFileNotice ? <div className="t-capture-note">{credentialFileNotice}</div> : null}
      {!paperTradingEnabled ? (
        <div className="td-live-banner" role="status">
          Live mode sends real orders with your keys. Verify both exchanges below before arming.
        </div>
      ) : null}

      <div className="td-grid">
        <div className="td-main">
          <section className="td-clock">
            <div className="td-clock-top">
              <div>
                <span className="t-soft">{session && !isTerminalTradeStatus(session.status) ? session.current_phase : "Funding settles in"}</span>
                <strong className="td-clock-big t-num">
                  {settlementAt ? <Countdown target={session?.pair_funding_time ?? settlementAt} /> : "—"}
                </strong>
                <span className="t-muted">
                  {settlementAt ? new Date(session?.pair_funding_time ?? settlementAt).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }) : ""}
                  {capture && strategy === "capture" ? `, ${whoPays(capture).toLowerCase()}` : ""}
                </span>
              </div>
              <dl className="td-clock-facts">
                <div><dt>Enter in</dt><dd className="t-num"><Countdown target={session?.scheduled_entry_at ?? scheduledEntryAt} doneLabel="now" /></dd></div>
                <div><dt>Exit in</dt><dd className="t-num"><Countdown target={session?.scheduled_exit_at ?? scheduledExitAt} doneLabel="now" /></dd></div>
                <div><dt>Cancel allowed for</dt><dd className="t-num"><Countdown target={session?.cancellable_until ?? cancelLockAt} doneLabel="locked" /></dd></div>
              </dl>
            </div>
            <ol className="td-steps" aria-label="Trade timeline">
              {steps.map((step, index) => (
                <li key={step.key} data-state={index < stepIndex ? "done" : index === stepIndex ? "now" : "next"} data-failed={index === stepIndex && session?.status === "failed"}>
                  <i aria-hidden="true" />
                  <span>{step.label}</span>
                  <small className="t-num">
                    {step.at ? clockTime(step.at) : index === 4 && session?.realized_net_pnl_usd != null ? money(session.realized_net_pnl_usd) : ""}
                  </small>
                </li>
              ))}
            </ol>
          </section>

          <section className="t-panel td-section">
            <h3>Size and timing</h3>
            <div className="td-fields">
              <label className="t-field">Capital (USD)<input type="number" min="1" step="any" inputMode="decimal" value={capitalInput} onChange={(event) => setCapitalInput(event.target.value)} /></label>
              <label className="t-field">Leverage<input type="number" min="1" step="0.1" inputMode="decimal" value={leverageInput} onChange={(event) => setLeverageInput(event.target.value)} /></label>
              <label className="t-field">Enter before funding (s)<input type="number" min="0" step="1" inputMode="numeric" value={entrySecondsBefore} onChange={(event) => setEntrySecondsBefore(event.target.value)} /></label>
              <label className="t-field">Exit after funding (s)<input type="number" min="0" step="1" inputMode="numeric" value={exitSecondsAfter} onChange={(event) => setExitSecondsAfter(event.target.value)} /></label>
              {requiredExchanges.map((exchange) => (
                <label key={`override-${exchange}`} className="t-field">
                  {exchangeLabel(exchange)} leverage{leverageMaxByExchange[exchange] ? ` (max ${leverageMaxByExchange[exchange]!.toFixed(0)}x)` : ""}
                  <input type="number" min="1" step="0.1" inputMode="decimal" value={exchangeLeverageInput[exchange] ?? ""} placeholder={`${leverage.toFixed(1)}x`} onChange={(event) => setLeverageOverrideValue(exchange, event.target.value)} />
                </label>
              ))}
            </div>
          </section>

          <section className="td-section">
            <h3 className="td-h3">The two legs</h3>
            {activePlan && activeOpportunity ? (
              <div className="t-leg-grid">
                {[activeOpportunity.long_leg, activeOpportunity.short_leg].map((leg) => {
                  const support = buildSupportNote(leg.exchange);
                  const isLong = leg.exchange === activeOpportunity.long_leg.exchange;
                  const executionLeg = isLong ? activePlan.long_leg : activePlan.short_leg;
                  const receives = isLong ? leg.funding_rate < 0 : leg.funding_rate > 0;
                  return (
                    <div key={`${leg.exchange}-${leg.exchange_symbol}`} className="t-leg">
                      <span className="t-leg-side">{isLong ? "Buy (long)" : "Sell (short)"} {leg.exchange_symbol}</span>
                      <strong style={{ color: `var(--x-${leg.exchange})` }}>{leg.display_name}</strong>
                      <span className={`t-leg-rate t-num ${receives ? "t-receive" : "t-pay"}`}>
                        {formatFundingRate(leg.funding_rate)} / {leg.funding_interval_hours ?? activeOpportunity.funding_interval_hours}h
                      </span>
                      <span className="t-muted">{receives ? "You receive this" : "You pay this"}, settles in <Countdown target={leg.next_funding_time} /></span>
                      <dl className="t-kv">
                        <div><dt>Quantity</dt><dd className="t-num">{executionLeg.estimated_quantity.toFixed(4)}</dd></div>
                        <div><dt>Margin</dt><dd className="t-num">{formatUsd(executionLeg.initial_margin_usd)}</dd></div>
                        <div><dt>Fees in + out</dt><dd className="t-num">{formatUsd(executionLeg.estimated_entry_fee_usd + executionLeg.estimated_exit_fee_usd)}</dd></div>
                        <div><dt>Max leverage</dt><dd className="t-num">{formatLeverage(leg.max_leverage)}</dd></div>
                      </dl>
                      <span className={support.live ? "t-muted" : "t-pay"} style={{ fontSize: 13 }}>{support.live ? "Live orders supported." : support.note}</span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="t-empty"><strong>{loading || planLoading ? "Building the plan…" : "No live setup right now"}</strong>{loading || planLoading ? "" : "Turn on more exchanges on the dashboard or pick another coin."}</div>
            )}
          </section>

          <section className="t-panel td-section">
            <h3>
              Exchange API keys
              <span className="t-muted" style={{ fontWeight: 400, fontSize: 13 }}>{paperTradingEnabled ? "Not needed for paper" : "Required for live"}</span>
            </h3>
            {paperTradingEnabled ? (
              <p className="t-muted" style={{ margin: 0 }}>
                Paper trades use demo keys and never touch your accounts. Switch to Live to enter real keys; they stay in this browser and in server memory only while a trade runs.
              </p>
            ) : (
              <>
                <div className="td-fields">
                  {credentialInputs.map((item) => (
                    <div key={item.exchange} className="td-keyset">
                      <strong style={{ color: `var(--x-${item.exchange})` }}>{item.displayName}</strong>
                      <label className="t-field">API key<input value={item.value.api_key} onChange={(event) => setCredentialValue(item.exchange, "api_key", event.target.value)} autoComplete="off" spellCheck={false} /></label>
                      <label className="t-field">API secret<input type="password" value={item.value.api_secret} onChange={(event) => setCredentialValue(item.exchange, "api_secret", event.target.value)} autoComplete="new-password" /></label>
                      {item.exchange === "coinswitch" ? (
                        <label className="t-field">CoinSwitch exchange code<input value={item.value.extra?.exchange ?? DEFAULT_COINSWITCH_EXCHANGE} onChange={(event) => setCredentialExtra(item.exchange, "exchange", event.target.value)} /></label>
                      ) : null}
                      {!item.support.live ? <span className="t-pay" style={{ fontSize: 13 }}>{item.support.note}</span> : null}
                    </div>
                  ))}
                </div>
                <div className="t-actions">
                  <button type="button" className="t-btn" data-primary="true" onClick={() => void verifyLiveCredentials()} disabled={verification.status === "checking" || !liveReadyForVerification}>
                    {verification.status === "checking" ? "Verifying…" : "Verify both exchanges"}
                  </button>
                  <label className="td-check">
                    <input
                      type="checkbox"
                      checked={rememberCredentials}
                      onChange={(event) => {
                        setRememberCredentials(event.target.checked);
                        persistCredentials(event.target.checked, credentials);
                        setCredentialFileNotice(event.target.checked ? "Keys will be kept on this device until you switch this off." : "Keys were removed from this device.");
                      }}
                    />
                    Remember on this device
                  </label>
                  <button type="button" className="t-btn" onClick={exportKeysFile}>Export keys file</button>
                  <button type="button" className="t-btn" onClick={() => fileInputRef.current?.click()}>Import keys file</button>
                </div>
                {verification.status !== "idle" ? (
                  <div className="td-verify" data-status={verification.status}>
                    <strong>{verification.message}</strong>
                    {verification.results?.map((result) => (
                      <span key={`verify-${result.exchange}`} className={result.ok ? "t-receive" : "t-pay"}>
                        {exchangeLabel(result.exchange)}: {result.ok ? formatPermissionLabel(result.permission_level) : result.message}
                        {result.wallet_balance_usd != null ? `, ${formatUsd(result.wallet_balance_usd)} available` : ""}
                      </span>
                    ))}
                  </div>
                ) : null}
              </>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void importKeysFile(file);
                event.currentTarget.value = "";
              }}
            />
          </section>
        </div>

        <aside className="td-side">
          <section className="td-plan">
            <span className="t-soft">{session && !isTerminalTradeStatus(session.status) ? "This trade" : paperTradingEnabled ? "Paper plan" : "Live plan"}</span>
            {activePlan ? (
              <>
                <div className="t-bigline" style={{ marginBottom: 2 }}>
                  <strong className={`t-num ${activePlan.expected_net_pnl_usd >= 0 ? "t-receive" : "t-pay"}`}>{money(activePlan.expected_net_pnl_usd)}</strong>
                </div>
                <span className="t-muted t-num">{formatPct(activePlan.expected_net_return_on_capital_percent)} of capital after fees and slippage</span>
                <dl className="t-kv" style={{ marginTop: 12 }}>
                  <div><dt>Funding</dt><dd className={`t-num ${activePlan.estimated_funding_pnl_usd >= 0 ? "t-receive" : "t-pay"}`}>{money(activePlan.estimated_funding_pnl_usd)}</dd></div>
                  <div><dt>Fees</dt><dd className="t-num t-pay">{money(-activePlan.estimated_total_fees_usd)}</dd></div>
                  <div><dt>Slippage</dt><dd className="t-num t-pay">{money(-activePlan.estimated_total_slippage_usd)}</dd></div>
                  <div><dt>Capital used</dt><dd className="t-num">{formatUsd(activePlan.capital_required_usd)}</dd></div>
                  <div><dt title="Not a cost: cash to keep aside in case the two legs' prices drift apart">Keep aside for price gaps</dt><dd className="t-num t-muted">{formatUsd(activePlan.estimated_basis_risk_reserve_usd)}</dd></div>
                </dl>
              </>
            ) : (
              <p className="t-muted">{planLoading ? "Calculating…" : "No plan yet."}</p>
            )}

            {session && !isTerminalTradeStatus(session.status) ? (
              <div className="t-actions">
                <button type="button" className="t-btn" onClick={() => void cancelSession(session.id)} disabled={sessionLoading || !sessionCanCancel}>
                  Cancel trade
                </button>
                <span className="t-muted" style={{ fontSize: 13 }}>{cancelTradeNote}</span>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  className="td-arm"
                  data-live={!paperTradingEnabled}
                  onClick={() => void armTrade()}
                  disabled={sessionLoading || !activePlan || (!paperTradingEnabled && (!liveModeAvailable || !liveVerificationPassed))}
                >
                  {sessionLoading ? "Arming…" : paperTradingEnabled ? "Arm paper trade" : "Arm live trade"}
                </button>
                {liveArmBlockedReason ? <p className="t-pay" style={{ fontSize: 13, margin: "8px 0 0" }}>{liveArmBlockedReason}</p> : null}
              </>
            )}

            {activePlan?.warnings.length ? (
              <ul className="t-checks td-warnings">
                {activePlan.warnings.map((warning) => (
                  <li key={warning} className="t-check" data-status="warn">
                    <span aria-hidden="true">!</span>
                    <span>{warning}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          {session ? (
            <section className="t-panel td-session">
              <h3>
                {isTerminalTradeStatus(session.status) ? "Last trade" : "Running trade"}
                <span className={session.status === "failed" ? "t-pay" : session.status === "completed" ? "t-receive" : "t-soft"} style={{ fontSize: 13 }}>{session.status}</span>
              </h3>
              <ol className="td-log">
                {session.events.slice(-6).map((event) => (
                  <li key={`${event.at}-${event.phase}-${event.message}`} data-level={event.level}>
                    <span className="t-num t-muted">{new Date(event.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
                    <span>{event.message}</span>
                  </li>
                ))}
              </ol>
              <div className="t-actions">
                <button type="button" className="t-btn" onClick={() => setSelectedReportId(session.id)}>Full report</button>
                {isTerminalTradeStatus(session.status) ? <button type="button" className="t-btn" onClick={() => exportTradePdf(session)}>Export PDF</button> : null}
              </div>
            </section>
          ) : null}
        </aside>
      </div>

      <section className="t-panel td-section td-history">
        <h3>
          {symbolBase} trades
          <a className="t-text-btn" style={{ height: 32, display: "inline-flex", alignItems: "center", textDecoration: "none" }} href="/performance">All results</a>
        </h3>
        {localTradeHistory.length ? (
          <ul className="t-list">
            {localTradeHistory.map((item) => (
              <li key={item.id}>
                <button type="button" className="t-list-row" onClick={() => setSelectedReportId(item.id)} style={{ padding: 0, border: 0 }}>
                  <span>
                    {new Date(item.created_at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}{" "}
                    <span className="t-muted">
                      {item.mode}, {item.strategy === "capture" ? "next funding" : "hold"}, {item.status}
                    </span>
                  </span>
                  <span className={`t-num ${(item.realized_net_pnl_usd ?? item.expected_net_pnl_usd) >= 0 ? "t-receive" : "t-pay"}`}>
                    {money(item.realized_net_pnl_usd ?? item.expected_net_pnl_usd)}
                    {item.realized_net_pnl_usd == null ? <span className="t-muted"> planned</span> : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="t-muted" style={{ margin: 0 }}>No trades for this coin yet. Arm a paper trade to see how it would have gone.</p>
        )}
      </section>

      {activePlan && !(session && !isTerminalTradeStatus(session.status)) ? (
        <div className="td-mobile-arm">
          <span>
            <span className="t-muted">Planned</span>{" "}
            <b className={`t-num ${activePlan.expected_net_pnl_usd >= 0 ? "t-receive" : "t-pay"}`}>{money(activePlan.expected_net_pnl_usd)}</b>
          </span>
          <button
            type="button"
            className="td-arm"
            data-live={!paperTradingEnabled}
            onClick={() => void armTrade()}
            disabled={sessionLoading || (!paperTradingEnabled && (!liveModeAvailable || !liveVerificationPassed))}
          >
            {paperTradingEnabled ? "Arm paper" : "Arm live"}
          </button>
        </div>
      ) : null}

      {isPaperGuideOpen ? (
        <Dialog title="How paper trading works" onClose={closePaperGuide}>
          <div className="td-guide">
            <p><strong>Real:</strong> funding rates, settlement times, fees, and fills. Each leg fills against the live order book at the actual entry and exit seconds for your size, and refuses to fill if the book is too thin.</p>
            <p><strong>Then corrected:</strong> after the settlement, the predicted funding is replaced by the rate the exchange actually settled (Binance and Delta exact; WazirX and CoinSwitch estimated).</p>
            <p><strong>Simulated:</strong> no orders reach the exchanges and no balance is used. Real fills can still differ through latency and partial fills.</p>
          </div>
          <div className="t-actions">
            <button type="button" className="t-btn" data-primary="true" onClick={closePaperGuide}>Continue in paper mode</button>
          </div>
        </Dialog>
      ) : null}

      {selectedReportSession ? (
        <Dialog wide title={`${selectedReportSession.canonical_symbol.split("-")[0]} trade report`} onClose={() => setSelectedReportId(null)}>
          <TradeReportContent session={selectedReportSession} nowTimestamp={nowTimestamp} />
          <div className="t-actions">
            <button type="button" className="t-btn" onClick={() => exportTradePdf(selectedReportSession)}>Export PDF</button>
          </div>
        </Dialog>
      ) : null}
    </main>
  );
}
