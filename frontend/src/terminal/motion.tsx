import { useEffect, useRef, useState } from "react";
import { pct } from "./primitives";

const reduced = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Eases a number toward its new value instead of jumping, like a quote board settling. */
export function useTween(value: number, ms = 450) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  const frame = useRef(0);
  useEffect(() => {
    if (from.current === value) return;
    if (reduced() || !Number.isFinite(value) || !Number.isFinite(from.current)) {
      from.current = value;
      setShown(value);
      return;
    }
    const start = performance.now();
    const origin = from.current;
    cancelAnimationFrame(frame.current);
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / ms);
      const eased = 1 - Math.pow(1 - progress, 3);
      const next = origin + (value - origin) * eased;
      from.current = next;
      setShown(next);
      if (progress < 1) frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, [value, ms]);
  return shown;
}

/** A percentage that glides between values. */
export function AnimatedPct({ value, digits = 2, signed = false }: { value: number; digits?: number; signed?: boolean }) {
  return <>{pct(useTween(value), digits, signed)}</>;
}
