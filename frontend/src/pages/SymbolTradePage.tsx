import { jsPDF } from "jspdf";
import { useMemo, useRef, useState } from "react";
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
  formatTimestamp,
  formatUsd,
  getExchangeCapabilityBadges,
  getNextFundingTime,
} from "../lib/monitor";
import type { ExchangeName } from "../lib/types";
import type { TradeCredentialInput, TradeLegExecution, TradeSessionResponse } from "../lib/trade-types";

const TRADE_CREDENTIALS_KEY = "arbradar-trade-credentials";
const PAPER_GUIDE_KEY = "arbradar-paper-guide-seen";
const DEFAULT_COINSWITCH_EXCHANGE = "EXCHANGE_2";
const CANCEL_LOCK_WINDOW_MINUTES = 10;

type TradeCredentialState = Record<string, { api_key: string; api_secret: string; extra?: Record<string, string> }>;

function buildSupportNote(exchange: ExchangeName) {
  switch (exchange) {
    case "binance":
      return { live: true, note: "Requires Binance USD-M futures permission and Hedge Mode enabled." };
    case "coindcx":
      return { live: true, note: "CoinDCX live mode uses USDT futures market orders." };
    case "coinswitch":
      return { live: true, note: "CoinSwitch leverage must already be configured on the venue." };
    case "delta":
      return { live: false, note: "Delta stays paper-only in this phase while contract sizing is tightened." };
    default:
      return { live: false, note: "Live support unavailable." };
  }
}

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
  triggerFileDownload(blob, `arbradar-trade-keys-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.json`);
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
  return `Cancellation stays open until ${formatCountdown(session.cancellable_until, nowTimestamp)}.`;
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
    addMetric("Reference price", formatUsd(leg.reference_price));
    addMetric("Quantity", leg.estimated_quantity.toFixed(6));
    addMetric("Leverage", `${leg.leverage.toFixed(2)}x`);
    addMetric("Max leverage", formatLeverage(leg.max_leverage));
    addMetric("Notional", formatUsd(leg.notional_usd));
    addMetric("Initial margin", formatUsd(leg.initial_margin_usd));
    addMetric("Entry order ID", leg.entry_order_id ?? "pending");
    addMetric("Exit order ID", leg.exit_order_id ?? "pending");
    addMetric("Entry fill", formatUsd(leg.entry_fill_price));
    addMetric("Exit fill", formatUsd(leg.exit_fill_price));
    if (leg.support_note) {
      addMetric("Support note", leg.support_note);
    }
    addMetric("Trade URL", leg.trade_url);
  };

  addBlock(`ArbRadar Trade Report`, { size: 18, bold: true, spacingAfter: 6 });
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
  doc.save(`arbradar-trade-report-${session.canonical_symbol}-${session.id.slice(0, 8)}.pdf`);
}

