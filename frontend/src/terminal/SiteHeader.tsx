import type { ReactNode } from "react";
import { AppChrome, type ActiveKey } from "./chrome";

/** Compare, Trade, Results and Backtest pages: the same top bar, dock and More sheet as the dashboard. */
export function PageFrame({ children, active }: { children: ReactNode; active: ActiveKey }) {
  return (
    <AppChrome active={active} legacy>
      {children}
    </AppChrome>
  );
}
