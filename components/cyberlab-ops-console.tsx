"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  LAB_STAGES,
  buildRadarModel,
  type LabStageId,
} from "@/lib/lab/console-map";
import { ThemeToggle } from "@/components/theme-toggle";

// TASK_156B UI-1 (PLAN_CYBERLAB_STANDALONE_UI.md §3 S2/S3) — the Operation
// Console, the standalone /cyberlab section's main event. Three panes — the
// kill-chain stage rail · the radial-rings radar · the live tool-output feed —
// all driven by REAL engine events over SSE (/api/cyberlab/runs/[id]/stream).
//
// The owner's hard line (PLAN §3), enforced structurally:
//   - The radar draws from lib/lab/console-map.buildRadarModel, which can only
//     place ATTESTED targets and only draw arcs/pulses that real timeline
//     events named. No code path here invents a host or a number: if it moves,
//     a real event moved it. Ring distance is LAYOUT, captioned as such.
//   - `live:false` streams are labelled REPLAY — a real recorded run's real
//     timeline, replayed with its own timestamps (the S7 ad-factory seed).
//   - Every panel carries a watermark. The header one is MODE-AWARE: it reads
//     the server-reported run `mode` and shows SIMULATION · YOUR EQUIPMENT for a
//     dry-run (the default) or AUTHORIZED LIVE TEST · REAL PACKETS when a live
//     server-egress run is playing — so a real scan is never mislabelled
//     "simulation". prefers-reduced-motion kills all motion while every
//     state change stays visible (the .lab-ops block in app/globals.css).
//   - Refusals are shown verbatim from the server (the C2a contract); nothing
//     here re-implements or softens a gate.

interface ScenarioView {
  id: string;
  slug: string;
  name: string;
  klass: string;
  techniqueIds: string[];
  blastRadius: string;
  cleanup: string;
  author: string;
  mode: string;
}

interface TargetView {
  id: string;
  kind: string;
  value: string;
  attestedAt: string;
  sourceDeviceId?: string | null;
}

interface DeviceView {
  id: string;
  name: string;
  osName: string | null;
  status: string;
  lastSeenAt: string | null;
  lastIp: string | null;
}

interface RunView {
  id: string;
  scenarioId: string;
  state: string;
  ttlExpiresAt: string | null;
  teardownVerifiedAt: string | null;
  error: string | null;
  createdAt: string;
}

interface EpisodeListItem {
  id: string;
  rangeId: string;
  startedAt: string;
  outcome: string;
  techniques: string[];
  signedHash: string | null;
  createdAt: string;
}

interface EpisodeDetail {
  id: string;
  rangeId: string;
  startedAt: string;
  endedAt: string | null;
  outcome: string;
  techniques: string[];
  telemetrySignatures: string[];
  timeline: unknown;
  evidenceManifest: { entries?: Array<{ path: string; sha256: string; bytes: number }> } | null;
  signedHash: string | null;
}

interface PlayedEvent {
  at: string;
  event: string;
  detail: Record<string, unknown> | null;
  stage: LabStageId;
}

interface EvidenceLine {
  path: string;
  sha256: string;
  bytes: number;
}

interface DoneFrame {
  type: "done";
  state: string;
  outcome: string | null;
  techniques: string[];
  telemetrySignatures: string[];
  signedHash: string | null;
  signatureValid: boolean | null;
  teardownVerifiedAt: string | null;
}

interface OpenFrame {
  type: "open";
  rangeId: string;
  state: string;
  mode: string;
  scenarioSlug: string | null;
  live: boolean;
  startedAt: string | null;
  targets: Array<{ kind: string; value: string }>;
}

const TARGET_KINDS = ["host", "network", "url", "domain", "email"] as const;

/** Scenario slug for scan-first recon (see lib/lab/scenarios.ts). No attested device required. */
const RECON_SCENARIO_SLUG = "recon-attack-surface";

/** Pacing bounds for revealing real events (presentation only; `at` shown is real). */
const REPLAY_MIN_GAP_MS = 220;
const REPLAY_MAX_GAP_MS = 900;

function issueText(reason: string): string {
  switch (reason) {
    case "unattested":
      return "not in your attested inventory";
    case "stale_attestation":
      return "attestation older than the freshness window";
    case "range_mismatch":
      return "attested to a different lab range";
    default:
      return reason;
  }
}

/** Ring radii in the 400×400 viewBox — LAYOUT, not distance (see console-map). */
const RING_RADIUS: Record<number, number> = { 1: 62, 2: 112, 3: 162 };

function nodeXY(ring: number, angleDeg: number): { x: number; y: number } {
  const r = RING_RADIUS[ring] ?? RING_RADIUS[1];
  const rad = (angleDeg * Math.PI) / 180;
  return { x: 200 + r * Math.cos(rad), y: 200 + r * Math.sin(rad) };
}

