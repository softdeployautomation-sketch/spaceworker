"use client";

import { useEffect, useState } from "react";

import { Moon, Sun } from "lucide-react";

const THEME_KEY = "spaceworker-theme";

export function ThemeToggle() {
  const [dark, setDark] = useState<boolean>(true); // dark-by-default
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(THEME_KEY);
    } catch {
      stored = null;
    }
    const isDark = stored === "dark" || !stored; // dark-by-default
    // Apply the class immediately (no state); update state in an async frame so
    // React's set-state-in-effect lint rule is satisfied.
    document.documentElement.classList.toggle("dark", isDark);
    requestAnimationFrame(() => {
      if (cancelled) return;
      setDark(isDark);
      setMounted(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!mounted) {
    return (
      <button
        type="button"
        aria-label="Toggle theme"
        className="inline-flex items-center justify-center rounded-lg p-2 text-fg-muted"
      >
        <Sun className="h-5 w-5 opacity-0" aria-hidden="true" />
      </button>
    );
  }

  function toggle() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      window.localStorage.setItem(THEME_KEY, next ? "dark" : "light");
    } catch {
      // ignore storage errors (e.g. private mode)
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      className="inline-flex items-center justify-center rounded-lg p-2 text-fg-muted transition-colors hover:bg-black/5 dark:hover:bg-white/5"
    >
      {dark ? (
        <Sun className="h-5 w-5" aria-hidden="true" />
      ) : (
        <Moon className="h-5 w-5" aria-hidden="true" />
      )}
    </button>
  );
}