function TradeReportContent({ session, nowTimestamp }: { session: TradeSessionResponse; nowTimestamp: number }) {
  const netTone = getTradeResultTone(session);
  const netReturnPercent = getTradeNetReturnPercent(session);

  return (
    <div className="trade-report-body">
      <div className="summary-grid compare-summary-grid trade-report-summary-grid">
        <article className="summary-card"><span className="subtle">Status</span><strong>{session.status}</strong></article>
        <article className="summary-card"><span className="subtle">Capital</span><strong>{formatUsd(session.capital_input_usd)}</strong></article>
        <article className="summary-card"><span className="subtle">Leverage</span><strong>{session.leverage.toFixed(2)}x</strong></article>
        <article className="summary-card"><span className="subtle">Pair funding</span><strong>{formatTimestamp(session.pair_funding_time)}</strong></article>
        <article className="summary-card"><span className="subtle">Scheduled entry</span><strong>{formatTimestamp(session.scheduled_entry_at)}</strong></article>
        <article className="summary-card"><span className="subtle">Scheduled exit</span><strong>{formatTimestamp(session.scheduled_exit_at)}</strong></article>
        <article className="summary-card"><span className="subtle">Cancel until</span><strong>{formatTimestamp(session.cancellable_until)}</strong></article>
        <article className="summary-card"><span className="subtle">Current phase</span><strong>{session.current_phase}</strong></article>
        <article className="summary-card"><span className="subtle">Projected net</span><strong>{formatUsd(session.expected_net_pnl_usd)}</strong></article>
        <article className="summary-card"><span className="subtle">Projected return</span><strong>{formatPct(session.expected_net_return_on_capital_percent)}</strong></article>
        <article className="summary-card"><span className="subtle">Realized net</span><strong>{formatUsd(session.realized_net_pnl_usd ?? session.expected_net_pnl_usd)}</strong></article>
        <article className={`summary-card trade-summary-tone trade-summary-tone-${netTone}`}><span className="subtle">Net return on capital</span><strong>{formatPct(netReturnPercent)}</strong></article>
      </div>

      <div className="trade-plan-grid">
        {[session.long_leg, session.short_leg].map((leg) => (
          <article key={`${session.id}-${leg.exchange}-${leg.exchange_symbol}`} className={`overview-card compare-exchange-card ${exchangeToneClass(leg.exchange)}`}>
            <div className="overview-card-header">
              <div>
                <p className="eyebrow">{getTradeLegLabel(leg)}</p>
                <strong>{leg.display_name}</strong>
              </div>
              <span className={`quality-badge quality-${leg.status === "closed" ? "positive" : leg.status === "failed" ? "danger" : "neutral"}`}>{leg.status}</span>
            </div>
            <div className="detail-grid compare-detail-grid">
              <div><span className="subtle">Exchange symbol</span><strong>{leg.exchange_symbol}</strong></div>
              <div><span className="subtle">Side</span><strong>{leg.side.toUpperCase()}</strong></div>
              <div><span className="subtle">Reference price</span><strong>{formatUsd(leg.reference_price)}</strong></div>
              <div><span className="subtle">Quantity</span><strong>{leg.estimated_quantity.toFixed(6)}</strong></div>
              <div><span className="subtle">Leverage</span><strong>{leg.leverage.toFixed(2)}x</strong></div>
              <div><span className="subtle">Max leverage</span><strong>{formatLeverage(leg.max_leverage)}</strong></div>
              <div><span className="subtle">Notional</span><strong>{formatUsd(leg.notional_usd)}</strong></div>
              <div><span className="subtle">Initial margin</span><strong>{formatUsd(leg.initial_margin_usd)}</strong></div>
              <div><span className="subtle">Entry order ID</span><strong>{leg.entry_order_id ?? "pending"}</strong></div>
              <div><span className="subtle">Exit order ID</span><strong>{leg.exit_order_id ?? "pending"}</strong></div>
              <div><span className="subtle">Entry fill</span><strong>{formatUsd(leg.entry_fill_price)}</strong></div>
              <div><span className="subtle">Exit fill</span><strong>{formatUsd(leg.exit_fill_price)}</strong></div>
            </div>
            {leg.support_note ? <p className="subtle trade-support-note">{leg.support_note}</p> : null}
            <a href={leg.trade_url} target="_blank" rel="noreferrer" className="action-button secondary-button trade-leg-link">
              Open {leg.display_name}
            </a>
          </article>
        ))}
      </div>

      <div className="trade-report-grid">
        <article className="overview-card trade-report-card">
          <div className="overview-card-header">
            <div>
              <p className="eyebrow">Outcome</p>
              <strong>{session.realized_net_pnl_usd == null ? "Projected until completion" : "Completed trade outcome"}</strong>
            </div>
          </div>
          <div className="detail-grid compare-detail-grid">
            <div><span className="subtle">Projected funding capture</span><strong>{formatUsd(session.expected_funding_pnl_usd)}</strong></div>
            <div><span className="subtle">Estimated fees</span><strong>{formatUsd(session.estimated_total_fees_usd)}</strong></div>
            <div><span className="subtle">Realized price PnL</span><strong>{formatUsd(session.realized_price_pnl_usd)}</strong></div>
            <div><span className="subtle">Realized funding PnL</span><strong>{formatUsd(session.realized_funding_pnl_usd)}</strong></div>
            <div><span className="subtle">Realized total fees</span><strong>{formatUsd(session.realized_total_fees_usd)}</strong></div>
            <div><span className="subtle">Updated</span><strong>{formatTimestamp(session.updated_at)}</strong></div>
          </div>
        </article>

        <article className="overview-card trade-report-card">
          <div className="overview-card-header">
            <div>
              <p className="eyebrow">Warnings</p>
              <strong>{session.warnings.length ? `${session.warnings.length} item${session.warnings.length === 1 ? "" : "s"}` : "No warnings recorded"}</strong>
            </div>
          </div>
          {session.warnings.length ? (
            <ul className="warning-list compare-warning-list">
              {session.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : (
            <p className="subtle">The session finished without adding extra warnings beyond the initial risk checks.</p>
          )}
          <p className="subtle trade-inline-note">{getCancelTradeNote(session, nowTimestamp)}</p>
        </article>
      </div>

      <article className="overview-card trade-report-card trade-event-card">
        <div className="overview-card-header">
          <div>
            <p className="eyebrow">Event Log</p>
            <strong>{session.events.length} event{session.events.length === 1 ? "" : "s"} captured</strong>
          </div>
        </div>
        <div className="recent-alert-list">
          {session.events.map((event) => (
            <div key={`${session.id}-${event.at}-${event.phase}-${event.message}`} className={`alert-log-item trade-event-log trade-event-level-${event.level}`}>
              <div className="alert-item-top">
                <strong>{event.phase}</strong>
                <span>{formatTimestamp(event.at)}</span>
              </div>
              <div className="subtle">{event.message}</div>
            </div>
          ))}
        </div>
      </article>
    </div>
  );
}

export function SymbolTradePage({ canonicalSymbol }: { canonicalSymbol: string }) {
  const [paperTradingEnabled, setPaperTradingEnabled] = useState(true);
  const [scenario, setScenario] = useState<"best" | "reverse">("best");
  const [capitalInput, setCapitalInput] = useState("1000");
  const [leverageInput, setLeverageInput] = useState("2");
  const [entrySecondsBefore, setEntrySecondsBefore] = useState("30");
  const [exitSecondsAfter, setExitSecondsAfter] = useState("15");
  const [rememberCredentials, setRememberCredentials] = useState(() => Object.keys(readStoredCredentials()).length > 0);
  const [credentials, setCredentials] = useState<TradeCredentialState>(() => readStoredCredentials());
  const [isPaperGuideOpen, setIsPaperGuideOpen] = useState(() => !readPaperGuideSeen());
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const [credentialFileNotice, setCredentialFileNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const nowTimestamp = useNow(1000);
  const selectedExchanges = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    const exchanges = params.get("exchanges");
    return exchanges ? exchanges.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean) : [];
  }, []);

  const { comparison, loading, error } = useSymbolComparison(canonicalSymbol, selectedExchanges);
  const bestOpportunity = comparison?.best_opportunity ?? null;
  const capitalUsd = Number(capitalInput) > 0 ? Number(capitalInput) : 1000;
  const leverage = Number(leverageInput) > 0 ? Number(leverageInput) : 2;
  const entryLeadSeconds = Math.max(0, Number(entrySecondsBefore) || 30);
  const exitLagSeconds = Math.max(0, Number(exitSecondsAfter) || 15);

  const { plan: bestPlan, loading: bestPlanLoading, error: bestPlanError } = useExecutionPlan(bestOpportunity?.canonical_symbol ?? null, Boolean(bestOpportunity), selectedExchanges, {
    capitalUsd,
    leverage,
    holdingPeriods: 1,
    reverse: false,
  });
  const { plan: reversePlan, loading: reversePlanLoading, error: reversePlanError } = useExecutionPlan(bestOpportunity?.canonical_symbol ?? null, Boolean(bestOpportunity), selectedExchanges, {
    capitalUsd,
    leverage,
    holdingPeriods: 1,
    reverse: true,
  });
  const { session, history, loading: sessionLoading, error: sessionError, createSession, cancelSession, clearHistory } = useTradeSession(canonicalSymbol);

  const activePlan = scenario === "reverse" ? reversePlan : bestPlan;
  const planLoading = scenario === "reverse" ? reversePlanLoading : bestPlanLoading;
  const planError = scenario === "reverse" ? reversePlanError : bestPlanError;
  const activeOpportunity = useMemo(() => {
    if (!bestOpportunity) return null;
    return scenario === "reverse"
      ? { ...bestOpportunity, long_leg: bestOpportunity.short_leg, short_leg: bestOpportunity.long_leg, spread_rate: -bestOpportunity.spread_rate, net_apr_percent: -bestOpportunity.net_apr_percent, gross_apr_percent: -bestOpportunity.gross_apr_percent }
      : bestOpportunity;
  }, [bestOpportunity, scenario]);
  const fundingTime = useMemo(() => (activeOpportunity ? getNextFundingTime(activeOpportunity) : null), [activeOpportunity]);
  const scheduledEntryAt = fundingTime ? new Date(new Date(fundingTime).getTime() - entryLeadSeconds * 1000).toISOString() : null;
  const scheduledExitAt = fundingTime ? new Date(new Date(fundingTime).getTime() + exitLagSeconds * 1000).toISOString() : null;
  const longSupport = activeOpportunity ? buildSupportNote(activeOpportunity.long_leg.exchange) : null;
  const shortSupport = activeOpportunity ? buildSupportNote(activeOpportunity.short_leg.exchange) : null;
  const liveModeAvailable = Boolean(longSupport?.live && shortSupport?.live);
  const requiredExchanges = useMemo(() => (activeOpportunity ? [activeOpportunity.long_leg.exchange, activeOpportunity.short_leg.exchange] : []), [activeOpportunity]);
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
  const localTradeHistory = useMemo(
    () => history.filter((item) => item.canonical_symbol.toUpperCase() === canonicalSymbol.toUpperCase()),
    [canonicalSymbol, history],
  );
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
    await createSession({
      canonical_symbol: activeOpportunity.canonical_symbol,
      selected_exchanges: selectedExchanges as ExchangeName[],
      mode,
      scenario,
      capital_usd: capitalUsd,
      leverage,
      holding_periods: 1,
      basis_risk_buffer_percent: 0.35,
      schedule: { entry_seconds_before_funding: entryLeadSeconds, exit_seconds_after_funding: exitLagSeconds },
      credentials: mode === "live" ? liveCredentialPayload : [],
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

  return (
    <main className="page compare-page trade-page">
      <section className="hero compare-hero">
        <div>
          <p className="eyebrow">Trade Workspace</p>
          <h1>{comparison?.canonical_symbol ?? canonicalSymbol}</h1>
          <p className="lede">Review the live hedge, choose best or reverse, load exchange credentials locally, and arm either a paper run or a real scheduled execution around funding.</p>
          <div className="compare-top-actions">
            <a href="/trade" className="action-button secondary-button compare-link">Back to trade desk</a>
            <a href={`/compare/${encodeURIComponent(canonicalSymbol)}${selectedExchanges.length ? `?exchanges=${encodeURIComponent(selectedExchanges.join(","))}` : ""}`} className="action-button secondary-button compare-link">Open compare</a>
          </div>
        </div>
        <div className="hero-card compare-hero-card">
          <span className="chip">{paperTradingEnabled ? "Paper mode" : "Live mode"}</span>
          <strong>{activePlan ? `${activePlan.long_leg.display_name} / ${activePlan.short_leg.display_name}` : "Waiting for plan"}</strong>
          <p>Entry starts {scheduledEntryAt ? formatCountdown(scheduledEntryAt, nowTimestamp) : "n/a"} before funding and exits {exitLagSeconds}s after the new funding window opens.</p>
          <label className="trade-mode-toggle">
            <input type="checkbox" checked={paperTradingEnabled} onChange={(event) => handlePaperTradingToggle(event.target.checked)} />
            <span className="trade-mode-toggle-label">
              <strong>Paper trading</strong>
              <span className="subtle">{paperTradingEnabled ? "Demo credentials and simulated fills are active." : "Live credentials and real orders are active."}</span>
            </span>
          </label>
          {!paperTradingEnabled && !liveModeAvailable ? <p className="subtle">Live mode is limited because one leg is still paper-only for this setup.</p> : null}
        </div>
      </section>

      {error ? <div className="banner banner-error">{error}</div> : null}
      {planError ? <div className="banner banner-error">{planError}</div> : null}
      {sessionError ? <div className="banner banner-error">{sessionError}</div> : null}
      {credentialFileNotice ? <div className="banner">{credentialFileNotice}</div> : null}

      <section className="summary-grid compare-summary-grid">
        <article className="summary-card"><span className="subtle">Pair funding</span><strong>{fundingTime ? formatCountdown(fundingTime, nowTimestamp) : "n/a"}</strong></article>
        <article className="summary-card"><span className="subtle">Entry starts</span><strong>{scheduledEntryAt ? formatCountdown(scheduledEntryAt, nowTimestamp) : "n/a"}</strong></article>
        <article className="summary-card"><span className="subtle">Exit starts</span><strong>{scheduledExitAt ? formatCountdown(scheduledExitAt, nowTimestamp) : "n/a"}</strong></article>
        <article className="summary-card"><span className="subtle">Cancel closes</span><strong>{scheduledEntryAt ? formatCountdown(new Date(new Date(scheduledEntryAt).getTime() - CANCEL_LOCK_WINDOW_MINUTES * 60_000).toISOString(), nowTimestamp) : "n/a"}</strong></article>
        <article className="summary-card"><span className="subtle">Mode</span><strong>{paperTradingEnabled ? "paper" : "live"}</strong></article>
        <article className="summary-card"><span className="subtle">Scenario</span><strong>{scenario === "best" ? "Best setup" : "Reverse setup"}</strong></article>
      </section>

      <section className="panel compare-panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Trade Setup</p>
            <h2>Choose the exact hedge to arm</h2>
            <div className="subtle">Paper and live use the same execution plan. The paper layer stays visible so you can test the path before firing real orders.</div>
          </div>
          <div className="panel-note">{planLoading ? "Refreshing plan" : activePlan ? "Plan ready" : loading ? "Loading pair" : "No live pair"}</div>
        </div>

        <div className="execution-controls">
          <div className="execution-capital-group">
            <label className="control execution-capital-input"><span className="subtle">Capital (USD)</span><input type="number" min="1" step="any" value={capitalInput} onChange={(event) => setCapitalInput(event.target.value)} /></label>
            <label className="control execution-capital-input"><span className="subtle">Leverage</span><input type="number" min="1" step="0.1" value={leverageInput} onChange={(event) => setLeverageInput(event.target.value)} /></label>
            <label className="control execution-capital-input"><span className="subtle">Enter before funding (s)</span><input type="number" min="0" step="1" value={entrySecondsBefore} onChange={(event) => setEntrySecondsBefore(event.target.value)} /></label>
            <label className="control execution-capital-input"><span className="subtle">Exit after funding (s)</span><input type="number" min="0" step="1" value={exitSecondsAfter} onChange={(event) => setExitSecondsAfter(event.target.value)} /></label>
          </div>
          <div className="execution-scenario-toggle">
            <button type="button" className={`overview-button execution-chip ${scenario === "best" ? "execution-chip-active" : ""}`} onClick={() => setScenario("best")}>Best setup</button>
            <button type="button" className={`overview-button execution-chip ${scenario === "reverse" ? "execution-chip-active" : ""}`} onClick={() => setScenario("reverse")}>Reverse setup</button>
          </div>
        </div>

        {activePlan && activeOpportunity ? (
          <div className="trade-plan-grid">
            {[activeOpportunity.long_leg, activeOpportunity.short_leg].map((leg) => {
              const support = buildSupportNote(leg.exchange);
              const comparisonRow = comparison?.exchanges.find((item) => item.exchange === leg.exchange && item.exchange_symbol === leg.exchange_symbol) ?? null;
              const executionLeg = leg.exchange === activeOpportunity.long_leg.exchange ? activePlan.long_leg : activePlan.short_leg;
              return (
                <article key={`${leg.exchange}-${leg.exchange_symbol}`} className={`overview-card compare-exchange-card ${exchangeToneClass(leg.exchange)}`}>
                  <div className="overview-card-header">
                    <div>
                      <p className="eyebrow">{leg.exchange === activeOpportunity.long_leg.exchange ? "Long leg" : "Short leg"}</p>
                      <strong>{leg.display_name}</strong>
                    </div>
                    <span className={`quality-badge quality-${support.live ? "positive" : "warning"}`}>{support.live ? "Live-ready" : "Paper-only"}</span>
                  </div>
                  <div className="detail-grid compare-detail-grid">
                    <div><span className="subtle">Funding</span><strong>{formatFundingRate(leg.funding_rate)}</strong></div>
                    <div><span className="subtle">Next funding</span><strong>{formatCountdown(leg.next_funding_time, nowTimestamp)}</strong></div>
                    <div><span className="subtle">Quantity</span><strong>{executionLeg.estimated_quantity.toFixed(6)}</strong></div>
                    <div><span className="subtle">Max leverage</span><strong>{formatLeverage(leg.max_leverage)}</strong></div>
                    <div><span className="subtle">Margin required</span><strong>{formatUsd(executionLeg.initial_margin_usd)}</strong></div>
                    <div><span className="subtle">Estimated fees</span><strong>{formatUsd(executionLeg.estimated_entry_fee_usd + executionLeg.estimated_exit_fee_usd)}</strong></div>
                  </div>
                  {comparisonRow ? (
                    <div className="quality-badge-row compare-capability-row">
                      {getExchangeCapabilityBadges(comparisonRow).map((badge) => (
                        <span key={badge.label} className={`quality-badge quality-${badge.tone}`}>{badge.label}</span>
                      ))}
                    </div>
                  ) : null}
                  <p className="subtle trade-support-note">{support.note}</p>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="empty-state"><p>{loading ? "Loading trade setup..." : "No live trade setup is available right now."}</p></div>
        )}
      </section>

      <section className="panel compare-panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Credentials</p>
            <h2>Keep keys local to the browser or a file</h2>
            <div className="subtle">Keys are never written to our database. Live sessions keep them only in memory while the trade is armed and clear them after completion.</div>
          </div>
          <div className="panel-note">{paperTradingEnabled ? "Demo credentials auto-loaded" : "Needed for live mode"}</div>
        </div>

        <div className="button-row">
          <label className="toggle-row"><input type="checkbox" checked={rememberCredentials} onChange={(event) => { setRememberCredentials(event.target.checked); persistCredentials(event.target.checked, credentials); setCredentialFileNotice(event.target.checked ? "Live credentials will be kept on this device until you switch this off." : "Stored device credentials were cleared from local storage."); }} /><span>Remember on this device</span></label>
          <button type="button" className="action-button secondary-button" onClick={exportKeysFile}>Export keys file</button>
          <button type="button" className="action-button secondary-button" onClick={() => fileInputRef.current?.click()}>Import keys file</button>
          <input ref={fileInputRef} type="file" accept="application/json" hidden onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) {
              void importKeysFile(file);
            }
            event.currentTarget.value = "";
          }} />
        </div>

        <div className="trade-credentials-grid">
          {credentialInputs.map((item) => (
            <article key={item.exchange} className={`overview-card compare-exchange-card ${exchangeToneClass(item.exchange)}`}>
              <div className="overview-card-header">
                <div><p className="eyebrow">{item.displayName}</p><strong>{paperTradingEnabled ? "Demo credentials" : item.support.live ? "Live supported" : "Paper only"}</strong></div>
                <span className={`quality-badge quality-${paperTradingEnabled ? "neutral" : item.support.live ? "positive" : "warning"}`}>{paperTradingEnabled ? "Simulation" : item.support.live ? "Use for live" : "Preview only"}</span>
              </div>
              <label className="control"><span className="subtle">API key</span><input value={item.value.api_key} onChange={(event) => setCredentialValue(item.exchange, "api_key", event.target.value)} placeholder={`${item.displayName} API key`} disabled={paperTradingEnabled} /></label>
              <label className="control"><span className="subtle">API secret</span><input type="password" value={item.value.api_secret} onChange={(event) => setCredentialValue(item.exchange, "api_secret", event.target.value)} placeholder={`${item.displayName} API secret`} disabled={paperTradingEnabled} /></label>
              {item.exchange === "coinswitch" ? (
                <label className="control"><span className="subtle">CoinSwitch exchange code</span><input value={item.value.extra?.exchange ?? DEFAULT_COINSWITCH_EXCHANGE} onChange={(event) => setCredentialExtra(item.exchange, "exchange", event.target.value)} placeholder={DEFAULT_COINSWITCH_EXCHANGE} disabled={paperTradingEnabled} /></label>
              ) : null}
              <p className="subtle trade-support-note">{paperTradingEnabled ? "Demo credentials are auto-filled only for a realistic paper simulation. No live exchange authentication is attempted." : item.support.note}</p>
            </article>
          ))}
        </div>
      </section>

      {activePlan ? (
        <section className="panel compare-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Execution Preview</p>
              <h2>What gets sent when the trade arms</h2>
              <div className="subtle">This preview stays visible in both paper and live mode so you can test the exact same setup before sending real orders.</div>
            </div>
          </div>

          <div className="execution-outcome-grid">
            <article className="overview-card execution-outcome-card execution-outcome-card-active">
              <div className="overview-card-header">
                <div><p className="eyebrow">{paperTradingEnabled ? "Projected paper result" : "Projected result"}</p><strong>{formatUsd(activePlan.expected_net_pnl_usd)}</strong></div>
                <span className={activePlan.expected_net_pnl_usd >= 0 ? "phase-pill" : "overview-badge negative-badge"}>{formatPct(activePlan.expected_net_return_on_capital_percent)}</span>
              </div>
              <div className="detail-grid compare-detail-grid">
                <div><span className="subtle">Long exchange/order</span><strong>{activePlan.long_leg.display_name} | {activePlan.long_leg.side.toUpperCase()}</strong></div>
                <div><span className="subtle">Short exchange/order</span><strong>{activePlan.short_leg.display_name} | {activePlan.short_leg.side.toUpperCase()}</strong></div>
                <div><span className="subtle">Estimated fees</span><strong>{formatUsd(activePlan.estimated_total_fees_usd)}</strong></div>
                <div><span className="subtle">Expected funding capture</span><strong>{formatUsd(activePlan.estimated_funding_pnl_usd)}</strong></div>
              </div>
            </article>
            <article className="overview-card execution-outcome-card">
              <div className="overview-card-header">
                <div><p className="eyebrow">Risk warnings</p><strong>Review before arming</strong></div>
              </div>
              <ul className="warning-list compare-warning-list">
                {[...activePlan.warnings, ...(longSupport?.note ? [longSupport.note] : []), ...(shortSupport?.note ? [shortSupport.note] : [])].map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </article>
          </div>

          <div className="button-row">
            <button type="button" className="action-button" onClick={() => void armTrade()} disabled={sessionLoading || !activePlan || (!paperTradingEnabled && !liveModeAvailable)}>
              {paperTradingEnabled ? "Arm paper trade" : "Arm live trade"}
            </button>
          </div>
        </section>
      ) : null}

      <section className="panel compare-panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Trade Session</p>
            <h2>{session ? "Live session status" : "No armed session yet"}</h2>
            <div className="subtle">Once armed, the backend waits for the entry window, places both legs, and exits after the configured funding delay.</div>
          </div>
          {session ? <div className="panel-note">{session.current_phase}</div> : null}
        </div>

        {session ? (
          <>
            <div className="summary-grid compare-summary-grid">
              <article className="summary-card"><span className="subtle">Status</span><strong>{session.status}</strong></article>
              <article className="summary-card"><span className="subtle">Entry window</span><strong>{formatCountdown(session.scheduled_entry_at, nowTimestamp)}</strong></article>
              <article className="summary-card"><span className="subtle">Exit window</span><strong>{formatCountdown(session.scheduled_exit_at, nowTimestamp)}</strong></article>
              <article className="summary-card"><span className="subtle">{session.realized_net_pnl_usd == null ? "Projected net" : "Realized net"}</span><strong>{formatUsd(session.realized_net_pnl_usd ?? session.expected_net_pnl_usd)}</strong></article>
            </div>

            <div className="trade-plan-grid">
              {[session.long_leg, session.short_leg].map((leg) => (
                <article key={`${leg.exchange}-${leg.exchange_symbol}`} className={`overview-card compare-exchange-card ${exchangeToneClass(leg.exchange)}`}>
                  <div className="overview-card-header">
                    <div><p className="eyebrow">{leg.side === "buy" ? "Long leg" : "Short leg"}</p><strong>{leg.display_name}</strong></div>
                    <span className={`quality-badge quality-${leg.status === "failed" ? "danger" : leg.status === "closed" ? "positive" : "neutral"}`}>{leg.status}</span>
                  </div>
                  <div className="detail-grid compare-detail-grid">
                    <div><span className="subtle">Entry order id</span><strong>{leg.entry_order_id ?? "pending"}</strong></div>
                    <div><span className="subtle">Exit order id</span><strong>{leg.exit_order_id ?? "pending"}</strong></div>
                    <div><span className="subtle">Entry fill</span><strong>{formatUsd(leg.entry_fill_price)}</strong></div>
                    <div><span className="subtle">Exit fill</span><strong>{formatUsd(leg.exit_fill_price)}</strong></div>
                  </div>
                </article>
              ))}
            </div>

            <div className="button-row">
              <button type="button" className="action-button secondary-button" onClick={() => void cancelSession(session.id)} disabled={sessionLoading || !sessionCanCancel}>Cancel session</button>
              {isTerminalTradeStatus(session.status) ? (
                <button type="button" className="action-button secondary-button" onClick={() => exportTradePdf(session)}>
                  Export PDF
                </button>
              ) : null}
            </div>
            <p className="subtle trade-inline-note">{cancelTradeNote}</p>

            <div className="recent-alert-list">
              {session.events.map((event) => (
                <div key={`${event.at}-${event.phase}-${event.message}`} className="alert-log-item">
                  <div className="alert-item-top"><strong>{event.phase}</strong><span>{formatTimestamp(event.at)}</span></div>
                  <div className="subtle">{event.message}</div>
                </div>
              ))}
            </div>

            {session.realized_net_pnl_usd != null ? (
              <div className="summary-grid compare-summary-grid trade-realized-grid">
                <article className="summary-card"><span className="subtle">Price PnL</span><strong>{formatUsd(session.realized_price_pnl_usd)}</strong></article>
                <article className="summary-card"><span className="subtle">Funding captured</span><strong>{formatUsd(session.realized_funding_pnl_usd)}</strong></article>
                <article className="summary-card"><span className="subtle">Total fees</span><strong>{formatUsd(session.realized_total_fees_usd)}</strong></article>
                <article className="summary-card"><span className="subtle">Net result</span><strong>{formatUsd(session.realized_net_pnl_usd)}</strong></article>
              </div>
            ) : null}
          </>
        ) : (
          <div className="empty-state">
            <p>No trade is armed yet.</p>
            <span>Set the scenario, choose paper or live, then arm the schedule from the execution preview above.</span>
          </div>
        )}
      </section>

      {completedSession ? (
        <section className="panel compare-panel trade-report-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Completed Trade Summary</p>
              <h2>Full post-trade report</h2>
              <div className="subtle">This report keeps the full event timeline, both legs, realized result, and the exact trade context so you can review what happened end to end.</div>
            </div>
            <div className="button-row trade-session-actions">
              <button type="button" className="action-button secondary-button" onClick={() => setSelectedReportId(completedSession.id)}>
                Open full summary
              </button>
              <button type="button" className="action-button secondary-button" onClick={() => exportTradePdf(completedSession)}>
                Export PDF
              </button>
            </div>
          </div>
          <TradeReportContent session={completedSession} nowTimestamp={nowTimestamp} />
        </section>
      ) : null}

      <section className="panel compare-panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Local Trade History</p>
            <h2>Saved only in this browser</h2>
            <div className="subtle">Trade history stays in local browser storage for this device. It is not written to our server database.</div>
          </div>
          {localTradeHistory.length ? (
            <button type="button" className="action-button secondary-button" onClick={clearHistory}>
              Clear local history
            </button>
          ) : null}
        </div>

        {localTradeHistory.length ? (
          <div className="recent-alert-list">
            {localTradeHistory.map((item) => (
              <article key={item.id} className="alert-log-item trade-history-item">
                <div className="alert-item-top">
                  <div>
                    <strong>{item.scenario === "best" ? "Best setup" : "Reverse setup"}</strong>
                    <div className="subtle">{item.mode === "paper" ? "Paper" : "Live"} | {item.status}</div>
                  </div>
                  <span>{formatTimestamp(item.updated_at)}</span>
                </div>
                <div className="trade-history-metrics">
                  <div><span className="subtle">Capital</span><strong>{formatUsd(item.capital_input_usd)}</strong></div>
                  <div><span className="subtle">Leverage</span><strong>{item.leverage.toFixed(2)}x</strong></div>
                  <div><span className="subtle">{item.realized_net_pnl_usd == null ? "Projected net" : "Realized net"}</span><strong>{formatUsd(item.realized_net_pnl_usd ?? item.expected_net_pnl_usd)}</strong></div>
                  <div><span className="subtle">Entry window</span><strong>{item.scheduled_entry_at ? formatTimestamp(item.scheduled_entry_at) : "n/a"}</strong></div>
                </div>
                <div className="button-row trade-history-actions">
                  <button type="button" className="action-button secondary-button" onClick={() => setSelectedReportId(item.id)}>
                    View full summary
                  </button>
                  <button type="button" className="action-button secondary-button" onClick={() => exportTradePdf(item)}>
                    Export PDF
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <p>No local trade history yet.</p>
            <span>Once you arm a paper or live trade, the session log and outcome will stay in this browser for quick review.</span>
          </div>
        )}
      </section>

      {isPaperGuideOpen ? (
        <div className="modal-backdrop" onClick={closePaperGuide}>
          <aside className="inspector-modal paper-guide-modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <div className="inspector-header">
              <div>
                <p className="eyebrow">Paper Trading Guide</p>
                <h3>How this futures simulation works</h3>
                <p className="subtle">This overlay appears when paper trading is enabled so the user understands exactly what is simulated and what is still real market data.</p>
              </div>
              <button type="button" className="close-button" onClick={closePaperGuide}>
                Close
              </button>
            </div>

            <div className="trade-guide-grid">
              <article className="overview-card">
                <div className="overview-card-header"><strong>What is real</strong></div>
                <ul className="warning-list">
                  <li>Funding rates, exchange scope, timing, quantity estimates, fees, and leverage checks come from the live market feed.</li>
                  <li>The same symbol, best setup, reverse setup, and scheduling logic are used in both paper and live mode.</li>
                  <li>The countdown to entry and exit follows the real funding clock for the chosen pair.</li>
                </ul>
              </article>
              <article className="overview-card">
                <div className="overview-card-header"><strong>What is simulated</strong></div>
                <ul className="warning-list">
                  <li>Demo credentials are auto-filled locally so the workflow feels like a real execution path without touching exchange accounts.</li>
                  <li>Entry and exit orders are marked as filled at the planned reference prices.</li>
                  <li>No real balance, position, or API authentication is used in paper mode.</li>
                </ul>
              </article>
              <article className="overview-card">
                <div className="overview-card-header"><strong>Futures caution</strong></div>
                <ul className="warning-list">
                  <li>Leverage increases liquidation risk even when the funding spread looks attractive.</li>
                  <li>One-leg fill risk, fee drag, venue limits, and slippage can change the real result versus the model.</li>
                  <li>Use paper mode first, then switch off the toggle only when you are comfortable with the same exact setup.</li>
                </ul>
              </article>
            </div>

            <div className="button-row">
              <button type="button" className="action-button" onClick={closePaperGuide}>
                Continue in paper mode
              </button>
            </div>
          </aside>
        </div>
      ) : null}

      {selectedReportSession ? (
        <div className="modal-backdrop" onClick={() => setSelectedReportId(null)}>
          <aside className="inspector-modal trade-summary-modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <div className="inspector-header">
              <div>
                <p className="eyebrow">Trade Summary</p>
                <h3>{selectedReportSession.canonical_symbol}</h3>
                <p className="subtle">Full local report for this {selectedReportSession.mode} {selectedReportSession.scenario === "best" ? "best-setup" : "reverse-setup"} trade, including every event recorded during the session.</p>
              </div>
              <div className="button-row trade-session-actions">
                <button type="button" className="action-button secondary-button" onClick={() => exportTradePdf(selectedReportSession)}>
                  Export PDF
                </button>
                <button type="button" className="close-button" onClick={() => setSelectedReportId(null)}>
                  Close
                </button>
              </div>
            </div>
            <TradeReportContent session={selectedReportSession} nowTimestamp={nowTimestamp} />
          </aside>
        </div>
      ) : null}
    </main>
  );
}
