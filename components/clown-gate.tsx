"use client";

import { useMemo, useState } from "react";

/**
 * Text-free clown gate (owner, 2026-10-16): the joker image sits on top, a
 * scrambled 3x3 puzzle of the same image sits under it, and the visitor
 * reassembles the picture by tap-tapping two tiles to swap them. The moment
 * the image is whole, the gate unlocks and renders `children` (the support
 * form). No words anywhere — the image is the instruction.
 *
 * Shuffle is seeded server-side so SSR and hydration agree; tiles are pure
 * CSS background slices of one image (works in portrait and landscape).
 */

interface ClownGateProps {
  src: string;
  seed: string;
  children?: React.ReactNode;
}

const GRID = 3;
const TILE_COUNT = GRID * GRID;

/** Deterministic PRNG (mulberry32) from a hex seed. */
function mulberry32(hexSeed: string): () => number {
  let h = 0;
  for (let i = 0; i < hexSeed.length; i++) {
    h = (Math.imul(h, 31) + hexSeed.charCodeAt(i)) | 0;
  }
  return function () {
    h |= 0;
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates shuffle of [0..TILE_COUNT) that never lands on the solved order. */
function shuffled(seed: string): number[] {
  const rnd = mulberry32(seed);
  const order = Array.from({ length: TILE_COUNT }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  if (order.every((tile, slot) => tile === slot)) {
    // Rotate once so the puzzle never starts solved.
    order.push(order.shift()!);
  }
  return order;
}

function isSolved(order: number[]): boolean {
  return order.every((tile, slot) => tile === slot);
}

function tileStyle(src: string, tile: number): React.CSSProperties {
  const col = tile % GRID;
  const row = Math.floor(tile / GRID);
  const cell = 100 / (GRID - 1);
  return {
    backgroundImage: `url(${src})`,
    backgroundSize: `${GRID * 100}% ${GRID * 100}%`,
    backgroundPosition: `${col * cell}% ${row * cell}%`,
  };
}

export default function ClownGate({ src, seed, children }: ClownGateProps) {
  const initial = useMemo(() => shuffled(seed), [seed]);
  const [order, setOrder] = useState<number[]>(initial);
  const [first, setFirst] = useState<number | null>(null);
  const [unlocked, setUnlocked] = useState(false);

  const tap = (slot: number) => {
    if (unlocked) return;
    if (first === null) {
      setFirst(slot);
      return;
    }
    if (first === slot) {
      setFirst(null);
      return;
    }
    const next = [...order];
    [next[first], next[slot]] = [next[slot], next[first]];
    setOrder(next);
    setFirst(null);
    if (isSolved(next)) setUnlocked(true);
  };

  return (
    <div className="min-h-screen bg-[#111114] flex flex-col items-center px-4 py-8">
      {/* The joker, on top. No text anywhere. */}
      <img
        src={src}
        alt=""
        className="w-40 sm:w-52 rounded-lg shadow-[0_0_60px_rgba(255,60,60,0.25)] select-none"
        draggable={false}
      />

      {/* The scramble: same picture in 3x3 slices, tap-tap to swap. */}
      <div className="mt-8 w-full max-w-sm aspect-square rounded-xl overflow-hidden shadow-[0_8px_40px_rgba(0,0,0,0.6)]">
        <div className="grid grid-cols-3 grid-rows-3 w-full h-full gap-[2px] bg-black/60">
          {order.map((tile, slot) => (
            <button
              key={slot}
              type="button"
              aria-hidden={!unlocked}
              onClick={() => tap(slot)}
              className={`bg-cover bg-center transition-transform duration-150 active:scale-95 ${
                unlocked
                  ? "cursor-default"
                  : first === slot
                    ? "ring-4 ring-[#ff3c3c] z-10"
                    : "hover:brightness-110"
              }`}
              style={tileStyle(src, tile)}
            />
          ))}
        </div>
      </div>

      {/* Unlocked → the support form appears in place of nothing. */}
      {unlocked && <div className="mt-8 w-full max-w-xl">{children}</div>}
    </div>
  );
}
