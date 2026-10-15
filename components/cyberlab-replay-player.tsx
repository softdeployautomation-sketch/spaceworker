"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { LAB_STAGES, mapEventToStage, type LabStageId } from "@/lib/lab/console-map";
import { buildReplayFrames, parseEpisodeTimeline, replayWatermark } from "@/lib/lab/replay";

// TASK_156B S7-A — the Episode Replay player: a scrubber over ONE stored signed
// episode, so a real recorded run renders like a video. Every frame comes from
// lib/lab/replay.ts → console-map.ts (the SAME pure mapping the live console
// uses) — nothing on screen moves unless a real stored event put it there.
// signatureValid + mode come from the SERVER response, never guessed client-side.
// Playback is the ONLY motion (scrub-driven), so it is reduced-motion friendly.

interface EpisodeDto {
  outcome?: string;
  startedAt?: string;
  timeline?: unknown;
  signedHash?: string | null;
}

const SPEEDS = [400, 200, 100] as const;

function short(value: string): string {
  return value.length > 22 ? `${value.slice(0, 21)}…` : value;
}

function stamp(at: string): string {
  const t = Date.parse(at);
  return Number.isNaN(t) ? at : new Date(t).toISOString().slice(11, 19);
}

function detailText(detail?: Record<string, unknown>): string | null {
  if (!detail) return null;
  const from = typeof detail.from === "string" ? detail.from : null;
  const to = typeof detail.to === "string" ? detail.to : null;
  if (from && to) return `${from} → ${to}`;
  if (to) return `→ ${to}`;
  if (from) return `${from} →`;
  return null;
}

/** Ring radius for a 1-based layout ring (layout, not latency — see console-map). */
function ringRadius(ring: number): number {
  return [0, 45, 80, 115][ring] ?? 80;
}

function nodePoint(ring: number, angleDeg: number): { x: number; y: number } {
  const rad = (angleDeg * Math.PI) / 180;
  const r = ringRadius(ring);
  return { x: Math.cos(rad) * r, y: Math.sin(rad) * r };
}

