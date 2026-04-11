import { useEffect, useState } from "react";

export function useNow(intervalMs = 1000) {
  const [nowTimestamp, setNowTimestamp] = useState(() => Date.now());

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setNowTimestamp(Date.now());
    }, intervalMs);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [intervalMs]);

  return nowTimestamp;
}
