import { type ReactNode, useCallback, useEffect, useState } from "react";
import { AdminPanel } from "../components/AdminPanel";
import type { ExchangeStatus } from "../lib/types";
import { CommandPalette } from "./palette";
import { useMediaQuery } from "./prefs";
import { CompareDialog, Dialog, FeedsPanel } from "./panels";
import { BrandMark, Icon } from "./primitives";
import "./design.css";
import "./legacy.css";
import "./features.css";
import "./apple.css";
import "./nav.css";

export type NavKey = "dashboard" | "trade" | "results" | "backtest";
export type ActiveKey = NavKey | "compare" | "learn";
export type SectionTab = "health" | "leaders" | "heatmap" | "trends" | "calendar" | "settlements" | "alerts";

const API_BASE = import.meta.env.VITE_API_URL ?? "/api";
const THEME_KEY = "arbradar-theme";
export const TELEGRAM_BOT_URL = "https://t.me/alertbklbot";

/** The one navigation model. The top bar (wide screens) and the dock (everything else) both render this. */
export const NAV: Array<{ key: NavKey; label: string; href: string; icon: ReactNode }> = [
  { key: "dashboard", label: "Dashboard", href: "/", icon: Icon.pairs },
  { key: "trade", label: "Trade", href: "/trade", icon: Icon.trade },
  { key: "results", label: "Results", href: "/performance", icon: Icon.leaders },
  { key: "backtest", label: "Backtest", href: "/backtest", icon: Icon.clock },
];

