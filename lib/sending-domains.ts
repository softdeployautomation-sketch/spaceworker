import "server-only";
import { execFile } from "child_process";
import { generateKeyPairSync, randomUUID } from "crypto";
import { unlink, writeFile } from "fs/promises";
import dns from "node:dns/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";

/**
 * TASK_139 — self-serve DKIM for mail sent through SpaceWorker's own relay.
 *
 * WHY THIS EXISTS: the local relay (127.0.0.1:587 + OpenDKIM) removed the
 * dependency on a customer's own SMTP server for ACCEPTING our mail. It cannot
 * remove the dependency on the From domain's DNS for AUTHENTICATING it — DKIM
 * works by the verifier fetching a public key from DNS and checking the
 * signature, so the customer must publish the public half of the key we sign
 * with. That is one small, one-time DNS edit, and it is exactly what
 * Resend/SendGrid/Mailgun all require too. It is NOT a dependency on their mail
 * server: nothing here needs that server reachable, working, or even existing.
 *
 * This module owns the three steps that make it self-serve:
 *   1. generate a per-domain keypair             -> generateDkimKeypair
 *   2. tell the customer exactly what to publish -> buildSendingDomainRecords
 *   3. prove the published value matches the key we sign with
 *                                                -> verifySendingDomainDns
 * plus the relay side: putting that key where OpenDKIM will actually use it
 * (KeyTable + SigningTable + reload) and taking it back out again.
 *
 * Two invariants are load-bearing and invisible in the UI, so they are pinned
 * by tests/sending-domains.test.ts:
 *   - verification compares the PUBLISHED p= value against the p= of the key we
 *     sign with. A stale/mismatched record fails DKIM identically to "nothing
 *     published", so reporting "found" without the comparison would show a green
 *     tick for a domain that still lands in spam.
 *   - the relay tables are MERGED, never overwritten: this relay serves every
 *     tenant, so a naive rewrite of the whole KeyTable/SigningTable file would
 *     silently stop signing for every other customer's domain.
 */

const execFileAsync = promisify(execFile);

/** Selector every SpaceWorker-managed key is published under. */
export const DKIM_SELECTOR = "sw";

/**
 * Where the relay keeps its per-domain keys and its two mapping tables. Fixed
 * absolute paths, never built from user input — the only user-derived component
 * is the (validated) domain name.
 */
export const RELAY_PATHS = {
  keysRoot: "/etc/opendkim/keys",
  keyTable: "/etc/opendkim/KeyTable",
  signingTable: "/etc/opendkim/SigningTable",
  keyOwner: "opendkim:opendkim",
} as const;

/** Address DMARC aggregate reports are asked to go to unless overridden. */
export const DMARC_RUA_DEFAULT = "dmarc@spaceworker.top";

// Requires at least one dot, so "localhost" / a bare label can never be treated
// as a sending domain. Each label is 1-63 chars, no leading/trailing hyphen.
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Lowercase, trim, drop the optional root dot. Never validates. */
export function normalizeDomain(input: string): string {
  return input.trim().toLowerCase().replace(/\.+$/, "");
}

export function isValidSendingDomain(input: string): boolean {
  const domain = normalizeDomain(input);
  if (domain.length === 0 || domain.length > 253) return false;
  return DOMAIN_RE.test(domain);
}

/**
 * The domain, or a throw. Every path that reaches a filesystem call goes
 * through this: the domain becomes a directory name under /etc/opendkim/keys,
 * so a value like "../../etc" must be impossible, not merely unlikely.
 */
export function requireValidSendingDomain(input: string): string {
  const domain = normalizeDomain(input);
  if (!isValidSendingDomain(domain)) {
    throw new Error(`Not a valid sending domain: "${input}"`);
  }
  return domain;
}

export interface DkimKeypair {
  /** PKCS#8 PEM — what OpenDKIM reads from KeyTable. */
  privatePem: string;
  /** The exact TXT value the customer publishes. */
  publicKeyTxt: string;
}

/**
 * SPKI PEM -> the "v=DKIM1; k=rsa; p=<base64>" value. DKIM wants the raw DER of
 * the SubjectPublicKeyInfo, base64'd — i.e. the PEM body with the header/footer
 * and every newline stripped.
 */
