import { execFile } from "child_process";
import { promisify } from "util";

import { encryptSecret, decryptSecret } from "./mailbox-crypto";

const execFileAsync = promisify(execFile);

export type ProxyScheme = "http" | "https" | "socks5" | "socks5h";

export interface ProxySpec {
  scheme: ProxyScheme;
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export const PROXY_SCHEMES: ProxyScheme[] = ["http", "https", "socks5", "socks5h"];

/**
 * Encrypts the BYO credentials portion (username/password) into a single
 * `iv:tag:ciphertext` string, reusing the exact AES-256-GCM machinery Mailbox
 * uses for its encrypted SMTP password. Only the encrypted blob is ever stored —
 * never expose the plaintext to the client.
 */
export function encryptProxySecret(spec: ProxySpec): string {
  const payload = JSON.stringify({ username: spec.username ?? "", password: spec.password ?? "" });
  const { ciphertext, iv, tag } = encryptSecret(payload);
  return [iv, tag, ciphertext].join(":");
}

/** Inverse of encryptProxySecret. Throws if the blob is malformed/undecryptable. */
export function decryptProxySecret(blob: string): { username: string; password: string } {
  const parts = blob.split(":");
  const [iv, tag, ciphertext] = parts;
  if (!iv || !tag || !ciphertext) throw new Error("Malformed encrypted proxy secret");
  try {
    const parsed = JSON.parse(decryptSecret(ciphertext, iv, tag)) as {
      username?: string;
      password?: string;
    };
    return { username: parsed.username ?? "", password: parsed.password ?? "" };
  } catch {
    throw new Error("Could not decrypt proxy secret");
  }
}

/**
 * The `--proxy-server=` value handed to Chrome. Chrome does NOT accept embedded
 * credentials in this flag — for authenticated BYO proxies the user answers the
 * one-time proxy-auth prompt inside the persisted profile (which then remembers
 * it), which is why BYO is a per-profile setting, not a per-session one.
 */
export function proxyServerValue(spec: ProxySpec): string {
  return `${spec.scheme}://${spec.host}:${spec.port}`;
}

/** curl-style `-x` value. Credentials are embedded only for one-shot connectivity
 *  / IP checks (curl supports `-x scheme://user:pass@host:port`). */
export function curlProxyValue(spec: ProxySpec, { withAuth }: { withAuth: boolean }): string {
  const creds =
    withAuth && spec.username
      ? `${encodeURIComponent(spec.username)}:${encodeURIComponent(spec.password ?? "")}@`
      : "";
  return `${spec.scheme}://${creds}${spec.host}:${spec.port}`;
}

/**
 * TASK_239 — the exit-IP check now has a TYPED verdict instead of a thrown
 * sentence. The launch route persists the failure code, so "no IP" can render
 * as "IP check failed: timeout" rather than as nothing at all.
 *
 *   timeout      — curl hit --max-time / was killed (a stalling node)
 *   unreachable  — connect/DNS/proxy refused or any other curl failure
 *   bad_response — the endpoint answered, but not JSON
 *   empty        — the endpoint answered JSON without a usable address
 */
export type IpCheckErrorCode = "timeout" | "unreachable" | "bad_response" | "empty";

export type IpCheckResult =
  | { ok: true; ip: string }
  | { ok: false; error: IpCheckErrorCode };

/** Raw outcome of one curl run — injected in tests so no socket is ever opened. */
export interface CurlOutcome {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
}

export type CurlRunner = (args: string[]) => Promise<CurlOutcome>;

const defaultCurlRunner: CurlRunner = async (args) => {
  try {
    const { stdout, stderr } = await execFileAsync("curl", args, { timeout: 20_000 });
    return { stdout, stderr, code: 0, timedOut: false };
  } catch (e) {
    const err = e as {
      stdout?: string;
      stderr?: string;
      code?: number;
      killed?: boolean;
      signal?: string;
      message?: string;
    };
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      code: typeof err.code === "number" ? err.code : 1,
      timedOut:
        err.killed === true ||
        err.signal === "SIGTERM" ||
        err.code === 28 ||
        /timed out/i.test(err.message ?? ""),
    };
  }
};

/** Pure classification — the taxonomy tests exercise exactly this. */
export function classifyIpCheck(outcome: CurlOutcome): IpCheckResult {
  // curl's own --max-time exit code is 28; the execFile timeout also kills.
  if (outcome.timedOut || outcome.code === 28) return { ok: false, error: "timeout" };
  if (outcome.code !== 0) return { ok: false, error: "unreachable" };
  const body = outcome.stdout.trim();
  if (body.length === 0) return { ok: false, error: "empty" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, error: "bad_response" };
  }
  const ip = (parsed as { ip?: unknown } | null)?.ip;
  if (typeof ip !== "string" || ip.trim().length === 0) return { ok: false, error: "empty" };
  return { ok: true, ip: ip.trim() };
}

export function ipCheckMessage(error: IpCheckErrorCode, prefix: string): string {
  switch (error) {
    case "timeout":
      return `${prefix} unreachable: timed out`;
    case "unreachable":
      return `${prefix} unreachable`;
    case "bad_response":
      return "IP check returned a non-JSON response";
    case "empty":
      return "IP check returned no address";
  }
}

function ipifyArgs(proxyArgs: string[]): string[] {
  return [
    "-s",
    "--max-time", "15",
    "--connect-timeout", "10",
    ...proxyArgs,
    "https://api.ipify.org?format=json",
  ];
}

/** Typed "what's my IP" through the given proxy. Never throws on a failed check. */
export async function probeIpThroughProxy(
  spec: ProxySpec,
  runner: CurlRunner = defaultCurlRunner,
): Promise<IpCheckResult> {
  const value = curlProxyValue(spec, { withAuth: true });
  return classifyIpCheck(await runner(ipifyArgs(["--proxy", value])));
}

/** Typed direct (no-proxy) check — the server's own real IP. */
export async function probeDirectIp(runner: CurlRunner = defaultCurlRunner): Promise<IpCheckResult> {
  return classifyIpCheck(await runner(ipifyArgs([])));
}

/**
 * Throwing wrappers, kept for callers whose fail-closed logic already reads the
 * message (hosted clone relay proof, BYO test). New callers should use the
 * typed `probe*` functions so the failure code can be persisted.
 */
export async function checkIpThroughProxy(spec: ProxySpec): Promise<string> {
  const result = await probeIpThroughProxy(spec);
  if (!result.ok) throw new Error(ipCheckMessage(result.error, "Proxy"));
  return result.ip;
}

export async function checkDirectIp(): Promise<string> {
  const result = await probeDirectIp();
  if (!result.ok) throw new Error(ipCheckMessage(result.error, "Direct connection"));
  return result.ip;
}
