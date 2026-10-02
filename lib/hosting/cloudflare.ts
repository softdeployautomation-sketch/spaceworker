import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex } from "@noble/hashes/utils";

// TASK_155 P3 — the Cloudflare Pages Direct-Upload client (PLAN §9 T0, §16.1).
//
// This is the PREMIUM engine. It is DARK unless a site's engine is "cloudflare"
// AND the platform/owner account is configured, so shipping it disturbs nothing.
// The REST shape is the one the §9 T0 spikes PASSED against the throwaway account
// (R4/R15/R17/R18): a Pages Direct-Upload deploy is FOUR calls, never a zip
// upload (Cloudflare REFUSES zips — R19):
//
//   1. check-missing   POST /pages/projects/{project}/check-missing  { hashes }
//                      → { result: [missing hashes] }
//   2. upload          POST /pages/projects/{project}/upload         { key, value, metadata, base64:true }
//                      one call per missing hash (value = base64 file bytes)
//   3. upsert-hashes   POST /pages/projects/{project}/upsert-hashes  { hashes }
//   4. deployments     POST /pages/projects/{project}/deployments    { branch, manifest }
//
// The asset KEY is blake3(ext + NUL + content) truncated to 32 hex chars, and the
// VALUE is base64(content) — both exactly as §9 T0 proved (the `file`/`base64`
// flag is what makes the deploy accept raw bytes). Publish reuses the same hashes
// on a different branch, so it is a manifest-only call (§16.1) — never a re-upload.
//
// Tokens are NEVER logged or returned; a caller passes a decrypted credential in
// and only the account id + project name ever appear in a URL.

const API = "https://api.cloudflare.com/client/v4";

export interface CfCredential {
  accountId: string;
  token: string;
}

export interface CfResult<T> {
  ok: boolean;
  value?: T;
  status: number;
  /** Cloudflare's own first error message (plain language), or a network note. */
  error?: string;
}

interface CfEnvelope<T> {
  success: boolean;
  result: T;
  errors?: Array<{ code: number; message: string }>;
}

function firstError(body: unknown): string | undefined {
  const env = body as CfEnvelope<unknown> | undefined;
  return env?.errors?.[0]?.message;
}

async function cfFetch<T>(
  cred: CfCredential,
  method: string,
  path: string,
  body?: unknown
): Promise<CfResult<T>> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${cred.token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : "Network error reaching Cloudflare." };
  }

  let parsed: unknown = undefined;
  try {
    parsed = await res.json();
  } catch {
    // Some endpoints return empty bodies; treat as envelope-less.
  }
  if (!res.ok) {
    return { ok: false, status: res.status, error: firstError(parsed) ?? `Cloudflare returned ${res.status}.` };
  }
  const env = parsed as CfEnvelope<T> | undefined;
  if (env && env.success === false) {
    return { ok: false, status: res.status, error: firstError(parsed) ?? "Cloudflare rejected the request." };
  }
  return { ok: true, status: res.status, value: (env?.result ?? (parsed as T)) };
}

/** The T0 asset key: blake3(ext-without-dot + NUL + content), first 32 hex chars. */
export function pagesAssetKey(filename: string, content: Buffer): string {
  const dot = filename.lastIndexOf(".");
  const ext = dot >= 0 ? filename.slice(dot + 1) : "";
  const input = Buffer.concat([Buffer.from(ext, "utf8"), Buffer.from([0]), content]);
  return bytesToHex(blake3(new Uint8Array(input))).slice(0, 32);
}

/**
 * Verify a credential (§16.4): `GET /user/tokens/verify` plus a cheap
 * `GET /accounts/{id}/pages/projects?per_page=10`. NOTE the `per_page=50` gotcha
 * (PLAN §13.2) — 50 is a trap, so we use 10. A dead token fails CLOSED with plain
 * language; it never silently falls back to the platform account.
 */
export async function verifyCredential(cred: CfCredential): Promise<CfResult<{ accountId: string }>> {
  const verify = await cfFetch<{ status: string }>(cred, "GET", "/user/tokens/verify");
  if (!verify.ok) return { ok: false, status: verify.status, error: verify.error ?? "That API token is not valid." };
  if (verify.value && verify.value.status !== "active") {
    return { ok: false, status: 403, error: "That API token is not active." };
  }
  const projects = await cfFetch<unknown[]>(
    cred,
    "GET",
    `/accounts/${cred.accountId}/pages/projects?per_page=10`
  );
  if (!projects.ok) {
    return {
      ok: false,
      status: projects.status,
      error: projects.error ?? "That token can’t read Pages projects on this account.",
    };
  }
  return { ok: true, status: 200, value: { accountId: cred.accountId } };
}