export function dkimTxtFromSpkiPem(spkiPem: string): string {
  const base64 = spkiPem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  return `v=DKIM1; h=sha256; k=rsa; p=${base64}`;
}

/**
 * RSA-2048: the widest-compatible DKIM key. Ed25519 is smaller and modern but
 * still fails on enough receivers that a deliverability feature is the wrong
 * place to be early.
 */
export function generateDkimKeypair(modulusLength = 2048): DkimKeypair {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { privatePem: privateKey, publicKeyTxt: dkimTxtFromSpkiPem(publicKey) };
}

/** The relay's public addresses, for the SPF record we tell customers to add. */
export function relayAddresses(): { ipv4: string; ipv6: string } {
  return {
    ipv4: (process.env.SENDING_RELAY_IPV4 ?? "").trim(),
    ipv6: (process.env.SENDING_RELAY_IPV6 ?? "").trim(),
  };
}

/**
 * TASK_140 — the platform's OWN authenticated sending domain.
 *
 * WHY THIS EXISTS: a customer's From domain can only be authenticated by a
 * record in that domain's DNS, so DKIM for THEIR domain is impossible for a
 * customer who cannot edit their DNS — no sending setup on our side changes
 * that. The one thing that removes the requirement completely is a domain WE
 * own and authenticate ourselves: once the operator publishes SPF/DKIM/DMARC
 * for their own domain (a ONE-TIME, platform-wide edit — not one edit per
 * customer), any customer can send as that domain and be fully authenticated
 * with zero DNS work of their own. That is exactly how a shared sending domain
 * at Resend/SendGrid behaves, and it is the only answer to "our customers
 * cannot add records" that is not simply "send unauthenticated".
 *
 * OPTIONAL and fail-soft: blank means no platform domain is offered and
 * previous behaviour is unchanged. Never required() — see lib/env.ts.
 */
export function platformSendingDomain(): string | null {
  const raw = (process.env.PLATFORM_SENDING_DOMAIN ?? "").trim();
  if (raw === "") return null;
  const domain = normalizeDomain(raw);
  return isValidSendingDomain(domain) ? domain : null;
}

/**
 * The domain part of an address, lowercased, or "" when it isn't an address.
 * Uses the LAST "@" so a quoted local part still yields the real domain; a
 * missing or empty domain returns "" rather than a partial.
 */
export function domainOfAddress(address: string): string {
  const at = address.lastIndexOf("@");
  if (at < 0 || at === address.length - 1) return "";
  return normalizeDomain(address.slice(at + 1));
}

export type SigningCoverageStatus = "verified" | "unverified" | "unsigned";

export interface SigningCoverageEntry {
  domain: string;
  status: SigningCoverageStatus;
  detail: string;
}

export interface SigningCoverage {
  entries: SigningCoverageEntry[];
  /** From domains whose mail will leave the relay with NO DKIM signature. */
  unsigned: string[];
  /** True when any From domain will be sent unsigned. */
  hasUnsigned: boolean;
  /** The platform domain that would remove the DNS requirement, when configured. */
  platformDomain: string | null;
  /** One user-facing sentence, or null when every From domain is signed. */
  warning: string | null;
}

/**
 * The row fields coverage needs — structural on purpose so the decision can be
 * unit-tested without a database, exactly like the relay table writers above.
 */
export interface SigningDomainRow {
  domain: string;
  status: string;
  installedOnRelay: boolean;
}
/**
 * PURE. Which of these From addresses will actually carry a DKIM signature, and
 * which will be relayed bare?
 *
 * Keyed on `installedOnRelay`, NOT `status`: what the relay does is SIGN with a
 * key that is on disk. A domain whose DNS is not verified yet is still signed
 * (the signature just won't validate), which is a different failure with a
 * different fix — collapsing the two would tell a user to go and publish a
 * record they have already published.
 *
 * The distinction matters because an unsigned send is INVISIBLE: it succeeds,
 * returns 250, and is then spam-foldered by the receiver. That silence is how
 * this exact class of bug survived a whole incident.
 */
