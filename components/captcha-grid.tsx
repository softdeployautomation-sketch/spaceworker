"use client";

import { useCallback, useState } from "react";

import { seededTargets } from "@/lib/captcha-seed";

const GRID_SIZE = 9;

interface CaptchaGridProps {
  token: string;
  seed: string;
  targetCount: number;
  onVerified: (ok: boolean) => void;
}

/**
 * Client side of the clown CAPTCHA.
 *
 * The server supplies `token`, `seed` and `targetCount` only — never the
 * target positions. Targets are derived here from the same seeded shuffle the
 * server used to compute the answer hash, then rendered as clowns (red nose)
 * among ordinary faces. The visitor clicks every clown, then submits.
 */
export default function CaptchaGrid({
  token,
  seed,
  targetCount,
  onVerified,
}: CaptchaGridProps) {
  const targets = seededTargets(seed, GRID_SIZE, targetCount);
  const isTarget = new Set(targets);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [status, setStatus] = useState<"idle" | "ok" | "bad" | "checking">("idle");

  const toggle = useCallback((index: number) => {
    if (status !== "idle") return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, [status]);

  const submit = async () => {
    setStatus("checking");
    try {
      const res = await fetch("/api/captcha/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, selected: Array.from(selected).sort((a, b) => a - b) }),
      });
      const ok = res.status === 200;
      setStatus(ok ? "ok" : "bad");
      onVerified(ok);
    } catch {
      setStatus("bad");
      onVerified(false);
    }
  };

  const allTargetsSelected = targets.every((i) => selected.has(i));
  const ready = selected.size === targetCount && allTargetsSelected;
  return (
    <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-base font-semibold text-fg">Prove you're human</h3>
        <span className="text-sm font-mono text-fg-muted">{token.slice(0, 8)}…</span>
      </div>
      <p className="mb-4 text-sm text-fg-muted">
        Click all <b>{targetCount}</b> clowns (red nose), then submit.
      </p>
      <div className="grid grid-cols-3 gap-2 mb-4">
        {[...Array(GRID_SIZE)].map((_, index) => {
          const kind = isTarget.has(index) ? "clown" : "person";
          const pressed = selected.has(index);
          return (
            <button
              key={index}
              type="button"
              onClick={() => toggle(index)}
              aria-pressed={pressed}
              aria-label={`Cell ${index + 1}, ${kind}`}
              className={`aspect-square rounded-lg border p-1 transition-all ${
                pressed
                  ? "ring-2 ring-brand-600 bg-zinc-100 dark:bg-zinc-800"
                  : "bg-white dark:bg-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-800 border-zinc-200 dark:border-zinc-700"
              }`}
            >
              <div className="h-full w-full flex flex-col items-center justify-center gap-1 relative">
                <div
                  className={`w-10 h-10 rounded-full relative ${
                    kind === "clown"
                      ? "bg-[#ffedd5] border-2 border-[#ffd166]"
                      : "bg-[#e2e8f0] border border-zinc-300"
                  }`}
                >
                  <div className="absolute -top-2 left-2 w-2 h-2 rounded-full bg-[#1f2937]"></div>
                  <div className="absolute -top-2 right-2 w-2 h-2 rounded-full bg-[#1f2937]"></div>
                  <div
                    className={`absolute -bottom-1 w-3 h-2 rounded-full ${
                      kind === "clown" ? "bg-[#ef4444]" : "bg-[#9ca3af]"
                    }`}
                  ></div>
                  <div
                    className={`absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full ${
                      kind === "clown"
                        ? "bg-[#ef4444] ring-1 ring-[#b91c1c]"
                        : "bg-[#cbd5e1]"
                    }`}
                  ></div>
                  {kind === "clown" && (
                    <>
                      <div className="absolute -left-1 top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-[#fda4af] opacity-80"></div>
                      <div className="absolute -right-1 top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-[#fda4af] opacity-80"></div>
                    </>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>
      <div className="flex items-center justify-between">
        <p className="text-xs text-fg-muted">
          {selected.size} of {targetCount} selected
        </p>
        <button
          type="button"
          disabled={!ready || status !== "idle"}
          onClick={submit}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            !ready || status !== "idle"
              ? "text-zinc-400 border border-zinc-200 dark:border-zinc-700 dark:text-zinc-500"
              : "bg-brand-600 text-white hover:bg-brand-700"
          }`}
        >
          {status === "checking" ? "Verifying…" : "Submit"}
        </button>
      </div>
      {status === "ok" && (
        <p className="mt-3 text-sm text-emerald-700 dark:text-emerald-400 font-medium">
          CAPTCHA passed — you may now sign in or sign up.
        </p>
      )}
      {status === "bad" && (
        <p className="mt-3 text-sm text-red-700 dark:text-red-400 font-medium">
          That wasn't right. Try again.
        </p>
      )}
    </div>
  );
}
