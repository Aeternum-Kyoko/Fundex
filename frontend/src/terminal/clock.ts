import { useSyncExternalStore } from "react";

// One shared 1s ticker. Components that read it (countdowns) re-render alone, instead of the whole page.
let now = Date.now();
const listeners = new Set<() => void>();
let timer: number | null = null;

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (timer === null) {
    timer = window.setInterval(() => {
      now = Date.now();
      listeners.forEach((notify) => notify());
    }, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size && timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  };
}

export function useClock() {
  return useSyncExternalStore(subscribe, () => now, () => now);
}