export function evaluateSigningCoverage(opts: {
  fromAddresses: string[];
  rows: SigningDomainRow[];
  platformDomain?: string | null;
}): SigningCoverage {
  const platformDomain = opts.platformDomain ? normalizeDomain(opts.platformDomain) : null;

  // Case-insensitive: DNS domains are. A row stored as "Acme.com" must still
  // cover a From of "x@acme.com", or we would warn about a domain that IS signed.
  const byDomain = new Map<string, SigningDomainRow>();
  for (const row of opts.rows) byDomain.set(normalizeDomain(row.domain), row);

  const entries: SigningCoverageEntry[] = [];
  const seen = new Set<string>();
  for (const address of opts.fromAddresses) {
    const domain = domainOfAddress(address);
    if (domain === "" || seen.has(domain)) continue;
    seen.add(domain);

    const row = byDomain.get(domain);
    if (!row || !row.installedOnRelay) {
      entries.push({
        domain,
        status: "unsigned",
        detail:
          `Mail from @${domain} leaves the relay with NO DKIM signature: nothing is ` +
          `installed for that domain, so the relay has no key to sign with`,
      });
    } else if (row.status !== "verified") {
      entries.push({
        domain,
        status: "unverified",
        detail:
          `Mail from @${domain} IS signed, but that domain's DKIM record is not ` +
          `verified yet, so the signature will not validate`,
      });
    } else {
      entries.push({
        domain,
        status: "verified",
        detail: `Mail from @${domain} is signed and its published DKIM key matches`,
      });
    }
  }

  const unsigned = entries.filter((e) => e.status === "unsigned").map((e) => e.domain);
  const hasUnsigned = unsigned.length > 0;

  let warning: string | null = null;
  if (hasUnsigned) {
    const list = unsigned.map((d) => `@${d}`).join(", ");
    const remedy = platformDomain
      ? `Publish this domain's DKIM record on the Sending domains tab, or — if you ` +
        `cannot edit that domain's DNS — send as @${platformDomain}, which this ` +
        `platform has already authenticated and needs no record from you.`
      : `Publish this domain's DKIM record on the Sending domains tab. DKIM requires ` +
        `a public key in the From domain's own DNS, and no sending setup on our side ` +
        `can stand in for it.`;
    warning = `Sending as ${list} will be unauthenticated (no DKIM signature). ${remedy}`;
  }

  return { entries, unsigned, hasUnsigned, platformDomain, warning };
}



export type SendingDnsPurpose = "dkim" | "spf" | "dmarc";

export interface SendingDnsRecord {
  purpose: SendingDnsPurpose;
  type: "TXT";
  name: string;
  value: string;
  note: string;
}

/** The exact records to publish. Pure — no DNS, no filesystem. */
export function buildSendingDomainRecords(opts: {
  domain: string;
  selector: string;
  publicKeyTxt: string;
  ipv4?: string;
  ipv6?: string;
  dmarcRua?: string;
}): SendingDnsRecord[] {
  const domain = requireValidSendingDomain(opts.domain);
  const ipv4 = (opts.ipv4 ?? "").trim();
  const ipv6 = (opts.ipv6 ?? "").trim();
  const rua = (opts.dmarcRua ?? DMARC_RUA_DEFAULT).trim();

  const spfParts = ["v=spf1"];
  if (ipv4) spfParts.push(`ip4:${ipv4}`);
  if (ipv6) spfParts.push(`ip6:${ipv6}`);
  spfParts.push("-all");

  return [
    {
      purpose: "dkim",
      type: "TXT",
      name: `${opts.selector}._domainkey.${domain}`,
      value: opts.publicKeyTxt,
      note:
        "The signature's public key. Some DNS panels split long values into " +
        "several strings — that is fine, but never let the panel re-wrap it " +
        "with spaces inside the p= value.",
    },
    {
      purpose: "spf",
      type: "TXT",
      name: domain,
      value: spfParts.join(" "),
      note:
        "REPLACE any existing v=spf1 record rather than adding a second one — " +
        "two SPF records is a permanent error, worse than none. If this domain " +
        "also sends from other servers, keep their ip4:/include: entries in the " +
        "same record, and use ~all instead of -all until the list is complete.",
    },
    {
      purpose: "dmarc",
      type: "TXT",
      name: `_dmarc.${domain}`,
      value: `v=DMARC1; p=none; rua=mailto:${rua}`,
      note:
        "Start at p=none to collect reports without rejecting anything. Gmail " +
        "and Yahoo require DMARC for bulk senders, so tighten to p=quarantine " +
        "once the reports look clean.",
    },
  ];
}

