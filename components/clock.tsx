"use client";

import { useEffect, useState } from "react";

// Live clock for the OS menu bar. Renders a placeholder on the server and swaps
// in the real time after mount (setInterval) so there is no hydration mismatch.
export function DesktopClock() {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 10_000);
    return () => clearInterval(t);
  }, []);

  const time = now
    ? now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : "--:--";
  const date = now
    ? now.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })
    : "";

  return (
    <div className="flex items-center gap-3 text-xs">
      {date && (
        <span className="hidden text-fg-muted md:inline">{date}</span>
      )}
      <span className="font-semibold text-fg tabular-nums">{time}</span>
    </div>
  );
}