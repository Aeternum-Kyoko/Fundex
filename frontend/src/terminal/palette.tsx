import { useEffect, useMemo, useRef, useState } from "react";
import type { MoreItem } from "./chrome";
import { Icon } from "./primitives";

const API_BASE = import.meta.env.VITE_API_URL ?? "/api";

let symbolsCache: { at: number; promise: Promise<string[]> } | null = null;
function loadSymbols() {
  if (!symbolsCache || Date.now() - symbolsCache.at > 5 * 60_000) {
    symbolsCache = {
      at: Date.now(),
      promise: fetch(`${API_BASE}/symbols`)
        .then((response) => (response.ok ? (response.json() as Promise<string[]>) : []))
        .catch(() => []),
    };
  }
  return symbolsCache.promise;
}

interface Command {
  id: string;
  label: string;
  hint: string;
  group: "Coins" | "Pages" | "Actions";
  run: () => void;
}

/** Jump anywhere: a coin, a page, a dashboard tab or a setting. Opens with Cmd/Ctrl+K from every screen. */
export function CommandPalette({
  pages,
  actions,
  exchangesQuery,
  onClose,
}: {
  pages: Array<{ label: string; href: string }>;
  actions: MoreItem[];
  exchangesQuery: string;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [symbols, setSymbols] = useState<string[]>([]);
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    let cancelled = false;
    void loadSymbols().then((list) => !cancelled && setSymbols(list));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
    };
  }, []);

  const commands = useMemo(() => {
    const needle = query.trim().toUpperCase();
    const out: Command[] = [];
    if (needle) {
      const matches = symbols
        .map((symbol) => ({ symbol, base: symbol.split("-")[0] }))
        .filter((item) => item.base.includes(needle))
        .sort((a, b) => Number(b.base === needle) - Number(a.base === needle) || Number(b.base.startsWith(needle)) - Number(a.base.startsWith(needle)) || a.base.length - b.base.length)
        .slice(0, 6);
      matches.forEach((item, position) => {
        const go = (href: string) => () => {
          onClose();
          window.location.assign(href);
        };
        out.push({ id: `open-${item.symbol}`, label: `${item.base}`, hint: "Open on the dashboard", group: "Coins", run: go(`/${exchangesQuery}#${encodeURIComponent(item.symbol)}`) });
        if (position === 0) {
          out.push({ id: `compare-${item.symbol}`, label: `Compare ${item.base} across exchanges`, hint: "Every exchange side by side", group: "Coins", run: go(`/compare/${encodeURIComponent(item.symbol)}${exchangesQuery}`) });
          out.push({ id: `trade-${item.symbol}`, label: `Trade ${item.base}`, hint: "Paper or live", group: "Coins", run: go(`/trade/${encodeURIComponent(item.symbol)}${exchangesQuery}`) });
        }
      });
    }
    const matchesText = (text: string) => !needle || text.toUpperCase().includes(needle);
    pages
      .filter((page) => matchesText(page.label))
      .forEach((page) => out.push({ id: `page-${page.href}`, label: page.label, hint: "Page", group: "Pages", run: () => { onClose(); window.location.assign(page.href); } }));
    actions
      .filter((item) => matchesText(item.label) || matchesText(item.description))
      .forEach((item) =>
        out.push({
          id: `action-${item.label}`,
          label: item.label,
          hint: item.description,
          group: "Actions",
          run: () => {
            onClose();
            if (item.href) {
              if (item.external) window.open(item.href, "_blank", "noopener");
              else window.location.assign(item.href);
            } else item.onClick?.();
          },
        }),
      );
    return out;
  }, [query, symbols, pages, actions, exchangesQuery, onClose]);

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setIndex((value) => Math.min(commands.length - 1, value + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setIndex((value) => Math.max(0, value - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      commands[index]?.run();
    } else if (event.key === "Escape") {
      onClose();
    }
  };

  let lastGroup = "";
  return (
    <>
      <div className="t-sheet-scrim" onClick={onClose} />
      <div className="pl-box" role="dialog" aria-modal="true" aria-label="Jump to" onKeyDown={onKeyDown}>
        <label className="pl-input">
          {Icon.search}
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Jump to a coin, page or setting"
            aria-label="Jump to"
            role="combobox"
            aria-expanded="true"
            aria-controls="pl-list"
            enterKeyHint="go"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
          />
          <span className="t-kbd">esc</span>
        </label>
        <ul id="pl-list" className="pl-list" role="listbox" ref={listRef}>
          {commands.map((command, position) => {
            const heading = command.group !== lastGroup ? command.group : null;
            lastGroup = command.group;
            return (
              <li key={command.id} role="presentation">
                {heading ? <p className="pl-group">{heading}</p> : null}
                <button type="button" role="option" aria-selected={position === index} data-active={position === index} className="pl-item" onMouseMove={() => setIndex(position)} onClick={command.run}>
                  <strong>{command.label}</strong>
                  <span>{command.hint}</span>
                </button>
              </li>
            );
          })}
          {!commands.length ? <li className="pl-empty">Nothing matches "{query}".</li> : null}
        </ul>
      </div>
    </>
  );
}