export interface SendingDomainCheck {
  purpose: SendingDnsPurpose;
  ok: boolean;
  /** Advisory checks are reported but never decide `ok` — see below. */
  advisory: boolean;
  detail: string;
}

export interface SendingDomainVerification {
  ok: boolean;
  status: "verified" | "invalid";
  checks: SendingDomainCheck[];
  /** Human-readable roll-up, stored on SendingDomain.lastCheckDetail. */
  detail: string;
}

/** A domain's TXT records, joined per record. "No answer" == empty list. */
async function txtRecords(name: string): Promise<string[]> {
  try {
    const rows = await dns.resolveTxt(name);
    // resolveTxt returns one entry per record, each an array of the 255-byte
    // chunks a long value gets split into — rejoin before matching, or a
    // perfectly valid 2048-bit DKIM key looks truncated.
    return rows.map((chunks) => chunks.join(""));
  } catch {
    // ENOTFOUND / ENODATA / SERVFAIL all mean "we got nothing to look at".
    // A transient SERVFAIL reads as "not published" here; that is deliberate
    // (the panel says "may still be propagating" and offers a re-check) and is
    // why verify is always an explicit, repeatable action.
    return [];
  }
}

function spfRecordOf(records: string[]): string | null {
  return records.find((r) => /^v=spf1(\s|$)/i.test(r.trim())) ?? null;
}