// TASK_156B V2 (Slice 1) — the in-console "How Cyber Lab works" guide. It
// explains the intended learn-to-defend journey (scan → find → simulate →
// protect) and is honest about what is live TODAY (a signed dry-run evidence
// chain) versus the scan-first recon we are building toward. Collapsible so it
// never crowds the console; state (open/closed) is local, no persistence.
function CyberLabGuide() {
  const [open, setOpen] = useState(false);
  return (
    <section className="lab-panel rounded-lg p-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 text-left"
      >
        <span className="text-base font-semibold" style={{ color: "var(--lab-text)" }}>
          How Cyber Lab works
        </span>
        <span className="lab-chip rounded px-2 py-0.5 text-xs">{open ? "Hide" : "Show"}</span>
      </button>

      {open && (
        <div className="mt-4 space-y-4 text-sm" style={{ color: "var(--lab-text)" }}>
          <p style={{ color: "var(--lab-muted)" }}>
            Cyber Lab is a safe place to see how an attacker gets in — and how to stop them — using
            your own equipment. The idea is simple: <strong>look before you attack</strong>.
          </p>

          <ol className="space-y-2">
            <li>
              <strong>1 · Scan &amp; recon.</strong> First you scan a host, an IP range, or your
              network — no device takeover, nothing invasive — to find what&rsquo;s exposed, just like
              a real attacker would start.
            </li>
            <li>
              <strong>2 · Find vulnerabilities.</strong> See the weaknesses a scan surfaces on your
              own machines.
            </li>
            <li>
              <strong>3 · Simulate the break-in.</strong> Optionally run the on-device agent as a
              controlled malware simulation to show how easy it is to get in <em>if</em> a machine is
              exposed — always on equipment you own, always attested, always torn down.
            </li>
            <li>
              <strong>4 · Learn to protect.</strong> Every run produces a signed, tamper-evident
              record of what happened, so you know exactly what to fix.
            </li>
          </ol>

          <div
            className="rounded-md border p-3 text-xs"
            style={{ borderColor: "var(--lab-line-bright)", background: "var(--lab-bg-elev)", color: "var(--lab-muted)" }}
          >
            <p className="font-semibold" style={{ color: "var(--lab-amber)" }}>How to use it</p>
            <p className="mt-1">
              <strong>1 · Scan for weaknesses</strong> — pick a kind (host / network / url / domain /
              email), type a scope you&rsquo;re authorised to assess, and run. No attested device
              needed. If the <strong>live server-egress</strong> scenario is enabled, this sends{" "}
              <strong>real TCP probes</strong> out of our servers and records what&rsquo;s actually
              open on your machine — point it only at equipment you own.
            </p>
            <p className="mt-1">
              <strong>2 · Simulate the break-in</strong> — run a scenario (attest a target you own)
              to rehearse the intrusion and get a signed evidence record of exactly what happened.
            </p>
            <p className="mt-1">
              Watch it on the radar: rings are <strong>layout, not latency</strong>, and nothing
              moves unless a real event moved it. The header watermark tells you what kind of run
              you&rsquo;re watching — <strong>SIMULATION</strong> for a dry-run,{" "}
              <strong>AUTHORIZED LIVE TEST · REAL PACKETS</strong> when a live run is playing.
            </p>
          </div>

          <p className="text-xs" style={{ color: "var(--lab-muted)" }}>
            Rings on the radar are <strong>layout, not latency</strong>. Nothing on screen moves
            unless a real event moved it. Use the theme toggle in the header to switch between the
            light blueprint and dark SOC views.
          </p>
        </div>
      )}
    </section>
  );
}

