// TASK_156 C2a (PLAN_TASK_156 §6, §7 C2, §8) — the evidence chain's PURE core.
//
// Everything here is deliberately dependency-free (no "server-only", no db): the
// SHA-256 manifest, the signature over it, and the verification are the part of
// the lab that must be provable on a bare machine — in CI, in a test, and in a
// reviewer's hands — with no database and no network. The db-backed writer that
// persists a signed episode lives in lib/lab/episode.ts and calls into this.
//
// The contract (§8 "how we prove not simulation"):
//   - Every artefact a run produced is listed in an `EvidenceManifest` with its
//     SHA-256 and byte length. The manifest is canonical-JSON serialised (stable
//     key order), so the same evidence always hashes to the same signature.
//   - `signedHash` binds the manifest to the specific (rangeId, episodeId,
//     startedAt) it belongs to: you cannot move a valid manifest onto another
//     episode, and you cannot edit an entry without invalidating the signature.
//   - Verification recomputes the signature from the STORED manifest + context;
//     a mismatch means the row was tampered with after the fact (there is no
//     update path — but the signature is what makes that verifiable, not
//     merely promised).

import { createHash } from "node:crypto";

/** Bump when the manifest/signature shape changes ( additive to stored rows). */
export const EVIDENCE_SCHEMA_VERSION = "cyberlab-evidence/v1";

/** One produced artefact's identity in the manifest. */
export interface ManifestEntry {
  /** Logical path inside the evidence bundle (never an absolute host path). */
  path: string;
  /** SHA-256 (hex) of the artefact's exact bytes. */
  sha256: string;
  /** Byte length of the artefact. */
  bytes: number;
}

/** The signed list of artefacts a run produced. */
export interface EvidenceManifest {
  schema: string;
  rangeId: string;
  generatedAt: string;
  entries: ManifestEntry[];
  artefactCount: number;
  totalBytes: number;
}

/** What the writer needs to build a manifest: a logical path + its bytes. */
export interface EvidenceArtefact {
  path: string;
  content: string;
}

/** Context that the signature binds the manifest to (episode identity). */
export interface SignatureContext {
  rangeId: string;
  episodeId: string;
  startedAt: string;
}

/** SHA-256 (hex) over the exact bytes of `content` (utf8). */
export function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Canonical JSON: object keys sorted at every level, no whitespace. Two structurally
 * equal values always serialise to the same string, which is what makes the
 * signature deterministic across processes and machines.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = sortKeysDeep(src[key]);
    return out;
  }
  return value;
}

/**
 * Build the manifest for a set of artefacts. Artefact order does not matter:
 * entries are sorted by path so the manifest (and therefore the signature) is
 * stable. Throws if two artefacts claim the same path — a bundle with a
 * duplicate path is ambiguous evidence and is refused rather than silently kept.
 */
export function buildEvidenceManifest(
  rangeId: string,
  artefacts: EvidenceArtefact[],
  now: Date = new Date(),
): EvidenceManifest {
  const seen = new Set<string>();
  const entries: ManifestEntry[] = [];
  for (const art of artefacts) {
    if (seen.has(art.path)) {
      throw new Error(`duplicate_evidence_path (${art.path})`);
    }
    seen.add(art.path);
    entries.push({ path: art.path, sha256: sha256Hex(art.content), bytes: Buffer.byteLength(art.content, "utf8") });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    schema: EVIDENCE_SCHEMA_VERSION,
    rangeId,
    generatedAt: now.toISOString(),
    entries,
    artefactCount: entries.length,
    totalBytes: entries.reduce((sum, e) => sum + e.bytes, 0),
  };
}

/**
 * The signature payload: canonical JSON over the manifest bound to the episode
 * identity. Binding rangeId + episodeId + startedAt is deliberate — a manifest
 * is only valid for the episode it was minted for.
 */
export function signaturePayload(manifest: EvidenceManifest, ctx: SignatureContext): string {
  return canonicalJson({
    schema: manifest.schema,
    ctx: { episodeId: ctx.episodeId, rangeId: ctx.rangeId, startedAt: ctx.startedAt },
    manifest,
  });
}

/** SHA-256 (hex) over the canonical signature payload — the `signedHash`. */
export function signManifest(manifest: EvidenceManifest, ctx: SignatureContext): string {
  return sha256Hex(signaturePayload(manifest, ctx));
}

/**
 * Recompute the signature from a STORED manifest + context and compare. True
 * only when the stored row still matches what was signed: editing any entry,
 * the manifest shape, or the binding context invalidates it.
 */
export function verifyManifestSignature(manifest: EvidenceManifest, ctx: SignatureContext, signedHash: string): boolean {
  if (typeof signedHash !== "string" || signedHash.length !== 64) return false;
  return signManifest(manifest, ctx) === signedHash;
}
