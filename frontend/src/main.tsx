import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import { PageFrame } from "./terminal/SiteHeader";
import { Terminal } from "./terminal/Terminal";
import "./styles.css";

// Compare and Trade pull in PDF/export libraries; load them only when visited.
const ComparePage = lazy(() => import("./terminal/ComparePage").then((module) => ({ default: module.ComparePage })));
const SymbolTradePage = lazy(() => import("./pages/SymbolTradePage").then((module) => ({ default: module.SymbolTradePage })));
const Performance = lazy(() => import("./terminal/Performance").then((module) => ({ default: module.Performance })));
const Backtest = lazy(() => import("./terminal/Backtest").then((module) => ({ default: module.Backtest })));
const StrategyLab = lazy(() => import("./terminal/StrategyLab").then((module) => ({ default: module.StrategyLab })));
const Learn = lazy(() => import("./terminal/Learn").then((module) => ({ default: module.Learn })));
const TradeHub = lazy(() => import("./terminal/TradeHub").then((module) => ({ default: module.TradeHub })));

function resolveRoute() {
  const pathname = window.location.pathname;
  if (pathname.startsWith("/compare/")) {
    const canonicalSymbol = decodeURIComponent(pathname.replace("/compare/", "").trim());
    return (
      <PageFrame active="compare">
        <ComparePage key={pathname} canonicalSymbol={canonicalSymbol} />
      </PageFrame>
    );
  }
  if (pathname === "/learn") {
    return (
      <PageFrame active="learn">
        <Learn />
      </PageFrame>
    );
  }
  if (pathname === "/backtest") {
    return (
      <PageFrame active="backtest">
        <Backtest />
      </PageFrame>
    );
  }
  if (pathname === "/strategy") {
    return (
      <PageFrame active="backtest">
        <StrategyLab />
      </PageFrame>
    );
  }
  if (pathname === "/performance") {
    return (
      <PageFrame active="results">
        <Performance />
      </PageFrame>
    );
  }
  if (pathname === "/trade") {
    return (
      <PageFrame active="trade">
        <TradeHub key={pathname} />
      </PageFrame>
    );
  }
  if (pathname.startsWith("/trade/")) {
    const canonicalSymbol = decodeURIComponent(pathname.replace("/trade/", "").trim());
    return (
      <PageFrame active="trade">
        <SymbolTradePage key={pathname} canonicalSymbol={canonicalSymbol} />
      </PageFrame>
    );
  }

  return <Terminal key={pathname} />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Suspense fallback={<div className="t-app" style={{ minHeight: "100vh" }} />}>{resolveRoute()}</Suspense>
  </React.StrictMode>,
);

// Offline-capable shell, so Fundex opens instantly once installed. Live data is never cached.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js")
      .then(() => navigator.serviceWorker.ready)
      .then((registration) => {
        const urls = performance.getEntriesByType("resource").map((entry) => entry.name).filter((name) => name.includes("/assets/"));
        registration.active?.postMessage({ type: "precache", urls });
      })
      .catch(() => undefined);
  });
}
