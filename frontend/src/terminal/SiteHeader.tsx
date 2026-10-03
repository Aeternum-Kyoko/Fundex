import { useEffect, useState } from "react";
import { TELEGRAM_BOT_URL } from "./panels";
import { BrandMark, Icon } from "./primitives";
import "./legacy.css";

const THEME_KEY = "arbradar-theme";

function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    try {
      const stored = window.localStorage.getItem(THEME_KEY);
      if (stored === "light" || stored === "dark") return stored;
    } catch {
      // ignore
    }
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem(THEME_KEY, theme);
    } catch {
      // ignore
    }
  }, [theme]);
  return [theme, setTheme] as const;
}

/** Shared chrome for the Compare and Trade pages so every screen navigates the same way. */
export function PageFrame({ children, active }: { children: React.ReactNode; active: "trade" | "compare" | "performance" | "backtest" }) {
  const [theme, setTheme] = useTheme();
  return (
    <div className="t-app t-legacy">
      <header className="t-topbar">
        <a className="t-brand" href="/" aria-label="Fundex dashboard">
          <BrandMark />
          <span>Fundex</span>
        </a>
        <nav className="t-nav t-nav-always" aria-label="Sections">
          <a href="/">Dashboard</a>
          <a href="/trade" aria-current={active === "trade" ? "page" : undefined}>
            Paper & live trade
          </a>
          <a href="/performance" aria-current={active === "performance" ? "page" : undefined}>
            Performance
          </a>
          <a href="/backtest" aria-current={active === "backtest" ? "page" : undefined}>
            Backtest
          </a>
          <a href={TELEGRAM_BOT_URL} target="_blank" rel="noreferrer">
            Telegram bot
          </a>
        </nav>
        <div className="t-topbar-actions">
          <button type="button" className="t-icon-btn" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}>
            {theme === "dark" ? Icon.sun : Icon.moon}
          </button>
        </div>
      </header>
      {children}
      <nav className="t-bottomnav t-bottomnav-legacy" aria-label="Sections">
        <a href="/">
          {Icon.pairs}
          Dashboard
        </a>
        <a href="/trade" aria-selected={active === "trade"}>
          {Icon.trade}
          Trade
        </a>
        <a href="/performance" aria-selected={active === "performance"}>
          {Icon.leaders}
          Results
        </a>
        <a href={TELEGRAM_BOT_URL} target="_blank" rel="noreferrer">
          {Icon.bell}
          Bot
        </a>
      </nav>
    </div>
  );
}
