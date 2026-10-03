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

/**
 * TASK_155 P6c — the Workers engine (lib/hosting/workers.ts) is a SIBLING of the
 * Pages one, not a fork of it. Exporting these three lets a Worker call fail with
 * byte-identical wording to a Pages call ("Cloudflare returned 403." / Cloudflare's
 * own first error message), instead of a second, subtly different error path.
 */
export function firstError(body: unknown): string | undefined {
  const env = body as CfEnvelope<unknown> | undefined;
  return env?.errors?.[0]?.message;
}

export async function cfFetch<T>(
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

/**
 * A call authenticated with the SHORT-LIVED UPLOAD JWT (never the account token).
 *
 * The `/pages/assets/*` family is NOT on the account-token API surface: posting an
 * account token there is rejected with `8000013 Authorization failed`, and the
 * project-scoped `…/pages/projects/{p}/check-missing|upload|upsert-hashes` paths
 * that an earlier draft of this file used DO NOT EXIST — Cloudflare answers those
 * with **405 method_not_allowed** (that was the live "Cloudflare returned 405."
 * bug). Verified live 2026-10-02 against the real account: the four original calls
 * are wrong, these three are right.
 */
async function cfAssetFetch<T>(path: string, jwt: string, body: unknown): Promise<CfResult<T>> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
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

/**
 * Mint a project's upload token — REST step 1, and the step the original draft
 * never made. `GET /accounts/{id}/pages/projects/{project}/upload-token` returns
 * `{ result: { jwt } }`; the JWT is valid for ~300 s and is the ONLY credential
 * `/pages/assets/*` accepts. It is never logged, stored or returned to a caller.
 */
export async function uploadToken(cred: CfCredential, project: string): Promise<CfResult<string>> {
  const res = await cfFetch<{ jwt?: string }>(
    cred,
    "GET",
    `/accounts/${cred.accountId}/pages/projects/${project}/upload-token`
  );
  if (!res.ok) return { ok: false, status: res.status, error: res.error };
  const jwt = res.value?.jwt;
  if (!jwt) {
    return { ok: false, status: 502, error: "Cloudflare did not return an upload token for this project." };
  }
  return { ok: true, status: 200, value: jwt };
}

/** True when an asset call failed because the short-lived JWT expired. */
function isExpiredJwt(res: CfResult<unknown>): boolean {
  return res.status === 401 || /authorization failed/i.test(res.error ?? "");
}

/** A best-effort content type for an uploaded asset, so Pages serves it correctly. */
function contentTypeFor(filename: string): string {
  const ext = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "html":
    case "htm":
      return "text/html; charset=utf-8";
    case "css":
      return "text/css; charset=utf-8";
    case "js":
    case "mjs":
      return "text/javascript; charset=utf-8";
    case "json":
      return "application/json";
    case "svg":
      return "image/svg+xml";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "ico":
      return "image/x-icon";
    case "txt":
      return "text/plain; charset=utf-8";
    case "xml":
      return "application/xml";
    case "pdf":
      return "application/pdf";
    case "woff":
      return "font/woff";
    case "woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
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
   * The mime type Pages should serve this asset as. Optional: when omitted the
   * engine derives it from the extension (`contentTypeFor`).
   */
  contentType?: string;
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
  /** The alias Cloudflare minted for this deployment (preview env), when any. */
  alias: string | null;
}

export interface DeploymentStage {
  name: string;
  status: string;
}

/**
 * The readiness gate: poll `GET …/pages/projects/{p}/deployments/{id}` until the
 * deployment reaches a TERMINAL stage.
 *
 * WHY THIS EXISTS: `POST …/deployments` returns 200 as soon as the deployment is
 * CREATED — it is queued, not deployed. Returning that URL immediately means
 * handing the user a link that may still 404. A deployment is only usable once
 * its `deploy` stage is `success`; a stage that goes to `failure` (or the poll
 * timing out) is a hard error with plain language, never a URL that lies.
 */
export async function waitForDeployment(
  cred: CfCredential,
  project: string,
  deploymentId: string,
  opts: { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<CfResult<{ url: string; alias: string | null }>> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const intervalMs = opts.intervalMs ?? 3_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + timeoutMs;

  interface Dep {
    id?: string;
    url?: string;
    environment?: string;
    aliases?: string[];
    latest_stage?: DeploymentStage;
    stages?: DeploymentStage[];
  }

  let lastSeen = "";
  for (;;) {
    const res = await cfFetch<Dep>(
      cred,
      "GET",
      `/accounts/${cred.accountId}/pages/projects/${project}/deployments/${deploymentId}`
    );
    if (!res.ok || !res.value) {
      const transient = res.status === 429 || res.status >= 500;
      if (!transient || Date.now() >= deadline) {
        return { ok: false, status: res.status, error: res.error ?? "Cloudflare would not report the deployment status." };
      }
    } else {
      const dep = res.value;
      // A deployment's `url` is the hash URL (`https://<id>.<sub>.pages.dev`); a
      // preview deployment also gets a stable ALIAS we prefer to show the user.
      const url = dep.url ?? "";
      const alias = dep.aliases?.[0] ?? null;
      const stage = dep.latest_stage ?? dep.stages?.slice(-1)[0];
      lastSeen = stage ? `${stage.name}:${stage.status}` : "unknown";
      if (stage?.status === "success") {
        return { ok: true, status: 200, value: { url, alias } };
      }
      if (stage?.status === "failure") {
        return {
          ok: false,
          status: 502,
          error: `Cloudflare could not finish the deploy (stage “${stage.name}”). Try again in a moment.`,
        };
      }
    }

    if (Date.now() >= deadline) {
      return {
        ok: false,
        status: 504,
        error: lastSeen
          ? `Cloudflare is still deploying your site (stage “${lastSeen}”). Try again in a moment.`
          : "Cloudflare is still deploying your site. Try again in a moment.",
      };
    }
    await sleep(intervalMs);
  }
}

/**
 * The Direct-Upload deploy (§9 T0, §16.1) — FIVE calls, re-verified live on
 * 2026-10-02. `branch` is "main" for a PRODUCTION publish and any other name for
 * a non-production preview (R17). Publish reuses the already-uploaded hashes
 * (check-missing returns nothing missing), so it is effectively a manifest-only
 * call — the bytes move ONCE (§16.1).
 *
 *   1. GET  …/pages/projects/{p}/upload-token      (account token) → short-lived jwt
 *   2. POST /pages/assets/check-missing            (jwt)           → what is missing
 *   3. POST /pages/assets/upload                   (jwt)           → one ARRAY body
 *   4. POST /pages/assets/upsert-hashes            (jwt)
 *   5. POST …/pages/projects/{p}/deployments       (account token, multipart:
 *                                                   `branch` + `manifest` STRINGS)
 *
 * Steps 2–4 are the `/pages/assets/*` family and accept ONLY the upload JWT; the
 * account-token, project-scoped `…/check-missing|upload|upsert-hashes` paths this
 * file used to call do not exist (they answer 405), and step 5 refuses a JSON body
 * ("A \"manifest\" field was expected…") as well as a File part — the manifest must
 * be a plain multipart form field whose value is the JSON string.
 */
export async function deployTree(
  cred: CfCredential,
  project: string,
  files: DeployFile[],
  branch: string,
  /**
   * Readiness gate. Defaults ON: a created-but-queued deployment is exactly what
   * produced a 404 preview URL, so we block until the stage is terminal. Only
   * tests that stub the deployment-status endpoint pass false.
   */
  opts: { awaitReady?: boolean; readyTimeoutMs?: number } = {}
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

  // Mint the upload token. Re-minted once, mid-flight, if it expires.
  const tokenRes = await uploadToken(cred, project);
  if (!tokenRes.ok || !tokenRes.value) {
    return { ok: false, status: tokenRes.status, error: tokenRes.error };
  }
  let jwt = tokenRes.value;
  const refreshJwt = async (): Promise<boolean> => {
    const again = await uploadToken(cred, project);
    if (!again.ok || !again.value) return false;
    jwt = again.value;
    return true;
  };

  // 2. check-missing — which of these hashes are NOT already on Cloudflare?
  let missingRes = await cfAssetFetch<string[]>("/pages/assets/check-missing", jwt, { hashes });
  if (!missingRes.ok && isExpiredJwt(missingRes) && (await refreshJwt())) {
    missingRes = await cfAssetFetch<string[]>("/pages/assets/check-missing", jwt, { hashes });
  }
  if (!missingRes.ok) return { ok: false, status: missingRes.status, error: missingRes.error };
  const missing = new Set(missingRes.value ?? []);

  // 3. upload the missing assets. The body is a JSON ARRAY of
  //    { key, value(base64), metadata:{contentType}, base64:true }.
  let uploaded = 0;
  for (const key of missing) {
    const file = byKey.get(key);
    if (!file) continue;
    const content = await file.read();
    const payload = [
      {
        key,
        value: content.toString("base64"),
        metadata: { contentType: file.contentType ?? contentTypeFor(file.filename) },
        base64: true,
      },
    ];
    let up = await cfAssetFetch<unknown>("/pages/assets/upload", jwt, payload);
    if (!up.ok && isExpiredJwt(up) && (await refreshJwt())) {
      up = await cfAssetFetch<unknown>("/pages/assets/upload", jwt, payload);
    }
    if (!up.ok) return { ok: false, status: up.status, error: up.error ?? `Could not upload “${file.path}”.` };
    uploaded += 1;
  }

  // 4. upsert-hashes — register every hash (uploaded + reused) against the project.
  const upsert = await cfAssetFetch<unknown>("/pages/assets/upsert-hashes", jwt, { hashes });
  if (!upsert.ok) return { ok: false, status: upsert.status, error: upsert.error };

  // 5. deployments — multipart, with `branch` and the manifest as STRING fields.
  //    No Content-Type header: fetch must set the multipart boundary itself.
  let deployRes: Response;
  try {
    const form = new FormData();
    form.append("branch", branch);
    form.append("manifest", JSON.stringify(manifest));
    deployRes = await fetch(
      `${API}/accounts/${cred.accountId}/pages/projects/${project}/deployments`,
      { method: "POST", headers: { Authorization: `Bearer ${cred.token}` }, body: form }
    );
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : "Network error reaching Cloudflare.",
    };
  }

  let deployBody: unknown = undefined;
  try {
    deployBody = await deployRes.json();
  } catch {
    // Envelope-less response; fall through to the status check.
  }
  if (!deployRes.ok) {
    return {
      ok: false,
      status: deployRes.status,
      error: firstError(deployBody) ?? `Cloudflare returned ${deployRes.status}.`,
    };
  }
  const deployEnv = deployBody as CfEnvelope<{ id?: string; url?: string; aliases?: string[] }> | undefined;
  if (deployEnv && deployEnv.success === false) {
    return { ok: false, status: deployRes.status, error: firstError(deployBody) ?? "Cloudflare rejected the deploy." };
  }
  const result = deployEnv?.result;
  const deploymentId = result?.id ?? "";
  const createdUrl = result?.url ?? result?.aliases?.[0] ?? "";

  // 6. READINESS. The 200 above only means "created". Poll the deployment until
  //    its stage is terminal, and only then hand back a URL we can vouch for.
  if (opts.awaitReady !== false) {
    if (!deploymentId) {
      return { ok: false, status: 502, error: "Cloudflare created the deploy but returned no deployment id." };
    }
    const ready = await waitForDeployment(cred, project, deploymentId, {
      timeoutMs: opts.readyTimeoutMs ?? 120_000,
    });
    if (!ready.ok || !ready.value) {
      return { ok: false, status: ready.status, error: ready.error ?? "Cloudflare never finished the deploy." };
    }
    return {
      ok: true,
      status: 200,
      value: {
        url: ready.value.url || createdUrl,
        deploymentId,
        uploaded,
        reused: hashes.length - uploaded,
        alias: ready.value.alias,
      },
    };
  }

  return {
    ok: true,
    status: 200,
    value: {
      url: createdUrl,
      deploymentId,
      uploaded,
      reused: hashes.length - uploaded,
      alias: result?.aliases?.[0] ?? null,
    },
  };
}