/** The p= value of a DKIM record, whitespace/formatting tolerant. */
export function dkimPublicKeyOf(record: string): string | null {
  const m = /(?:^|;)\s*p\s*=\s*([^;\s]*)/.exec(record);
  return m ? m[1] : null;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Live DNS verification of the three records. Pure with respect to the
 * filesystem — it reads DNS and nothing else, so it is safe to call from a
 * request handler and usable while the relay key is not yet installed.
 *
 * `ok` is decided by DKIM + SPF only. Both of those AUTHENTICATE the mail;
 * DMARC is reported as advisory because it does not (it tells a receiver what
 * to do with mail that failed the other two). Blocking verification on DMARC
 * would keep a customer who has real DKIM+SPF marked "invalid" for a record
 * that only affects policy.
 */
export async function verifySendingDomainDns(opts: {
  domain: string;
  selector: string;
  publicKeyTxt: string;
  ipv4?: string;
  ipv6?: string;
}): Promise<SendingDomainVerification> {
  const domain = requireValidSendingDomain(opts.domain);
  const ipv4 = (opts.ipv4 ?? "").trim();
  const ipv6 = (opts.ipv6 ?? "").trim();
  const checks: SendingDomainCheck[] = [];

  // --- DKIM: must exist AND carry the same p= we sign with -------------------
  const dkimName = `${opts.selector}._domainkey.${domain}`;
  const dkimRecords = await txtRecords(dkimName);
  const expectedP = dkimPublicKeyOf(opts.publicKeyTxt);
  if (dkimRecords.some((r) => dkimPublicKeyOf(r) === expectedP)) {
    checks.push({
      purpose: "dkim",
      ok: true,
      advisory: false,
      detail: `${dkimName}: published key matches the key this server signs with.`,
    });
  } else if (dkimRecords.length > 0) {
    checks.push({
      purpose: "dkim",
      ok: false,
      advisory: false,
      detail:
        `${dkimName}: a TXT record exists but its p= value is NOT the key we ` +
        `sign with (typically a key from an earlier attempt, or a rotated key). ` +
        `DKIM fails and looks identical to "not published" — replace the value ` +
        `with the one shown here.`,
    });
  } else {
    checks.push({
      purpose: "dkim",
      ok: false,
      advisory: false,
      detail: `${dkimName}: no TXT record yet (DNS may still be propagating).`,
    });
  }

  // --- SPF: must authorise the address receivers actually see ----------------
  const spf = spfRecordOf(await txtRecords(domain));
  if (ipv4 === "" && ipv6 === "") {
    checks.push({
      purpose: "spf",
      ok: false,
      advisory: false,
      detail:
        "SENDING_RELAY_IPV4 / SENDING_RELAY_IPV6 are not set on the server, so " +
        "there is no way to know which address a receiver should be told to " +
        "trust — an operator has to set these before SPF can be verified.",
    });
  } else if (!spf) {
    checks.push({
      purpose: "spf",
      ok: false,
      advisory: false,
      detail: `${domain}: no v=spf1 TXT record, so receivers have no statement authorising this server for this domain.`,
    });
  } else {
    const wanted = [ipv4 ? `ip4:${ipv4}` : "", ipv6 ? `ip6:${ipv6}` : ""].filter(Boolean);
    const missing = wanted.filter((entry) => !new RegExp(`(^|\\s)${escapeRegex(entry)}(\\s|$)`).test(spf));
    checks.push({
      purpose: "spf",
      ok: missing.length === 0,
      advisory: false,
      detail:
        missing.length === 0
          ? `${domain}: SPF authorises this server (${wanted.join(", ")}).`
          : `${domain}: SPF exists but does not authorise ${missing.join(", ")} — mail from this server will fail SPF. Add those to the SAME record.`,
    });
  }

  // --- DMARC: advisory (policy, not authentication) --------------------------
  const dmarcName = `_dmarc.${domain}`;
  const dmarc = (await txtRecords(dmarcName)).find((r) => /^v=DMARC1(\s|;|$)/i.test(r.trim())) ?? null;
  checks.push({
    purpose: "dmarc",
    ok: Boolean(dmarc),
    advisory: true,
    detail: dmarc
      ? `${dmarcName}: ${dmarc}`
      : `${dmarcName}: no record. DKIM and SPF already authenticate this mail, but Gmail/Yahoo require DMARC for bulk senders — worth adding before scaling.`,
  });

  const ok = checks.filter((c) => !c.advisory).every((c) => c.ok);
  return {
    ok,
    status: ok ? "verified" : "invalid",
    checks,
    detail: checks.map((c) => c.detail).join(" | "),
  };
}

/** KeyTable entry: the fully-qualified key name -> where its private key lives. */
export function keyTableEntry(opts: { domain: string; selector: string }): { name: string; line: string } {
  const domain = requireValidSendingDomain(opts.domain);
  const name = `${opts.selector}._domainkey.${domain}`;
  return {
    name,
    line: `${name} ${domain}:${opts.selector}:${RELAY_PATHS.keysRoot}/${domain}/${opts.selector}.private`,
  };
}

/** SigningTable entry: every sender at this domain signs with that key. */
export function signingTableEntry(opts: { domain: string; selector: string }): { name: string; line: string } {
  const domain = requireValidSendingDomain(opts.domain);
  return { name: `*@${domain}`, line: `*@${domain} ${opts.selector}._domainkey.${domain}` };
}

/**
 * Add-or-replace one line in an OpenDKIM table, keyed on the line's first
 * field. MUST be a merge: this file is shared by every tenant's domain, so
 * emitting only the new line would silently stop DKIM signing for every other
 * customer. Duplicate entries for the same key collapse to one.
 */
export function upsertTableLine(existing: string, key: string, line: string): string {
  const kept: string[] = [];
  let replaced = false;
  for (const raw of existing.split("\n")) {
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    if (trimmed.split(/\s+/)[0] === key) {
      if (!replaced) {
        kept.push(line);
        replaced = true;
      }
      continue;
    }
    kept.push(raw.replace(/\s+$/, ""));
  }
  if (!replaced) kept.push(line);
  return `${kept.join("\n")}\n`;
}

/** Remove every line keyed on `key`. Blank-bodied result when nothing is left. */
export function removeTableLine(existing: string, key: string): string {
  const kept = existing
    .split("\n")
    .filter((raw) => raw.trim() !== "")
    .filter((raw) => raw.trim().split(/\s+/)[0] !== key)
    .map((raw) => raw.replace(/\s+$/, ""));
  return kept.length > 0 ? `${kept.join("\n")}\n` : "";
}

/** This module only does anything on the relay host itself. */
function relayHostRequired(): void {
  if (process.platform !== "linux") {
    throw new Error(
      "Installing a relay DKIM key requires the Linux relay host — there is no /etc/opendkim on this machine."
    );
  }
}

// Fixed argument vectors, no shell, same discipline as lib/services-control.ts.
// `sudo -n` (non-interactive) fails fast instead of hanging on a prompt if the
// grant is ever narrowed.
async function sudo(args: string[], timeout: number): Promise<string> {
  const { stdout } = await execFileAsync("sudo", ["-n", ...args], { timeout });
  return stdout;
}

async function readPrivileged(path: string): Promise<string> {
  try {
    return await sudo(["/bin/cat", path], 10_000);
  } catch {
    // Absent/unreadable table == empty table. A genuinely broken file still
    // surfaces loudly, because the reload is what would fail.
    return "";
  }
}

async function writePrivileged(
  path: string,
  content: string,
  opts: { mode: string; owner?: string }
): Promise<void> {
  const tmp = join(tmpdir(), `spaceworker-dkim-${randomUUID()}`);
  try {
    await writeFile(tmp, content, { mode: 0o600 });
    await sudo(["/bin/cp", tmp, path], 10_000);
    await sudo(["/bin/chmod", opts.mode, path], 10_000);
    if (opts.owner) await sudo(["/bin/chown", opts.owner, path], 10_000);
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

/** Path under keysRoot, or a throw. Belt-and-braces on top of domain validation. */
function keyDirFor(domain: string): string {
  const dir = `${RELAY_PATHS.keysRoot}/${domain}`;
  if (!new RegExp(`^${escapeRegex(RELAY_PATHS.keysRoot)}/[a-z0-9.-]+$`).test(dir)) {
    throw new Error(`Refusing to touch an unexpected key path: ${dir}`);
  }
  return dir;
}

/**
 * Put this domain's key where OpenDKIM will use it, then reload.
 *
 * `systemctl reload opendkim` deliberately, not restart. On this box postfix is
 * a stub whose ExecReload is /bin/true (it reports success and changes nothing —
 * the trap recorded in HOW_WE_MOVE_FAST §6), but opendkim's unit carries a real
 * ExecReload=/bin/kill -USR1 $MAINPID that re-reads both tables. A restart would
 * also work and needlessly kill an in-flight signing process.
 */
export async function installRelayDkimKey(opts: {
  domain: string;
  selector: string;
  privatePem: string;
  publicKeyTxt: string;
}): Promise<void> {
  relayHostRequired();
  const domain = requireValidSendingDomain(opts.domain);
  const dir = keyDirFor(domain);
  const keyTable = keyTableEntry({ domain, selector: opts.selector });
  const signingTable = signingTableEntry({ domain, selector: opts.selector });

  await sudo(["/bin/mkdir", "-p", dir], 10_000);
  await sudo(["/bin/chown", RELAY_PATHS.keyOwner, dir], 10_000);
  await writePrivileged(`${dir}/${opts.selector}.private`, opts.privatePem, {
    mode: "600",
    owner: RELAY_PATHS.keyOwner,
  });
  await writePrivileged(`${dir}/${opts.selector}.txt`, `${opts.publicKeyTxt}\n`, {
    mode: "644",
    owner: RELAY_PATHS.keyOwner,
  });

  await writePrivileged(
    RELAY_PATHS.keyTable,
    upsertTableLine(await readPrivileged(RELAY_PATHS.keyTable), keyTable.name, keyTable.line),
    { mode: "644" }
  );
  await writePrivileged(
    RELAY_PATHS.signingTable,
    upsertTableLine(await readPrivileged(RELAY_PATHS.signingTable), signingTable.name, signingTable.line),
    { mode: "644" }
  );

  await reloadRelay();
}

export async function reloadRelay(): Promise<void> {
  relayHostRequired();
  await sudo(["/usr/bin/systemctl", "reload", "opendkim"], 20_000);
}

/** Take a domain's key back out of the relay and reload. Idempotent. */
export async function removeRelayDkimKey(opts: { domain: string; selector: string }): Promise<void> {
  relayHostRequired();
  const domain = requireValidSendingDomain(opts.domain);
  const keyTable = keyTableEntry({ domain, selector: opts.selector });
  const signingTable = signingTableEntry({ domain, selector: opts.selector });

  await writePrivileged(
    RELAY_PATHS.keyTable,
    removeTableLine(await readPrivileged(RELAY_PATHS.keyTable), keyTable.name),
    { mode: "644" }
  );
  await writePrivileged(
    RELAY_PATHS.signingTable,
    removeTableLine(await readPrivileged(RELAY_PATHS.signingTable), signingTable.name),
    { mode: "644" }
  );
  await sudo(["/bin/rm", "-rf", keyDirFor(domain)], 10_000);

  await reloadRelay();
}