export function CyberLabOpsConsole() {
  const [scenarios, setScenarios] = useState<ScenarioView[]>([]);
  const [targets, setTargets] = useState<TargetView[]>([]);
  const [runs, setRuns] = useState<RunView[]>([]);
  const [episodes, setEpisodes] = useState<EpisodeListItem[]>([]);
  const [devices, setDevices] = useState<DeviceView[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [starting, setStarting] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [attestKind, setAttestKind] = useState<(typeof TARGET_KINDS)[number]>("host");
  const [attestValue, setAttestValue] = useState("");
  const [attesting, setAttesting] = useState(false);
  const [attestDeviceId, setAttestDeviceId] = useState("");
  const [reconKind, setReconKind] = useState<(typeof TARGET_KINDS)[number]>("network");
  const [reconValue, setReconValue] = useState("");
  const [scanning, setScanning] = useState(false);
  const [openEpisode, setOpenEpisode] = useState<{ detail: EpisodeDetail; signatureValid: boolean } | null>(null);
  const [loadingEpisode, setLoadingEpisode] = useState("");

  // The stream/playback state — everything the panes render during a run.
  const [openFrame, setOpenFrame] = useState<OpenFrame | null>(null);
  const [played, setPlayed] = useState<PlayedEvent[]>([]);
  const [evidenceLines, setEvidenceLines] = useState<EvidenceLine[]>([]);
  const [done, setDone] = useState<DoneFrame | null>(null);
  const [streamError, setStreamError] = useState("");

  const esRef = useRef<EventSource | null>(null);
  const timersRef = useRef<number[]>([]);
  const feedRef = useRef<HTMLDivElement | null>(null);

  const clearTimers = useCallback(() => {
    for (const t of timersRef.current) window.clearTimeout(t);
    timersRef.current = [];
  }, []);

  const closeStream = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
    clearTimers();
  }, [clearTimers]);

  // Close the stream + pending timers on unmount only. (Opening is imperative —
  // driven by clicks/loaders — so there is no effect here for
  // react-hooks/set-state-in-effect to flag.)
  useEffect(() => () => closeStream(), [closeStream]);

  // Keep the feed pinned to the newest real line.
  useEffect(() => {
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [played.length, evidenceLines.length, done]);

  const refresh = useCallback(async () => {
    const [sc, tg, rn, ep, dv] = await Promise.all([
      fetch("/api/cyberlab/scenarios").then((r) => (r.ok ? r.json() : { scenarios: [] })),
      fetch("/api/cyberlab/targets").then((r) => (r.ok ? r.json() : { targets: [] })),
      fetch("/api/cyberlab/runs").then((r) => (r.ok ? r.json() : { runs: [] })),
      fetch("/api/cyberlab/episodes").then((r) => (r.ok ? r.json() : { episodes: [] })),
      fetch("/api/cyberlab/devices").then((r) => (r.ok ? r.json() : { devices: [] })),
    ]);
    setScenarios(sc.scenarios ?? []);
    setTargets(tg.targets ?? []);
    setRuns(rn.runs ?? []);
    setEpisodes(ep.episodes ?? []);
    setDevices(dv.devices ?? []);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- every setState in refresh sits behind the fetch awaits in Promise.all, never synchronous (same accepted pattern as components/cyberlab-console.tsx)
    void refresh();
  }, [refresh]);

  function toggleTarget(value: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }

  async function attest() {
    if (!attestValue.trim()) return;
    setAttesting(true);
    setError("");
    try {
      const res = await fetch("/api/cyberlab/targets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: attestKind, value: attestValue.trim(), sourceDeviceId: attestDeviceId || null }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Couldn’t attest that target.");
        return;
      }
      setAttestValue("");
      setAttestDeviceId("");
      await refresh();
    } catch {
      setError("Network error — couldn’t attest that target.");
    } finally {
      setAttesting(false);
    }
  }


  async function start(slug: string) {
    const chosen = targets.filter((t) => selected.has(t.value));
    if (chosen.length === 0) {
      setError("Pick at least one attested target for the run.");
      return;
    }
    setStarting(slug);
    setError("");
    try {
      const res = await fetch("/api/cyberlab/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenarioSlug: slug, targets: chosen.map((t) => ({ kind: t.kind, value: t.value })) }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        issues?: Array<{ kind: string; value: string; reason: string }>;
        rangeId?: string;
        episodeId?: string;
        verified?: boolean;
        signedHash?: string | null;
        techniques?: string[];
      };
      if (!res.ok) {
        const issues = Array.isArray(data.issues)
          ? ` — ${data.issues.map((i) => `${i.kind}:${i.value} (${issueText(i.reason)})`).join("; ")}`
          : "";
        setError(`${data.error ?? `run refused (${res.status})`}${issues}`);
        await refresh();
        return;
      }
      // Success: open the SSE stream for this range so the console replays the
      // real, signed timeline across all three panes (the S2/S3 ad machine).
      if (data.rangeId) replay(data.rangeId);
      await refresh();
    } catch {
      setError("Network error — the run did not start.");
    } finally {
      setStarting(null);
    }
  }

  /**
   * Scan-first recon: the real-world "how would someone break in" step that
   * does NOT need an attested device. It declares a scope (e.g. a /24 network)
   * and POSTs it as a recon run — the engine validates the scope (no
   * third-party / too-broad scanning) and runs the simulated recon. On success
   * it opens the same SSE replay as any run, so radar + rail + feed all move
   * off the real signed timeline. This is a *simulated* recon: no packet
   * leaves the platform.
   */
  async function startRecon() {
    const value = reconValue.trim();
    if (!value) {
      setError("Declare a scope to scan (e.g. 10.0.0.0/24).");
      return;
    }
    setScanning(true);
    setError("");
    try {
      const res = await fetch("/api/cyberlab/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenarioSlug: RECON_SCENARIO_SLUG, targets: [{ kind: reconKind, value }] }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        rangeId?: string;
      };
      if (!res.ok) {
        setError(data.error ?? `recon refused (${res.status})`);
        await refresh();
        return;
      }
      if (data.rangeId) replay(data.rangeId);
      await refresh();
    } catch {
      setError("Network error — the scan did not start.");
    } finally {
      setScanning(false);
    }
  }

  /**
   * Open the SSE stream for a range and reveal its REAL events one by one, on a
   * gentle schedule derived from the events' own timestamps. The `at` shown is
   * the real recorded time; the pacing is presentation only. Every frame lands
   * in the same state the panes read, so radar + rail + feed all move together
   * — and only when a real event moved them.
   */
  function replay(rangeId: string) {
    closeStream();
    setOpenFrame(null);
    setPlayed([]);
    setEvidenceLines([]);
    setDone(null);
    setStreamError("");

    const es = new EventSource(`/api/cyberlab/runs/${rangeId}/stream`);
    esRef.current = es;
    let cursor = 0;
    let lastAt: number | null = null;

    const schedule = (fn: () => void, at: string) => {
      const t = Date.parse(at);
      const gap = lastAt !== null && Number.isFinite(t) ? Math.max(REPLAY_MIN_GAP_MS, Math.min(REPLAY_MAX_GAP_MS, t - lastAt)) : REPLAY_MIN_GAP_MS;
      if (Number.isFinite(t)) lastAt = t;
      const handle = window.setTimeout(() => {
        cursor += 1;
        fn();
      }, cursor === 0 ? 0 : gap);
      timersRef.current.push(handle);
    };

    es.onmessage = (msg) => {
      const frame = JSON.parse(msg.data as string) as
        | OpenFrame
        | { type: "event"; at: string; event: string; detail: Record<string, unknown> | null; stage: LabStageId }
        | { type: "evidence"; path: string; sha256: string; bytes: number }
        | DoneFrame;

      if (frame.type === "open") {
        lastAt = null;
        cursor = 0;
        setOpenFrame(frame);
      } else if (frame.type === "event") {
        schedule(() => setPlayed((prev) => [...prev, { at: frame.at, event: frame.event, detail: frame.detail, stage: frame.stage }]), frame.at);
      } else if (frame.type === "evidence") {
        schedule(() => setEvidenceLines((prev) => [...prev, { path: frame.path, sha256: frame.sha256, bytes: frame.bytes }]), new Date().toISOString());
      } else if (frame.type === "done") {
        schedule(() => setDone(frame), new Date().toISOString());
      }
    };
    es.onerror = () => {
      closeStream();
      setStreamError("The run stream ended before completing — the episode is still listed below if it signed.");
    };
  }

  async function openEpisodeDetail(id: string) {
    setLoadingEpisode(id);
    setError("");
    try {
      const res = await fetch(`/api/cyberlab/episodes/${id}`);
      const data = (await res.json().catch(() => ({}))) as { episode?: EpisodeDetail; signatureValid?: boolean; error?: string };
      if (!res.ok || !data.episode) {
        setError(typeof data.error === "string" ? data.error : "Couldn’t load that episode.");
        return;
      }
      setOpenEpisode({ detail: data.episode, signatureValid: Boolean(data.signatureValid) });
    } catch {
      setError("Network error — couldn’t load that episode.");
    } finally {
      setLoadingEpisode("");
    }
  }

  const manifestEntries = openEpisode?.detail.evidenceManifest?.entries ?? [];
  const timelineCount = Array.isArray(openEpisode?.detail.timeline) ? openEpisode!.detail.timeline.length : 0;

  // The radar model: attested targets seeded from the open frame's own timeline,
  // arcs/pulses revealed as real events play. Built with the SAME pure fn the
  // server uses, so geometry can never drift from the honest rules.
  const radarTargets = openFrame?.targets ?? [];
  const fullRadar = buildRadarModel(
    radarTargets,
    played.map((p) => ({ at: p.at, event: p.event, detail: p.detail ?? undefined })),
  );
  const revealedStages = new Set(played.map((p) => p.stage));
  const activeStageId = played.length > 0 ? played[played.length - 1].stage : null;
  const playing = openFrame !== null && done === null;

  // TASK_156B REAL EGRESS — the watermark is MODE-AWARE. A `live` run sends
  // REAL TCP packets out of the platform, so labelling it "SIMULATION" would be
  // a lie about what just touched your equipment. The run frame's own `mode`
  // (recomputed server-side from the stored timeline) decides the label:
  //   live    → an authorized live test, real packets left the platform
  //   dry-run → the owner-approved SIMULATION · YOUR EQUIPMENT (the default,
  //             and what shows whenever no run is on screen)
  // We never flip the label off a client guess — only the server-reported mode.
  const watermark = openFrame?.mode === "live" ? "AUTHORIZED LIVE TEST · REAL PACKETS" : "SIMULATION · YOUR EQUIPMENT";

  return (
    <div className="lab-ops min-h-screen">
      <div className="mx-auto max-w-7xl space-y-6 p-6">
        {/* ── Section chrome — its own identity, a way back ────────────────── */}
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <a href="/dashboard" className="lab-chip inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs">
              ← Back to SpaceWorker
            </a>
            <h1 className="mt-3 text-2xl font-semibold" style={{ color: "var(--lab-text)" }}>
              Operation Console
            </h1>
            <p className="mt-1 text-sm" style={{ color: "var(--lab-muted)" }}>
              Real tool output on attested targets — rings are layout, not latency; nothing moves unless a real event moved it.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="lab-watermark">{watermark}</span>
            <ThemeToggle />
          </div>
        </header>

        {/* ── How Cyber Lab works (Slice 1 guide) — the honest roadmap + how to
              use the console. Collapsible so it never crowds the console. The
              caption states plainly what is live today vs. the scan-first
              journey we are building toward — no overclaiming. */}
        <CyberLabGuide />

        {/* ── The three-pane console (S2) ───────────────────────────────────── */}
        <section className="grid gap-4 lg:grid-cols-[190px_1fr_360px]">
          {/* Left — the kill-chain stage rail (Falcon-style). */}
          <ol className="lab-panel space-y-1 rounded-lg p-3">
            {LAB_STAGES.map((st, i) => {
              const hit = revealedStages.has(st.id);
              const isActive = activeStageId === st.id;
              return (
                <li
                  key={st.id}
                  className="rounded-md px-2.5 py-2 text-sm"
                  style={{
                    background: isActive ? "var(--lab-accent-dim)" : "transparent",
                    color: hit ? "var(--lab-text)" : "var(--lab-muted)",
                    boxShadow: isActive ? "inset 2px 0 0 var(--lab-accent)" : undefined,
                  }}
                  title={st.caption}
                >
                  <span className="mr-1.5 font-mono text-xs opacity-60">{i + 1}</span>
                  {st.label}
                </li>
              );
            })}
          </ol>

          {/* Centre — the radial-rings radar (Zenmap RadialNet homage). */}
          <div className="lab-panel relative rounded-lg p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs" style={{ color: "var(--lab-muted)" }}>
                {openFrame ? `range ${openFrame.rangeId.slice(0, 8)}… · ${openFrame.mode}` : "no run playing"}
              </span>
              {openFrame && (
                <span className="lab-chip rounded px-2 py-0.5 text-[10px] uppercase">
                  {openFrame.live ? "live" : "replay"}
                </span>
              )}
            </div>
            <svg viewBox="0 0 400 400" className="h-auto w-full" role="img" aria-label="Radial topology of this run">
              {/* Concentric rings — pure grid, no data (RADAR_GRID_RINGS). */}
              {[1, 2, 3].map((r) => (
                <circle key={r} cx={200} cy={200} r={RING_RADIUS[r]} fill="none" stroke="var(--lab-line)" strokeWidth={1} />
              ))}
              {/* The sweep beam — mounted ONLY while events are playing. */}
              {playing && (
                <g className="lab-sweep" style={{ transformOrigin: "200px 200px" }}>
                  <path d="M200 200 L200 40 A160 160 0 0 1 314 86 Z" fill="var(--lab-accent-dim)" />
                </g>
              )}
              {/* Arcs — only real from→to pairs between attested nodes. */}
              {fullRadar.arcs.map((a, i) => {
                const from = fullRadar.nodes.find((n) => n.id === a.from);
                const to = fullRadar.nodes.find((n) => n.id === a.to);
                if (!from || !to) return null;
                const p1 = nodeXY(from.ring, from.angleDeg);
                const p2 = nodeXY(to.ring, to.angleDeg);
                return (
                  <line key={`${a.at}-${i}`} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke="var(--lab-accent)" strokeWidth={1.5} className="lab-arc" />
                );
              })}
              {/* Nodes — only attested targets. */}
              {fullRadar.nodes.map((n) => {
                const p = nodeXY(n.ring, n.angleDeg);
                return (
                  <g key={n.id} className="lab-blip">
                    <circle cx={p.x} cy={p.y} r={4} fill="var(--lab-accent)" />
                    <text x={p.x + 8} y={p.y + 3} fill="var(--lab-muted)" fontSize={9} style={{ fontFamily: "var(--lab-font-mono)" }}>
                      {n.value.length > 22 ? `${n.value.slice(0, 22)}…` : n.value}
                    </text>
                  </g>
                );
              })}
              {/* Pulses — only real detection events, only at attested nodes. */}
              {fullRadar.pulses.map((pu, i) => {
                const n = fullRadar.nodes.find((x) => x.id === pu.node);
                if (!n) return null;
                const p = nodeXY(n.ring, n.angleDeg);
                return <circle key={`${pu.at}-${i}`} cx={p.x} cy={p.y} r={6} fill="none" stroke="var(--lab-red)" strokeWidth={2} className="lab-pulse" />;
              })}
            </svg>
            <p className="mt-1 text-[10px]" style={{ color: "var(--lab-muted)" }}>
              Rings are layout by target order — not distance or latency (the dry-run measures neither).
            </p>
          </div>

          {/* Right — the live tool-output / evidence feed. */}
          <div className="lab-panel flex flex-col rounded-lg p-3">
            <span className="mb-2 text-xs" style={{ color: "var(--lab-muted)" }}>Event feed</span>
            <div ref={feedRef} className="max-h-[420px] flex-1 space-y-1 overflow-y-auto font-mono text-xs" style={{ color: "var(--lab-text)" }}>
              {played.length === 0 && !streamError && (
                <p style={{ color: "var(--lab-muted)" }}>Start a run — real events stream here.</p>
              )}
              {played.map((p, i) => (
                <div key={`${p.at}-${i}`} className="flex gap-2">
                  <span className="shrink-0 opacity-50">{new Date(p.at).toLocaleTimeString()}</span>
                  <span className="shrink-0" style={{ color: "var(--lab-accent)" }}>{p.event}</span>
                </div>
              ))}
              {evidenceLines.map((m, i) => (
                <div key={`${m.path}-${i}`} className="flex gap-2" style={{ color: "var(--lab-green)" }}>
                  <span className="shrink-0 opacity-50">evidence</span>
                  <span className="break-all">{m.path} — {m.sha256.slice(0, 12)}… ({m.bytes}B)</span>
                </div>
              ))}
              {done && (
                <div className="mt-2 rounded p-2" style={{ background: "var(--lab-bg-elev)" }}>
                  <div>
                    signature{" "}
                    {done.signatureValid === null ? (
                      <span style={{ color: "var(--lab-muted)" }}>— run did not sign</span>
                    ) : (
                      <span style={{ color: done.signatureValid ? "var(--lab-green)" : "var(--lab-red)" }}>
                        {done.signatureValid ? "VERIFIED" : "INVALID"}
                      </span>
                    )}
                  </div>
                  {done.teardownVerifiedAt && <div style={{ color: "var(--lab-green)" }}>teardown verified</div>}
                </div>
              )}
            </div>
            {streamError && <p className="mt-2 text-xs" style={{ color: "var(--lab-red)" }}>{streamError}</p>}
          </div>
        </section>

        {/* Honest caption under the console — the ignored-refs proof. */}
        {fullRadar.ignoredAddressRefs.length > 0 && (
          <p className="text-xs" style={{ color: "var(--lab-amber)" }}>
            {fullRadar.ignoredAddressRefs.length} event reference{fullRadar.ignoredAddressRefs.length === 1 ? "" : "s"} to
            non-attested address{fullRadar.ignoredAddressRefs.length === 1 ? " was" : "es were"} ignored for drawing.
          </p>
        )}

        {/* ── Scan-first recon (Slice 2): no attested device required ───────── */}
        <section className="lab-panel rounded-lg p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-semibold" style={{ color: "var(--lab-text)" }}>1 · Scan for weaknesses</h2>
            <span className="lab-watermark">SIMULATION · YOUR EQUIPMENT</span>
          </div>
          <p className="mt-1 text-sm" style={{ color: "var(--lab-muted)" }}>
            A real attack never starts with a device you already own — it starts by <em>looking</em>. Declare a scope you&rsquo;re
            authorised to assess and run a scan-first recon. No attested device needed. This is a
            <strong> simulated</strong> recon: no packet leaves the platform, and the findings are synthetic — but the run,
            timeline and signed evidence are real, exactly like every other lab run. Scopes broader than a /24 are refused so we
            never simulate scanning someone else&rsquo;s network.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <select
              value={reconKind}
              onChange={(e) => setReconKind(e.target.value as (typeof TARGET_KINDS)[number])}
              className="rounded-md border bg-transparent px-2 py-1.5 text-sm"
              style={{ borderColor: "var(--lab-line)", color: "var(--lab-text)" }}
            >
              {TARGET_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <input
              value={reconValue}
              onChange={(e) => setReconValue(e.target.value)}
              placeholder="10.0.0.0/24  ·  lab.example.com  ·  10.0.0.7"
              spellCheck={false}
              className="flex-1 min-w-56 rounded-md border bg-transparent px-3 py-1.5 text-sm font-mono"
              style={{ borderColor: "var(--lab-line)", color: "var(--lab-text)" }}
            />
            <button
              type="button"
              onClick={startRecon}
              disabled={scanning}
              className="rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50"
              style={{ background: "var(--lab-accent)", color: "#04211d" }}
            >
              {scanning ? "Scanning…" : "Run scan-first recon"}
            </button>
          </div>
        </section>

        {/* ── Scenarios (the ONE allow-list the engine also reads) ─────────── */}
        <section className="lab-panel rounded-lg p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-semibold" style={{ color: "var(--lab-text)" }}>2 · Simulate the break-in</h2>
            <span className="lab-watermark">SIMULATION · YOUR EQUIPMENT</span>
          </div>
          <p className="mt-1 text-sm" style={{ color: "var(--lab-muted)" }}>
            Once you&rsquo;ve scanned, simulate an actual intrusion on equipment you own. Each run needs at least one attested target — attesting is your declaration that you own or are authorised for the asset.
          </p>
          <div className="mt-4 space-y-3">
            {scenarios.length === 0 && <p className="text-sm" style={{ color: "var(--lab-muted)" }}>No scenarios available yet.</p>}
            {scenarios.map((s) => (
              <div key={s.id} className="rounded-md border p-4" style={{ borderColor: "var(--lab-line)" }}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <span className="font-medium" style={{ color: "var(--lab-text)" }}>{s.name}</span>
                    <span className="lab-chip ml-2 rounded px-1.5 py-0.5 text-xs">{s.klass} · {s.mode}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => start(s.slug)}
                    disabled={starting !== null}
                    className="rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50"
                    style={{ background: "var(--lab-accent)", color: "#04211d" }}
                  >
                    {starting === s.slug ? "Running…" : "Start (dry-run)"}
                  </button>
                </div>
                {s.techniqueIds.length > 0 && (
                  <p className="mt-2 text-xs" style={{ color: "var(--lab-muted)" }}>
                    ATT&amp;CK techniques observed: {s.techniqueIds.join(", ")}
                  </p>
                )}
                <p className="mt-2 text-sm" style={{ color: "var(--lab-text)" }}>
                  <span className="font-medium">Worst case:</span> {s.blastRadius}
                </p>
                <p className="mt-1 text-sm" style={{ color: "var(--lab-text)" }}>
                  <span className="font-medium">Cleanup:</span> {s.cleanup}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* ── Attested targets (the legal spine) ───────────────────────────── */}
        <section className="lab-panel rounded-lg p-5">
          <h2 className="text-lg font-semibold" style={{ color: "var(--lab-text)" }}>Attested targets</h2>
          <p className="mt-1 text-sm" style={{ color: "var(--lab-muted)" }}>
            A run can only touch values checked here. Tick the ones this run should use.
          </p>
          <div className="mt-3 space-y-1">
            {targets.length === 0 && <p className="text-sm" style={{ color: "var(--lab-muted)" }}>No attested targets yet — add one below.</p>}
            {targets.map((t) => (
              <label key={t.id} className="flex items-center gap-2 text-sm" style={{ color: "var(--lab-text)" }}>
                <input type="checkbox" checked={selected.has(t.value)} onChange={() => toggleTarget(t.value)} style={{ accentColor: "var(--lab-accent)" }} />
                <span className="lab-chip rounded px-1.5 py-0.5 text-xs uppercase">{t.kind}</span>
                <span className="font-mono">{t.value}</span>
                {t.sourceDeviceId && (
                  <span className="text-xs" style={{ color: "var(--lab-muted)" }}>
                    from {devices.find((d) => d.id === t.sourceDeviceId)?.name ?? "your device"}
                  </span>
                )}
                <span className="text-xs opacity-60">attested {new Date(t.attestedAt).toLocaleDateString()}</span>
              </label>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <select
              value={attestDeviceId}
              onChange={(e) => {
                const id = e.target.value;
                setAttestDeviceId(id);
                const dev = devices.find((d) => d.id === id);
                if (dev?.lastIp && !attestValue.trim()) {
                  setAttestKind("host");
                  setAttestValue(dev.lastIp);
                }
              }}
              className="rounded-md border px-2 py-1.5 text-sm"
              style={{ background: "var(--lab-bg-elev)", borderColor: "var(--lab-line)", color: "var(--lab-text)" }}
              aria-label="Pick from your devices"
            >
              <option value="">Pick from your devices (optional)…</option>
              {devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                  {d.osName ? ` — ${d.osName}` : ""}
                  {d.lastIp ? ` (${d.lastIp})` : ""}
                </option>
              ))}
            </select>
            <select
              value={attestKind}
              onChange={(e) => setAttestKind(e.target.value as (typeof TARGET_KINDS)[number])}
              className="rounded-md border px-2 py-1.5 text-sm"
              style={{ background: "var(--lab-bg-elev)", borderColor: "var(--lab-line)", color: "var(--lab-text)" }}
            >
              {TARGET_KINDS.map((k) => (
                <option key={k} value={k}>{k}</option>
              ))}
            </select>
            <input
              value={attestValue}
              onChange={(e) => setAttestValue(e.target.value)}
              placeholder="value (e.g. 192.168.56.10, https://staging.example.com)"
              className="min-w-64 flex-1 rounded-md border px-2 py-1.5 text-sm font-mono"
              style={{ background: "var(--lab-bg-elev)", borderColor: "var(--lab-line)", color: "var(--lab-text)" }}
            />
            <button
              type="button"
              onClick={attest}
              disabled={attesting || !attestValue.trim()}
              className="rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-50"
              style={{ borderColor: "var(--lab-line-bright)", color: "var(--lab-text)" }}
            >
              {attesting ? "Attesting…" : "Attest"}
            </button>
          </div>
          <p className="mt-1.5 text-xs" style={{ color: "var(--lab-muted)" }}>
            The device list is your own machines (same as the Devices tab). The address it fills in is what the agent last
            reported — often a LAN address. Scans run from our servers, so for the run to reach that machine you must expose
            the service under test (e.g. port-forward RDP/SMB) or target a machine you can reach directly.
          </p>
        </section>

        {error && (
          <p className="rounded-md border px-3 py-2 text-sm" style={{ borderColor: "var(--lab-red)", color: "var(--lab-red)" }}>
            {error}
          </p>
        )}

        {/* ── Run history ──────────────────────────────────────────────────── */}
        <section className="lab-panel rounded-lg p-5">
          <h2 className="text-lg font-semibold" style={{ color: "var(--lab-text)" }}>Recent runs</h2>
          <div className="mt-3 space-y-1">
            {runs.length === 0 && <p className="text-sm" style={{ color: "var(--lab-muted)" }}>No runs yet.</p>}
            {runs.map((r) => (
              <div key={r.id} className="flex flex-wrap items-center gap-2 text-sm" style={{ color: "var(--lab-text)" }}>
                <span className="lab-chip rounded px-1.5 py-0.5 text-xs">{r.state}</span>
                <span className="font-mono text-xs">{r.id}</span>
                <span className="text-xs opacity-60">{new Date(r.createdAt).toLocaleString()}</span>
                <button type="button" onClick={() => replay(r.id)} className="text-xs underline underline-offset-2" style={{ color: "var(--lab-accent)" }}>
                  replay
                </button>
                {r.teardownVerifiedAt && <span className="text-xs" style={{ color: "var(--lab-green)" }}>teardown verified</span>}
                {r.error && <span className="text-xs" style={{ color: "var(--lab-red)" }}>{r.error}</span>}
              </div>
            ))}
          </div>
        </section>

        {/* ── Evidence episodes (signed, append-only) ──────────────────────── */}
        <section className="lab-panel rounded-lg p-5">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="text-lg font-semibold" style={{ color: "var(--lab-text)" }}>Evidence episodes</h2>
            <span className="lab-watermark">SIMULATION · YOUR EQUIPMENT</span>
          </div>
          <p className="mt-1 text-sm" style={{ color: "var(--lab-muted)" }}>
            Signed and append-only — the signature is recomputed from the stored row on every open, so edits after signing show up as INVALID.
          </p>
          <div className="mt-3 space-y-1">
            {episodes.length === 0 && <p className="text-sm" style={{ color: "var(--lab-muted)" }}>No episodes yet — start a dry-run.</p>}
            {episodes.map((e) => (
              <div key={e.id} className="flex flex-wrap items-center gap-2 text-sm" style={{ color: "var(--lab-text)" }}>
                <button
                  type="button"
                  onClick={() => openEpisodeDetail(e.id)}
                  disabled={loadingEpisode !== ""}
                  className="font-mono text-xs underline underline-offset-2 disabled:opacity-50"
                  style={{ color: "var(--lab-accent)" }}
                >
                  {loadingEpisode === e.id ? "loading…" : e.id}
                </button>
                <span className="text-xs opacity-60">{new Date(e.startedAt).toLocaleString()}</span>
                <span className="lab-chip rounded px-1.5 py-0.5 text-xs">{e.outcome}</span>
                {e.techniques.length > 0 && <span className="text-xs opacity-70">{e.techniques.join(", ")}</span>}
              </div>
            ))}
          </div>

          {openEpisode && (
            <div className="mt-4 rounded-md border p-4" style={{ borderColor: "var(--lab-line)", background: "var(--lab-bg-elev)" }}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono text-sm" style={{ color: "var(--lab-text)" }}>{openEpisode.detail.id}</span>
                <span
                  className="rounded px-2 py-0.5 text-xs font-medium"
                  style={{
                    background: openEpisode.signatureValid ? "rgba(74,222,128,0.15)" : "rgba(255,93,93,0.15)",
                    color: openEpisode.signatureValid ? "var(--lab-green)" : "var(--lab-red)",
                  }}
                >
                  signature {openEpisode.signatureValid ? "VERIFIED" : "INVALID"}
                </span>
              </div>
              {openEpisode.detail.signedHash && (
                <p className="mt-1 break-all font-mono text-xs" style={{ color: "var(--lab-muted)" }}>{openEpisode.detail.signedHash}</p>
              )}
              <p className="mt-2 text-xs" style={{ color: "var(--lab-muted)" }}>
                {manifestEntries.length} artefact{manifestEntries.length === 1 ? "" : "s"} · {timelineCount} timeline
                entr{timelineCount === 1 ? "y" : "ies"} · outcome {openEpisode.detail.outcome}
              </p>
              <ul className="mt-2 space-y-0.5">
                {manifestEntries.map((m) => (
                  <li key={m.path} className="font-mono text-xs" style={{ color: "var(--lab-muted)" }}>
                    {m.path} — sha256 {m.sha256.slice(0, 16)}… ({m.bytes} B)
                  </li>
                ))}
              </ul>
              <button type="button" onClick={() => setOpenEpisode(null)} className="mt-3 text-xs underline underline-offset-2" style={{ color: "var(--lab-muted)" }}>
                Close
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

