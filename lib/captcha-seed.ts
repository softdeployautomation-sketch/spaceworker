// Pure, dependency-free seeded shuffle — used identically by the server
// (to compute the challenge answer hash) and the client (to render the grid).
// The client receives only the `seed` + `targetCount`, never the target
// positions, so solving requires executing this derivation (not reading a
// plaintext `isTarget` field).

/** Mulberry32 PRNG — deterministic, 32-bit, good enough for a CAPTCHA grid. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function stringToSeed(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) | 0;
  }
  return h >>> 0;
}

/**
 * Fisher-Yates shuffle of `[0, n)` driven by a seeded PRNG.
 * Returns the first `take` elements of the shuffled order — these are the
 * CAPTCHA target positions.
 */
export function seededTargets(seed: string, n: number, take: number): number[] {
  const order = Array.from({ length: n }, (_, i) => i);
  const rand = mulberry32(stringToSeed(seed));
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order.slice(0, take).sort((a, b) => a - b);
}
