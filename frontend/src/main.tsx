import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { SymbolComparisonPage } from "./pages/SymbolComparisonPage";
import "./styles.css";

function resolveRoute() {
  const pathname = window.location.pathname;
  if (pathname.startsWith("/compare/")) {
    const canonicalSymbol = decodeURIComponent(pathname.replace("/compare/", "").trim());
    return <SymbolComparisonPage key={pathname} canonicalSymbol={canonicalSymbol} />;
  }

  return <App key={pathname} />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {resolveRoute()}
  </React.StrictMode>,
);
