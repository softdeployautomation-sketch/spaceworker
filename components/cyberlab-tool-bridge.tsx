"use client";

import { useEffect, useState } from "react";

import {
  BRIDGE_MAX_CONTENT_CHARS,
  BRIDGE_STORAGE_KEY,
  BRIDGE_TOOLS,
  bridgeHref,
  bridgeTool,
  parseBridgeContext,
  serializeBridgeContext,
  type BridgeContext,
  type BridgeToolId,
} from "@/lib/lab/tool-bridge";

// TASK_156B S7-B (PLAN_CYBERLAB_NEXT_S7 §1 Slice B) — the tool bridge UI:
// deep-links OUT to the real tools (mailer / extractor / RMM) and the return
// hop where the operator pastes what the tool produced so it lands as a
// SIGNED artefact bound to the run (POST /api/cyberlab/runs/[id]/artefacts).
//
// Honesty rules kept structurally:
//   - We never clone the tool or fake its output: the artefact is EXACTLY the
//     bytes pasted here, hashed + signed server-side; nothing is invented.
//   - The attach response's `signatureValid` is shown verbatim (it was
//     recomputed server-side from the stored row — see the route).
//   - No sync setState in an effect: the sessionStorage read happens behind a
//     microtask boundary, so the house lint rule is satisfied genuinely.

interface Props {
  /** The run the bridge should bind to (null = no run open: links still work, no attach). */
  rangeId: string | null;
  /** Called after a successful attach so the console can refresh its lists. */
  onAttached?: () => void;
}

/**
 * Leaving to a tool: stamp the bridge context in sessionStorage, then navigate.
 * Module scope on purpose — it touches no component state, and keeping it out
 * of the render tree keeps the react-hooks/purity rule genuinely satisfied
 * (no Date.now anywhere in render scope) instead of suppressed.
 */
function leaveToTool(toolId: BridgeToolId, href: string, rangeId: string | null, e: React.MouseEvent) {
  if (!rangeId) return; // context-less bridging: the default navigation proceeds.
  const raw = serializeBridgeContext({ toolId, rangeId, at: Date.now() });
  if (raw) {
    e.preventDefault();
    try {
      window.sessionStorage.setItem(BRIDGE_STORAGE_KEY, raw);
    } catch {
      // Storage unavailable — navigate anyway; the return banner just won't show.
    }
    window.location.assign(href);
  }
}

