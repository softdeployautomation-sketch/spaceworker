"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

// TASK_190 S5 — the owner-presence beacon.
//
// Pings POST /api/presence: immediately on mount, every 60s, instantly when
// the tab becomes visible again, and via navigator.sendBeacon on pagehide
// (a plain ping — the server derives "the tab died" from silence, not from a
// special shutdown stamp). `sawInputRef` flips true on real user input
// (pointer/keys/wheel/scroll) and is folded into each ping as `active`, then
// reset — so lastActiveAt tracks INPUT recency while lastSeenAt tracks the
// ping cadence, which is what lets an open-but-untouched tab read as idle.
//
// Mounted ONLY in the hosted branch of app/dashboard/layout.tsx — never in
// the localExe branches (no DB there) and never on the admin panel (verify
// §4.7: no /api/presence pings from admin pages).
export function PresenceBeacon() {
  const pathname = usePathname();
  const pathRef = useRef(pathname);
  const sawInputRef = useRef(false);

  // Track the route WITHOUT re-arming the interval on every navigation.
  // (Updated inside an effect — react-hooks/refs forbids ref writes during
  // render, and the effect runs before the interval's next tick.)
  useEffect(() => {
    pathRef.current = pathname;
  }, [pathname]);

  useEffect(() => {
    const markInput = () => {
      sawInputRef.current = true;
    };
    const inputEvents = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart", "scroll"] as const;
    for (const ev of inputEvents) window.addEventListener(ev, markInput, { passive: true });

    const ping = () => {
      const active = sawInputRef.current;
      sawInputRef.current = false;
      void fetch("/api/presence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page: pathRef.current, active }),
        keepalive: true,
      }).catch(() => {
        // Offline / server blip — the next tick retries; never surface.
      });
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") ping();
    };
    const onPageHide = () => {
      // Plain ping, fire-and-forget; sendBeacon survives the navigation.
      try {
        void navigator.sendBeacon(
          "/api/presence",
          new Blob([JSON.stringify({ page: pathRef.current, active: sawInputRef.current })], {
            type: "application/json",
          }),
        );
      } catch {
        // Beacon unsupported/blocked — silence covers it anyway.
      }
    };

    ping(); // mount — immediate, so verify §4.1's "within ~60s" is really ~0s
    const interval = setInterval(ping, 60_000);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      for (const ev of inputEvents) window.removeEventListener(ev, markInput);
    };
  }, []);

  return null;
}