export function CyberLabReplayPlayer({ episodeId }: { episodeId: string }) {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [signatureValid, setSignatureValid] = useState(false);
  const [meta, setMeta] = useState<EpisodeDto>({});
  const [timeline, setTimeline] = useState<unknown>(null);
  const [idx, setIdx] = useState(0);
  const [speed, setSpeed] = useState(0);
  const [playing, setPlaying] = useState(false);
  // Mirror of idx for the interval's end check (interval closure must not go
  // stale, and setState inside a setState updater is impure).
  const idxRef = useRef(0);

  useEffect(() => {
    idxRef.current = idx;
  }, [idx]);

  // episodeId is fixed per mounted page (Next remounts per URL), so there is no
  // "reset on change" effect — initial state (idx 0, paused) is already correct.
  useEffect(() => {
    let live = true;
    fetch(`/api/cyberlab/episodes/${encodeURIComponent(episodeId)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("not found"))))
      .then((data) => {
        if (!live) return;
        setMeta(data.episode ?? {});
        setTimeline(data.episode?.timeline ?? null);
        setSignatureValid(Boolean(data.signatureValid));
        setState("ready");
      })
      .catch(() => {
        if (live) setState("error");
      });
    return () => {
      live = false;
    };
  }, [episodeId]);

  const parsed = useMemo(() => parseEpisodeTimeline(timeline), [timeline]);
  const frames = useMemo(() => buildReplayFrames(parsed.entries), [parsed.entries]);

  useEffect(() => {
    if (!playing || frames.length === 0) return;
    const id = window.setInterval(() => {
      if (idxRef.current + 1 >= frames.length) {
        window.clearInterval(id);
        setPlaying(false);
        return;
      }
      setIdx(idxRef.current + 1);
    }, SPEEDS[speed]);
    return () => window.clearInterval(id);
  }, [playing, frames.length, speed]);

  if (state === "loading") {
    return (
      <p className="p-6 text-sm" style={{ color: "var(--lab-muted)" }}>
        Loading episode…
      </p>
    );
  }
  if (state === "error") {
    return (
      <div className="p-6">
        <p className="text-sm" style={{ color: "var(--lab-red)" }}>
          Episode not found — or it belongs to another account.
        </p>
        <a href="/cyberlab" className="mt-2 inline-block text-sm underline" style={{ color: "var(--lab-accent)" }}>
          ← Back to Cyber Lab
        </a>
      </div>
    );
  }

  const frame = frames[Math.min(idx, Math.max(frames.length - 1, 0))];
  const currentStage: LabStageId | null = frame ? mapEventToStage(frame.entry.event) : null;
  const reached = new Set<LabStageId>(frames.slice(0, idx + 1).map((f) => mapEventToStage(f.entry.event)));
  const ignored = frame?.radar.ignoredAddressRefs.length ?? 0;

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      {/* ── header ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <a href="/cyberlab" className="text-sm underline underline-offset-2" style={{ color: "var(--lab-accent)" }}>
            ← Cyber Lab
          </a>
          <h1 className="text-xl font-semibold" style={{ color: "var(--lab-text)" }}>
            Episode replay
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <span className="lab-chip rounded px-2 py-0.5 text-xs">REPLAY</span>
          <span className="lab-watermark">{replayWatermark(parsed.mode)}</span>
        </div>
      </div>

      {/* ── signature + meta (server-reported, verbatim) ────────────────── */}
      <div className="lab-panel mt-4 rounded-lg p-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span
            className="rounded px-2 py-0.5 text-xs font-medium"
            style={{
              background: signatureValid ? "rgba(74,222,128,0.15)" : "rgba(255,93,93,0.15)",
              color: signatureValid ? "var(--lab-green)" : "var(--lab-red)",
            }}
          >
            signature {signatureValid ? "VERIFIED" : "INVALID"}
          </span>
          <span className="lab-chip rounded px-1.5 py-0.5 text-xs">{meta.outcome ?? parsed.mode}</span>
          {parsed.scenarioSlug && (
            <span className="text-xs" style={{ color: "var(--lab-muted)" }}>
              {parsed.scenarioSlug}
            </span>
          )}
          {meta.startedAt && (
            <span className="text-xs" style={{ color: "var(--lab-muted)" }}>
              {new Date(meta.startedAt).toISOString().replace("T", " ").slice(0, 19)} UTC
            </span>
          )}
        </div>
        {meta.signedHash && (
          <p className="mt-1 break-all font-mono text-xs" style={{ color: "var(--lab-muted)" }}>
            {meta.signedHash}
          </p>
        )}
        <p className="mt-1 text-xs" style={{ color: "var(--lab-muted)" }}>
          Signed evidence replayed from the stored episode — every frame is a real recorded event. Rings are layout, not latency.
        </p>
      </div>

      {frames.length === 0 ? (
        <p className="mt-4 text-sm" style={{ color: "var(--lab-muted)" }}>
          This episode has no timeline frames.
        </p>
      ) : (
        <div className="mt-4 grid gap-4 lg:grid-cols-[190px_minmax(0,1fr)_320px]">
          {/* ── stage rail ─────────────────────────────────────────────── */}
          <section className="lab-panel rounded-lg p-4">
            <h2 className="text-sm font-semibold" style={{ color: "var(--lab-text)" }}>
              Kill chain
            </h2>
            <ol className="mt-2 space-y-1.5">
              {LAB_STAGES.map((s) => {
                const active = s.id === currentStage;
                const done = reached.has(s.id);
                return (
                  <li
                    key={s.id}
                    className="flex items-center gap-2 text-xs"
                    style={{
                      color: active ? "var(--lab-accent)" : done ? "var(--lab-text)" : "var(--lab-muted)",
                      opacity: done || active ? 1 : 0.55,
                    }}
                    title={s.caption}
                  >
                    <span aria-hidden>{active ? "▶" : done ? "✓" : "○"}</span>
                    <span>{s.label}</span>
                  </li>
                );
              })}
            </ol>
          </section>


          {/* ── radar + controls ───────────────────────────────────────── */}
          <section className="lab-panel rounded-lg p-4">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold" style={{ color: "var(--lab-text)" }}>
                Radar
              </h2>
              <span className="lab-watermark">NODES = ADDRESSES THIS EPISODE RECORDED</span>
            </div>
            <svg viewBox="-120 -120 240 240" className="mx-auto mt-2 w-full max-w-[420px]" role="img" aria-label="Replay radar">
              {[45, 80, 115].map((r) => (
                <circle key={r} r={r} cx={0} cy={0} fill="none" stroke="var(--lab-line)" strokeWidth={1} />
              ))}
              {frame.radar.arcs.map((a, i) => {
                const from = frame.radar.nodes.find((n) => n.id === a.from);
                const to = frame.radar.nodes.find((n) => n.id === a.to);
                if (!from || !to) return null;
                const p1 = nodePoint(from.ring, from.angleDeg);
                const p2 = nodePoint(to.ring, to.angleDeg);
                return (
                  <line key={`${a.at}-${i}`} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke="var(--lab-accent)" strokeWidth={1.5} opacity={0.75} />
                );
              })}
              {frame.radar.pulses.map((pulse, i) => {
                const n = frame.radar.nodes.find((x) => x.id === pulse.node);
                if (!n) return null;
                const p = nodePoint(n.ring, n.angleDeg);
                return (
                  <g key={`p-${pulse.at}-${i}`}>
                    <circle cx={p.x} cy={p.y} r={9} fill="none" stroke="var(--lab-red)" strokeWidth={2} />
                    <circle cx={p.x} cy={p.y} r={14} fill="none" stroke="var(--lab-red)" strokeWidth={1} opacity={0.4} />
                  </g>
                );
              })}
              {frame.radar.nodes.map((n) => {
                const p = nodePoint(n.ring, n.angleDeg);
                return (
                  <g key={n.id}>
                    <circle cx={p.x} cy={p.y} r={5} fill="var(--lab-accent)" />
                    <text x={p.x} y={p.y + 15} textAnchor="middle" fontSize={8} fontFamily="var(--lab-font-mono)" fill="var(--lab-muted)">
                      {short(n.value)}
                    </text>
                  </g>
                );
              })}
            </svg>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => setPlaying((p) => !p)}
                className="rounded px-3 py-1 text-sm font-medium"
                style={{ background: "var(--lab-accent-dim)", color: "var(--lab-accent)", border: "1px solid var(--lab-line-bright)" }}
              >
                {playing ? "⏸ Pause" : "▶ Play"}
              </button>
              <input
                type="range"
                min={0}
                max={frames.length - 1}
                value={idx}
                onChange={(e) => {
                  setPlaying(false);
                  setIdx(Number(e.target.value));
                }}
                className="min-w-[160px] flex-1"
                aria-label="Scrub replay"
              />
              <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} className="lab-chip rounded px-1.5 py-1 text-xs" aria-label="Playback speed">
                <option value={0}>1×</option>
                <option value={1}>2×</option>
                <option value={2}>4×</option>
              </select>
              <span className="font-mono text-xs" style={{ color: "var(--lab-muted)" }}>
                {idx + 1}/{frames.length}
              </span>
            </div>
            <p className="mt-1 font-mono text-xs" style={{ color: "var(--lab-text)" }}>
              {stamp(frame.entry.at)} · {frame.entry.event}
            </p>
            {ignored > 0 && (
              <p className="mt-1 text-xs" style={{ color: "var(--lab-amber)" }}>
                {ignored} address reference(s) ignored — not part of this episode&apos;s recorded set.
              </p>
            )}
          </section>

          {/* ── evidence feed (events up to the scrub position) ─────────── */}
          <section className="lab-panel rounded-lg p-4">
            <h2 className="text-sm font-semibold" style={{ color: "var(--lab-text)" }}>
              Evidence feed
            </h2>
            <p className="text-xs" style={{ color: "var(--lab-muted)" }}>
              Events up to frame {idx + 1} — newest first.
            </p>
            <ul className="mt-2 max-h-[420px] space-y-1.5 overflow-y-auto">
              {frames
                .slice(0, idx + 1)
                .reverse()
                .map((f) => {
                  const d = detailText(f.entry.detail);
                  return (
                    <li key={f.index} className="border-b pb-1 text-xs" style={{ borderColor: "var(--lab-line)", color: "var(--lab-text)" }}>
                      <span className="font-mono opacity-70">{stamp(f.entry.at)}</span>{" "}
                      <span className="font-mono">{f.entry.event}</span>
                      <span className="lab-chip ml-1.5 rounded px-1 py-0.5 text-[10px]">{mapEventToStage(f.entry.event)}</span>
                      {d && (
                        <div className="font-mono text-[11px]" style={{ color: "var(--lab-muted)" }}>
                          {d}
                        </div>
                      )}
                    </li>
                  );
                })}
            </ul>
          </section>
        </div>
      )}
    </div>
  );
}