export function CyberLabToolBridge({ rangeId, onAttached }: Props) {
  const [pending, setPending] = useState<BridgeContext | null>(null);
  const [output, setOutput] = useState("");
  const [attaching, setAttaching] = useState(false);
  const [attachError, setAttachError] = useState("");
  const [attached, setAttached] = useState<{ episodeId: string; signatureValid: boolean } | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Microtask boundary: the storage read is off the effect's synchronous
    // body (house rule: no setState synchronously inside an effect).
    Promise.resolve().then(() => {
      if (cancelled) return;
      let raw: string | null = null;
      try {
        raw = window.sessionStorage.getItem(BRIDGE_STORAGE_KEY);
      } catch {
        raw = null; // storage disabled → no banner, never an error.
      }
      setPending(parseBridgeContext(raw, Date.now()));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function clearPending() {
    try {
      window.sessionStorage.removeItem(BRIDGE_STORAGE_KEY);
    } catch {
      /* nothing to clear */
    }
    setPending(null);
    setAttachError("");
  }

  async function attach() {
    if (!pending) return;
    if (output.length > BRIDGE_MAX_CONTENT_CHARS) {
      setAttachError(`Output too large (max ${BRIDGE_MAX_CONTENT_CHARS} characters — trim it to the essentials).`);
      return;
    }
    setAttaching(true);
    setAttachError("");
    try {
      const res = await fetch(`/api/cyberlab/runs/${pending.rangeId}/artefacts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolId: pending.toolId, content: output }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        episodeId?: string;
        signatureValid?: boolean;
      };
      if (!res.ok || !data.episodeId) {
        setAttachError(data.error ?? `attach refused (${res.status})`);
        return;
      }
      setAttached({ episodeId: data.episodeId, signatureValid: data.signatureValid === true });
      setOutput("");
      try {
        window.sessionStorage.removeItem(BRIDGE_STORAGE_KEY);
      } catch {
        /* nothing to clear */
      }
      setPending(null);
      onAttached?.();
    } catch {
      setAttachError("Network error — nothing was attached.");
    } finally {
      setAttaching(false);
    }
  }

  return (
    <section data-cy="cyberlab-tool-bridge" className="lab-panel rounded-lg p-5">
      <h2 className="text-lg font-semibold" style={{ color: "var(--lab-text)" }}>
        3 · Run it with the real tools
      </h2>
      <p className="mt-1 text-sm" style={{ color: "var(--lab-muted)" }}>
        The lab doesn&rsquo;t clone these tools — it sends you out to them. Do the real work
        (send the phishing sim, capture credentials, reach a device you own), come back, and paste
        what the tool produced: it&rsquo;s recorded here as a <strong>signed artefact bound to this
        run</strong> — exactly the bytes you paste, nothing invented.
        {rangeId
          ? " A run is open, so the bridge is bound to it."
          : " Open or start a run first to bind the bridge to it."}
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        {BRIDGE_TOOLS.map((t) => (
          <a
            key={t.id}
            href={bridgeHref(t.id, rangeId)}
            onClick={(e) => leaveToTool(t.id, bridgeHref(t.id, rangeId), rangeId, e)}
            className="rounded-md border p-3 text-sm transition-opacity hover:opacity-80"
            style={{ borderColor: "var(--lab-line)", color: "var(--lab-text)" }}
          >
            <span className="font-medium">{t.label}</span>
            <span className="mt-1 block text-xs" style={{ color: "var(--lab-muted)" }}>
              {t.hint}
            </span>
          </a>
        ))}
      </div>
      {attached && (
        <p className="mt-3 text-sm" style={{ color: "var(--lab-green)" }}>
          Attached — signed record{" "}
          <a
            className="underline"
            href={`/cyberlab/replay/${attached.episodeId}`}
            style={{ color: "var(--lab-accent)" }}
          >
            {attached.episodeId}
          </a>{" "}
          {attached.signatureValid ? "· signature VERIFIED" : "· signature INVALID (check the run)"}.
        </p>
      )}

      {pending && (
        <div className="mt-3 rounded-md border p-3" style={{ borderColor: "var(--lab-line)" }}>
          <p className="text-sm" style={{ color: "var(--lab-text)" }}>
            Returned from <strong>{bridgeTool(pending.toolId)?.label ?? pending.toolId}</strong> for
            run <span className="font-mono">{pending.rangeId}</span> — paste the tool&rsquo;s output
            to attach it as a signed artefact.
          </p>
          <textarea
            value={output}
            onChange={(e) => setOutput(e.target.value)}
            rows={5}
            spellCheck={false}
            placeholder="Paste the tool output here (campaign report, capture log, device notes)…"
            className="mt-2 w-full rounded-md border bg-transparent px-3 py-1.5 font-mono text-xs"
            style={{ borderColor: "var(--lab-line)", color: "var(--lab-text)" }}
          />
          {attachError && (
            <p className="mt-1 text-xs" style={{ color: "var(--lab-red)" }}>
              {attachError}
            </p>
          )}
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={attach}
              disabled={attaching || output.trim().length === 0}
              className="rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50"
              style={{ background: "var(--lab-accent)", color: "#04211d" }}
            >
              {attaching ? "Attaching…" : "Attach as signed artefact"}
            </button>
            <button
              type="button"
              onClick={clearPending}
              className="rounded-md border px-3 py-1.5 text-sm"
              style={{ borderColor: "var(--lab-line)", color: "var(--lab-muted)" }}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
