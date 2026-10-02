"use client";

import { useState } from "react";

import {
  CYBERLAB_AUP_SECTIONS,
  CYBERLAB_AUP_TITLE,
  CYBERLAB_AUP_UPDATED,
  CYBERLAB_AUP_VERSION,
} from "@/lib/lab/aup";

// TASK_156 C0 (PLAN_TASK_156 §7 C0) — the Cyber Lab AUP / "Authorized targets
// only" onboarding screen.
//
// The owner's rule (§7 C0): "Nothing runs before this exists." This is the screen
// that exists before anything runs. It renders the VERSIONED AUP text from the
// shared, pure lib/lab/aup.ts — the SAME module the server gate and the consent
// hash read — so the wording a user reads and the wording that is hashed into
// their LabConsent row can never drift.
//
// Accepting POSTs /api/cyberlab/consent, which records an append-only LabConsent
// row for the CURRENT termsVersion (the API refuses a non-entitled user, so a
// user who cannot use the lab is never asked to sign). On success the parent
// re-reads the gate and the panel flips to its "accepted" state.
//
// Honest limit (§12.9 + §8): accepting this DRAFT text is not legal advice and
// does not by itself authorise a customer-facing offensive run — that waits on the
// lawyer's sign-off (§7 C6) and the §5.2 sentinel.

export function CyberLabAup({ onAccepted }: { onAccepted?: () => void }) {
  const [agreed, setAgreed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function accept() {
    if (!agreed) return;
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/cyberlab/consent", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Couldn’t record your acceptance.");
        return;
      }
      onAccepted?.();
    } catch {
      setError("Network error — couldn’t record your acceptance.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{CYBERLAB_AUP_TITLE}</h2>
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          v{CYBERLAB_AUP_VERSION} · {CYBERLAB_AUP_UPDATED}
        </span>
      </div>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        Read this before you use the Cyber Lab. Accepting records your agreement, per version — if the policy is ever
        re-worded you will be asked to accept the new version.
      </p>

      <div className="mt-4 max-h-96 space-y-4 overflow-y-auto rounded-md border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-950">
        {CYBERLAB_AUP_SECTIONS.map((section) => (
          <div key={section.heading}>
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{section.heading}</h3>
            {section.body.map((para, i) => (
              <p key={i} className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                {para}
              </p>
            ))}
          </div>
        ))}
      </div>

      {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

      <label className="mt-4 flex items-start gap-2 text-sm text-zinc-700 dark:text-zinc-300">
        <input
          type="checkbox"
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          I have read the Cyber Lab Acceptable-Use Policy and I confirm every target I attest to is mine or one I am
          authorised to test.
        </span>
      </label>

      <button
        onClick={accept}
        disabled={!agreed || saving}
        className="mt-4 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
      >
        {saving ? "Recording…" : "Accept and continue"}
      </button>
    </section>
  );
}
