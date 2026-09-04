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
 * A real, live "what's my IP" check performed THROUGH the given proxy — never a
 * cached value, so a broken exit-node route is visibly caught. Throws on failure.
 * The request path mirrors the session's own routing surface (same scheme/endpoint),
 * so the returned IP is the exit node's IP, not this VPS's real IP.
 */
export async function checkIpThroughProxy(spec: ProxySpec): Promise<string> {
  const value = curlProxyValue(spec, { withAuth: true });
  return runIpifyCurl(["--proxy", value], "Proxy unreachable");
}

/** Direct (no-proxy) IP check — for a session with no exit node/BYO proxy
 *  configured, showing the server's own real IP rather than throwing. */
export async function checkDirectIp(): Promise<string> {
  return runIpifyCurl([], "Direct connection unreachable");
}

async function runIpifyCurl(proxyArgs: string[], errorPrefix: string): Promise<string> {
  let out: string;
  try {
    const { stdout } = await execFileAsync("curl", [
      "-s",
      "--max-time", "15",
      "--connect-timeout", "10",
      ...proxyArgs,
      "https://api.ipify.org?format=json",
    ]);
    out = stdout;
  } catch (e) {
    throw new Error(`${errorPrefix}: ${e instanceof Error ? e.message : "unknown"}`);
  }
  let ip: unknown;
  try {
    ip = (JSON.parse(out.trim()) as { ip?: unknown }).ip;
  } catch {
    throw new Error("IP check returned a non-JSON response");
  }
  if (typeof ip !== "string" || ip.length === 0) {
    throw new Error("IP check returned no address");
  }
  return ip;
}