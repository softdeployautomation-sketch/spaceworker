import { createHash } from "node:crypto";
import { promises as fs, createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { HOSTING_PROVIDER_LABELS, type HostingProviderId } from "./rules";

// TASK_155 P1 — the storage providers behind ONE interface. The owner asked for
// "multi options available ... host the file directly to Cloudflare or [an]
// external service ... for now we are working with Cloudflare" (2026-10-01), so:
//
//   * `local`      — our own metal (free, no third party). IMPLEMENTED here; it is
//                    the v1 default and needs nothing external.
//   * `cloudflare` — Pages Direct Upload over raw REST. REGISTERED but not yet
//                    implemented (that is P3); the T0 spikes already proved the
//                    REST shape (§9) so wiring it is a drop-in `put`.
//   * `external`   — a generic "bring your own" service. REGISTERED, not yet
//                    implemented; a real one supplies the same four methods.
//
// Every provider writes into a provider-relative key and returns where the bytes
// went (`storagePath` for local, `externalId` for a remote), a public URL, and
// the content hash — which is what makes "rename never touches the bytes"
// provable regardless of engine.

export interface PutInput {
  token: string;
  userId: string;
  filename: string;
  mime: string;
  /** The upload body as a stream, so a large file never has to sit in RAM. */
  body: ReadableStream<Uint8Array>;
}

export interface PutResult {
  storagePath: string | null;
  externalId: string | null;
  url: string;
  bytes: number;
  sha256: string;
}

export interface ObjectRef {
  storagePath: string | null;
  externalId: string | null;
}

export interface HostingProvider {
  id: HostingProviderId;
  label: string;
  /** false => the UI shows it as "coming soon" and `put` throws a clear error. */
  implemented: boolean;
  /** The engine's own per-asset ceiling in MB (undefined = none). */
  maxAssetMb?: number;
  put(input: PutInput): Promise<PutResult>;
  read(ref: ObjectRef): Promise<ReadableStream<Uint8Array>>;
  remove(ref: ObjectRef): Promise<void>;
  publicUrl(token: string): string;
}

/** Thrown when a known-but-unbuilt provider (cloudflare/external) is selected. */
export class HostingProviderNotReadyError extends Error {
  constructor(id: HostingProviderId) {
    super(`The "${id}" hosting engine is not available yet. Switch back to “This server” to keep hosting.`);
    this.name = "HostingProviderNotReadyError";
  }
}

/**
 * The public base for file URLs. Owner ruling (§15): user files are served from
 * the instaweb public family, NEVER the main spaceworker host; `HOSTING_PUBLIC_
 * BASE_URL` carries that choice. It defaults to APP_BASE_URL so this is a
 * zero-behaviour-change addition until the owner sets it (same pattern as
 * PUBLIC_LINK_BASE_URL, lib/env.ts). Read here, at its own call site.
 */
export function hostingPublicBase(): string {
  const raw = process.env.HOSTING_PUBLIC_BASE_URL || process.env.APP_BASE_URL || "";
  return raw.replace(/\/+$/, "");
}

/** Where local bytes live. `/opt/spaceworker/storage/hosting` on the VPS (set in
 *  the service env); a repo-local folder for dev so nothing writes outside the
 *  workspace by accident. */
export function hostingStorageRoot(): string {
  return process.env.HOSTING_STORAGE_DIR ?? path.join(process.cwd(), ".hosting-storage");
}

// Only server-generated ids ever reach the filesystem, but strip anything that
// isn't [A-Za-z0-9_-] anyway so a future caller can never traverse out of root.
function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, "");
  if (!cleaned) throw new Error("invalid storage segment");
  return cleaned;
}

const localProvider: HostingProvider = {
  id: "local",
  label: HOSTING_PROVIDER_LABELS.local,
  implemented: true,
  // No provider ceiling — the AdminSetting per-file cap is the only limit on our
  // own disk (bounded by hostingFreeMaxFileSizeMb, default 512 MB).
  publicUrl(token: string): string {
    return `${hostingPublicBase()}/hf/${token}`;
  },
  async put({ token, userId, body }: PutInput): Promise<PutResult> {
    const dir = path.join(hostingStorageRoot(), safeSegment(userId));
    await fs.mkdir(dir, { recursive: true });
    const finalPath = path.join(dir, safeSegment(token));
    const partPath = `${finalPath}.part`;

    let bytes = 0;
    const hash = createHash("sha256");
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length;
        hash.update(chunk);
        cb(null, chunk);
      },
    });

    try {
      // Stream to a .part file, meter + hash in flight, then rename — so a failed
      // or truncated upload never leaves a half file under the real key.
      await pipeline(
        Readable.fromWeb(body as unknown as Parameters<typeof Readable.fromWeb>[0]),
        meter,
        createWriteStream(partPath)
      );
      await fs.rename(partPath, finalPath);
    } catch (err) {
      await fs.rm(partPath, { force: true });
      throw err;
    }

    return {
      storagePath: finalPath,
      externalId: null,
      url: this.publicUrl(token),
      bytes,
      sha256: hash.digest("hex"),
    };
  },
  async read(ref: ObjectRef): Promise<ReadableStream<Uint8Array>> {
    if (!ref.storagePath) throw new Error("local asset has no storage path");
    const nodeStream = createReadStream(ref.storagePath);
    return Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;
  },
  async remove(ref: ObjectRef): Promise<void> {
    if (!ref.storagePath) return;
    await fs.rm(ref.storagePath, { force: true });
  },
};

function pendingProvider(id: HostingProviderId): HostingProvider {
  const notReady = () => {
    throw new HostingProviderNotReadyError(id);
  };
  return {
    id,
    label: HOSTING_PROVIDER_LABELS[id],
    implemented: false,
    publicUrl(token: string) {
      return `${hostingPublicBase()}/hf/${token}`;
    },
    async put() {
      return notReady();
    },
    async read() {
      return notReady();
    },
    async remove() {
      return notReady();
    },
  };
}

export const HOSTING_PROVIDERS: Record<HostingProviderId, HostingProvider> = {
  local: localProvider,
  cloudflare: pendingProvider("cloudflare"),
  external: pendingProvider("external"),
};

/**
 * Resolve the provider for a stored `hostingProvider` value. A KNOWN id always
 * resolves to itself (so selecting cloudflare surfaces "not available yet"
 * honestly); an UNKNOWN value falls back to `local` so a typo in admin never
 * breaks uploads (schema contract).
 */
export function resolveProvider(id: string): HostingProvider {
  if (id in HOSTING_PROVIDERS) return HOSTING_PROVIDERS[id as HostingProviderId];
  return HOSTING_PROVIDERS.local;
}

/** For the admin picker / Connection pane: every option + whether it's live. */
export function listProviders(): Array<{ id: HostingProviderId; label: string; implemented: boolean }> {
  return (Object.keys(HOSTING_PROVIDERS) as HostingProviderId[]).map((id) => ({
    id,
    label: HOSTING_PROVIDERS[id].label,
    implemented: HOSTING_PROVIDERS[id].implemented,
  }));
}
