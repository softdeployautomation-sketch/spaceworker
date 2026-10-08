"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Lock } from "lucide-react";

import { cn } from "@/lib/cn";

// TASK_184 A3 — THE shared lock card for web modules, the UI half of
// lib/module-gate.ts. Free (tier 1) and tier-3 XDevice accounts may OPEN every
// tab and look around (reads stay open by design) — what they get here is the
// honest "this is a premium tool" card instead of a dead form, plus the one
// button that takes them somewhere they can actually do something about it.
//
// Entitlement source is the SAME endpoint the device console uses
// (GET /api/entitlements → { keys, premium, grants }, components/device-console
// .tsx:599-674): `no-store`, and DEFAULT-OPEN — until it answers (or if it never
// answers) no lock is painted. The server gate is the authority either way; this
// card is UX, never protection.
//
// CTA note (A3 → B2): until the support-ticket template lands, "Upgrade to
// Premium" goes to /dashboard/settings?template=premium. B2 flips every CTA to
// open the support widget preloaded with the premium-request template.

export type ModuleLockKey = "extractor" | "cyberlab" | "hosting" | "browser";

interface EntitlementAnswer {
  /** `null` until the endpoint answers, and stays `null` on failure (default-open). */
  keys: string[] | null;
  loaded: boolean;
}

/** The one entitlement read every lock decision in this file is derived from. */
export function useEntitlementKeys(enabled = true): EntitlementAnswer {
  const [state, setState] = useState<EntitlementAnswer>({ keys: null, loaded: false });
  useEffect(() => {
    // Skipped when the caller already has a server-computed answer (the
    // `entitled` prop path) — one request we don't need to make.
    if (!enabled) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/entitlements", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as { keys?: unknown };
        if (cancelled) return;
        setState({
          keys: Array.isArray(data.keys)
            ? data.keys.filter((k): k is string => typeof k === "string")
            : [],
          loaded: true,
        });
      } catch {
        // Fail-soft: unknown ⇒ unlocked (default-open), never a lock card on a
        // premium account whose entitlements we simply failed to read.
        if (!cancelled) setState({ keys: null, loaded: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return state;
}

/**
 * `locked` is true only once we KNOW the answer and the key is absent.
 * Premium (tier 5) lights every key server-side, so `includes` alone is enough;
 * tier 3 surfaces `devices` only — which is exactly the Phase C rule.
 */
export function useModuleLock(
  key: ModuleLockKey,
  enabled = true,
): { locked: boolean; loaded: boolean } {
  const { keys, loaded } = useEntitlementKeys(enabled);
  return { locked: loaded && Array.isArray(keys) && !keys.includes(key), loaded };
}

interface LockCopy {
  title: string;
  bullets: string[];
}

const MODULE_LOCK_COPY: Record<ModuleLockKey, LockCopy> = {
  extractor: {
    title: "Extractor is a premium tool",
    bullets: [
      "Search the web, verify and export structured lead lists — extraction runs on our servers.",
      "Every job, lead list and export you already have stays readable and exportable.",
      "This tab stays open so you can see exactly what the tool does.",
    ],
  },
  cyberlab: {
    title: "Cyber Lab is a premium tool",
    bullets: [
      "Isolated ranges, attested targets and evidence-trailed runs are premium.",
      "The lab's live capacity envelope stays visible — nothing about it is hidden.",
      "This tab stays open so you can see exactly what the lab does.",
    ],
  },
  hosting: {
    title: "Hosting & Pages is a premium tool",
    bullets: [
      "Upload a file or page, publish a site, share a short link — and get a real URL back.",
      "Anything already published keeps serving exactly as it does now.",
      "This tab stays open so you can see exactly how hosting works.",
    ],
  },
  browser: {
    title: "The Private Browser is a premium tool",
    bullets: [
      "Your own Chrome session, streamed into the dashboard and routed through an exit node.",
      "Saved profiles and past sessions stay listed — starting one is what's premium.",
      "This tab stays open so you can see exactly what the browser does.",
    ],
  },
};

export const MODULE_UPGRADE_HREF = "/dashboard/settings?template=premium";

export interface ModuleToolLockCardProps {
  moduleKey: ModuleLockKey;
  /** Server-computed answer skips the client fetch (see app/dashboard/browser/page.tsx). */
  entitled?: boolean;
  title?: string;
  bullets?: string[];
  className?: string;
}

/**
 * Renders NOTHING unless the module is (provably) locked — an entitled account
 * never sees a lock flash, and neither does an account we failed to read.
 */
export function ModuleToolLockCard({
  moduleKey,
  entitled,
  title,
  bullets,
  className,
}: ModuleToolLockCardProps) {
  const { locked } = useModuleLock(moduleKey, entitled === undefined);
  const isLocked = entitled !== undefined ? !entitled : locked;
  if (!isLocked) return null;

  const copy = MODULE_LOCK_COPY[moduleKey];
  const lines = bullets ?? copy.bullets;
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 border border-border bg-bg-elevated px-6 py-12 text-center",
        className,
      )}
    >
      <Lock className="h-5 w-5 text-fg-muted" aria-hidden />
      <p className="text-sm font-medium text-fg">{title ?? copy.title}</p>
      <ul className="max-w-md space-y-1 text-sm text-fg-muted">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <Link
        href={MODULE_UPGRADE_HREF}
        className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700"
      >
        Upgrade to Premium
      </Link>
    </div>
  );
}