/** Create a Pages project if it does not already exist. Idempotent. */
export async function ensureProject(cred: CfCredential, project: string): Promise<CfResult<{ name: string }>> {
  const existing = await cfFetch<{ name: string }>(cred, "GET", `/accounts/${cred.accountId}/pages/projects/${project}`);
  if (existing.ok) return existing;
  if (existing.status !== 404) return existing;
  return cfFetch<{ name: string }>(cred, "POST", `/accounts/${cred.accountId}/pages/projects`, {
    name: project,
    production_branch: "main",
  });
}

export interface DeployFile {
  /** Site-relative path with a leading slash, e.g. "/index.html". */
  path: string;
  /** The file's base filename (used for the T0 ext-of-key rule). */
  filename: string;
  /**
   * Lazily read the file's bytes. A getter (not a Buffer) so the whole tree is
   * NEVER resident in RAM at once — files are read one at a time, and only the
   * missing ones are read a second time to upload (§16.6).
   */
  read: () => Promise<Buffer>;
}

export interface DeployResult {
  url: string;
  deploymentId: string;
  uploaded: number;
  reused: number;
}

/**
 * The four-call Direct-Upload deploy (§9 T0). `branch` is "main" for a PRODUCTION
 * publish and any other name for a non-production preview (R17). Publish reuses
 * the already-uploaded hashes (check-missing returns nothing missing), so it is
 * effectively a manifest-only call — the bytes move ONCE (§16.1).
 */
export async function deployTree(
  cred: CfCredential,
  project: string,
  files: DeployFile[],
  branch: string
): Promise<CfResult<DeployResult>> {
  // 1. Build the manifest + the key→file map. Each file is read ONCE here, to
  //    compute its blake3 asset key, then released.
  const manifest: Record<string, string> = {};
  const byKey = new Map<string, DeployFile>();
  for (const file of files) {
    const key = pagesAssetKey(file.filename, await file.read());
    manifest[file.path] = key;
    byKey.set(key, file);
  }
  const hashes = [...byKey.keys()];

  // 2. check-missing — which of these hashes are NOT already on Cloudflare?
  const missingRes = await cfFetch<string[]>(
    cred,
    "POST",
    `/accounts/${cred.accountId}/pages/projects/${project}/check-missing`,
    { hashes }
  );
  if (!missingRes.ok) return { ok: false, status: missingRes.status, error: missingRes.error };
  const missing = new Set(missingRes.value ?? []);

  // 3. upload each missing asset (value = base64 bytes, base64: true).
  let uploaded = 0;
  for (const key of missing) {
    const file = byKey.get(key);
    if (!file) continue;
    const content = await file.read();
    const up = await cfFetch<unknown>(cred, "POST", `/accounts/${cred.accountId}/pages/projects/${project}/upload`, {
      key,
      value: content.toString("base64"),
      metadata: { contentType: "" },
      base64: true,
    });
    if (!up.ok) return { ok: false, status: up.status, error: up.error ?? `Could not upload “${file.path}”.` };
    uploaded += 1;
  }

  // 4. upsert-hashes — register every hash (uploaded + reused) against the project.
  const upsert = await cfFetch<unknown>(
    cred,
    "POST",
    `/accounts/${cred.accountId}/pages/projects/${project}/upsert-hashes`,
    { hashes }
  );
  if (!upsert.ok) return { ok: false, status: upsert.status, error: upsert.error };

  // 5. deployments — the actual deploy, with the manifest.
  const deploy = await cfFetch<{ id: string; url?: string; aliases?: string[] }>(
    cred,
    "POST",
    `/accounts/${cred.accountId}/pages/projects/${project}/deployments`,
    { branch, manifest }
  );
  if (!deploy.ok) return { ok: false, status: deploy.status, error: deploy.error };

  const result = deploy.value;
  const url = result?.url ?? result?.aliases?.[0] ?? "";
  return {
    ok: true,
    status: 200,
    value: {
      url,
      deploymentId: result?.id ?? "",
      uploaded,
      reused: hashes.length - uploaded,
    },
  };
}