export function useTheme() {
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

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** Android and desktop Chrome offer a real install prompt; iPhone and iPad only have Share, Add to Home Screen. */
export function useInstall() {
  const [event, setEvent] = useState<InstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(() => isStandalone());
  useEffect(() => {
    const onPrompt = (next: Event) => {
      next.preventDefault();
      setEvent(next as InstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setEvent(null);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return {
    installed,
    canPrompt: Boolean(event),
    showIosHint: ios && !installed,
    install: async () => {
      if (!event) return;
      await event.prompt();
      await event.userChoice;
      setEvent(null);
    },
  };
}

export interface MoreItem {
  label: string;
  description: string;
  href?: string;
  external?: boolean;
  onClick?: () => void;
}

interface AppChromeProps {
  active: ActiveKey;
  children: ReactNode;
  /** Sits between the brand and the links (the dashboard's exchange feed pills). */
  topMiddle?: ReactNode;
  /** Sits before the theme and key buttons (the dashboard's search). */
  topActions?: ReactNode;
  hideBrandText?: boolean;
  /** Page-specific actions, shown under "On this page" in the More sheet. */
  moreExtras?: MoreItem[];
  /** The dashboard switches its own tabs in place; other pages link to /?tab=... */
  onSection?: (tab: SectionTab) => void;
  exchangesQuery?: string;
  legacy?: boolean;
}

function scrollTop() {
  window.scrollTo({ top: 0, behavior: "smooth" });
}

export function AppChrome({ active, children, topMiddle, topActions, hideBrandText, moreExtras = [], onSection, exchangesQuery = "", legacy = false }: AppChromeProps) {
  const [theme, setTheme] = useTheme();
  const [panel, setPanel] = useState<null | "more" | "compare" | "ios" | "jump">(null);
  const [scrolled, setScrolled] = useState(false);
  const install = useInstall();
  const wide = useMediaQuery("(min-width: 1100px)");
  const [adminOpen, setAdminOpen] = useState(false);
  const [statuses, setStatuses] = useState<ExchangeStatus[]>([]);
  const closePanel = useCallback(() => setPanel(null), []);

  // A hairline and a little depth appear under the bar once the page scrolls beneath it.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 4);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Cmd/Ctrl+K opens the jump menu from any screen.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPanel((current) => (current === "jump" ? null : "jump"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Feed health for the More sheet is fetched on demand, so every page can show it without owning the data.
  useEffect(() => {
    if (panel !== "more") return;
    let cancelled = false;
    fetch(`${API_BASE}/exchanges/status`)
      .then((response) => (response.ok ? response.json() : []))
      .then((rows: ExchangeStatus[]) => !cancelled && setStatuses(rows))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [panel]);

  // Tapping the page you are already on scrolls to the top instead of reloading it.
  const navigate = (key: NavKey, href: string) => (event: React.MouseEvent) => {
    if (active === key && window.location.pathname === href) {
      event.preventDefault();
      scrollTop();
    }
  };

  const sectionItem = (tab: SectionTab, label: string, description: string): MoreItem =>
    onSection
      ? { label, description, onClick: () => { closePanel(); onSection(tab); scrollTop(); } }
      : { label, description, href: `/?tab=${tab}` };

  const items: MoreItem[] = [
    { label: "Compare a coin", description: "Every exchange side by side for one coin", onClick: () => setPanel("compare") },
    sectionItem("health", "Exchange health", "Feed status for every exchange"),
    sectionItem("leaders", "Funding leaders", "Highest and lowest rates on each exchange"),
    sectionItem("heatmap", "Funding heatmap", "Every coin and exchange, coloured by rate"),
    sectionItem("trends", "Rate history", "How funding rates moved on each exchange"),
    sectionItem("calendar", "Settlement calendar", "The next 24 hours of funding payments"),
    sectionItem("settlements", "Settlements", "Funding payments coming up, soonest first"),
    sectionItem("alerts", "Alerts", "Rules that tell you when a pair is worth a look"),
    ...(install.canPrompt
      ? [{ label: "Install Fundex", description: "Add it to your home screen or dock and open it like an app", onClick: () => { closePanel(); void install.install(); } }]
      : install.showIosHint
        ? [{ label: "Add to Home Screen", description: "Use Fundex like an app on iPhone and iPad", onClick: () => setPanel("ios") }]
        : []),
    { label: "How Fundex works", description: "Funding arbitrage, costs and trust levels explained", href: "/learn" },
    { label: "Telegram bot", description: "Alerts and /next, /coin, /trades in Telegram", href: TELEGRAM_BOT_URL, external: true },
    { label: theme === "dark" ? "Light theme" : "Dark theme", description: "Switch the look", onClick: () => setTheme(theme === "dark" ? "light" : "dark") },
    { label: "Exchange API keys", description: "Admin: fee tier and CoinSwitch access", onClick: () => { closePanel(); setAdminOpen(true); } },
  ];

  // On a laptop the top bar already carries Compare and How it works, and the dashboard tabs carry the sections,
  // so More keeps only what has no other home.
  const sectionLabels = new Set(["Exchange health", "Funding leaders", "Funding heatmap", "Rate history", "Settlement calendar", "Settlements", "Alerts"]);
  const hiddenOnWide = new Set(["Compare a coin", "How Fundex works", ...(onSection ? sectionLabels : [])]);
  const moreItems = wide ? items.filter((item) => !hiddenOnWide.has(item.label)) : items;

  const renderItem = (item: MoreItem) =>
    item.href ? (
      <a key={item.label} className="t-more-item" href={item.href} {...(item.external ? { target: "_blank", rel: "noreferrer" } : {})}>
        <strong>{item.label}</strong>
        <span>{item.description}</span>
      </a>
    ) : (
      <button key={item.label} type="button" className="t-more-item" onClick={item.onClick}>
        <strong>{item.label}</strong>
        <span>{item.description}</span>
      </button>
    );

  return (
    <div className={`t-app ${legacy ? "t-legacy" : ""}`}>
      <header className="t-topbar" data-scrolled={scrolled || undefined}>
        <a className="t-brand" href="/" aria-label="Fundex home">
          <BrandMark />
          <span className={hideBrandText ? "t-hide-phone" : undefined}>Fundex</span>
        </a>
        <nav className="t-nav" aria-label="Sections">
          {NAV.map((item) => (
            <a key={item.key} href={item.href} aria-current={active === item.key ? "page" : undefined} onClick={navigate(item.key, item.href)}>
              {item.icon}
              <span>{item.label}</span>
            </a>
          ))}
          <button type="button" className="t-nav-extra" onClick={() => setPanel("compare")}>
            {Icon.leaders}
            <span>Compare</span>
          </button>
          <a className="t-nav-extra" href="/learn" aria-current={active === "learn" ? "page" : undefined}>
            {Icon.help}
            <span>How it works</span>
          </a>
        </nav>
        {topMiddle}
        <div className="t-topbar-actions">
          {topActions}
          <button type="button" className="t-jump" onClick={() => setPanel("jump")} aria-label="Jump to a coin, page or setting" title="Jump to (Ctrl or Cmd + K)">
            {Icon.search}
            <span className="t-jump-text">Jump to</span>
            <span className="t-kbd">⌘K</span>
          </button>
          <button type="button" className="t-icon-btn t-menu-btn" onClick={() => setPanel("more")} aria-label="More: compare, sections, Telegram bot, keys">
            {Icon.more}
          </button>
          <button type="button" className="t-icon-btn" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}>
            {theme === "dark" ? Icon.sun : Icon.moon}
          </button>
        </div>
      </header>

      {children}

      <nav className="t-dock" aria-label="Main">
        {NAV.map((item) => (
          <a key={item.key} href={item.href} aria-current={active === item.key ? "page" : undefined} onClick={navigate(item.key, item.href)}>
            {item.icon}
            <span>{item.label}</span>
          </a>
        ))}
        <button type="button" aria-expanded={panel === "more"} data-open={panel === "more"} onClick={() => setPanel(panel === "more" ? null : "more")}>
          {Icon.more}
          <span>More</span>
        </button>
      </nav>

      {panel === "more" ? (
        <Dialog title="More" onClose={closePanel}>
          <div className="t-more">{moreItems.map(renderItem)}</div>
          {moreExtras.length ? (
            <>
              <h3 className="t-subhead" style={{ marginTop: 18 }}>
                On this page
              </h3>
              <div className="t-more">{moreExtras.map(renderItem)}</div>
            </>
          ) : null}
          <h3 className="t-subhead" style={{ marginTop: 18 }}>
            Exchange feeds
          </h3>
          <FeedsPanel statuses={statuses} />
        </Dialog>
      ) : null}
      {panel === "jump" ? (
        <CommandPalette pages={NAV.map((item) => ({ label: item.label, href: item.href }))} actions={items} exchangesQuery={exchangesQuery} onClose={closePanel} />
      ) : null}
      {panel === "ios" ? (
        <Dialog title="Add Fundex to your Home Screen" onClose={closePanel}>
          <ol className="ln-steps">
            <li>Tap the <strong>Share</strong> button in Safari's toolbar.</li>
            <li>Scroll down and tap <strong>Add to Home Screen</strong>.</li>
            <li>Tap <strong>Add</strong>. Fundex opens full screen, without the browser bars.</li>
          </ol>
        </Dialog>
      ) : null}
      {panel === "compare" ? <CompareDialog exchangesQuery={exchangesQuery} initial="" onClose={closePanel} /> : null}
      <AdminPanel isOpen={adminOpen} onClose={() => setAdminOpen(false)} />
    </div>
  );
}
