// TASK_157 Phase 1 — the domain registry's PURE rules (PLAN_TASK_157 §3).
//
// No prisma, no fs, no network — same discipline as lib/hosting/rules.ts, so the
// whole free-vs-premium host decision is provable in a unit test instead of only
// on the VPS.
//
// THE ONE IDEA, APPLIED TWICE: free runs on Cloudflare's OWN free hostname, which
// needs no domain, no zone and no registrar; premium runs on a platform domain the
// admin controls. Sites and links differ only in which host that is.
//
//   FREE                          PREMIUM
//   <project>.pages.dev           <slug>.<hostingPremiumSiteDomain>
//   <worker>.<sub>.workers.dev    <hostingPremiumLinkDomain>
//
// The dev host is never removed — it is the default AND the fallback whenever a
// premium domain is unset, its zone is not active, or the attach fails. The owner
// asked for exactly that ("I like the way it goes to dev ... just want that as an
// option"), so a broken premium config degrades to a working dev URL rather than a
// dead link.

/** A DNS label: 1–63 chars, letters/digits/dashes, no leading or trailing dash. */
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** A hostname: two or more labels, each a valid DNS label. */
export function isValidHostname(host: string): boolean {
  if (!host || host.length > 253) return false;
  const labels = host.split(".");
  if (labels.length < 2) return false;
  return labels.every((l) => LABEL_RE.test(l));
}

/**
 * A single label, for the workers.dev account subdomain. Cloudflare's own rules
 * are stricter than a general hostname: the subdomain becomes a DNS label in
 * `<worker>.<sub>.workers.dev`, so dashes are allowed but dots are NOT.
 */
export function isValidAccountSubdomain(value: string): boolean {
  return LABEL_RE.test(value);
}

/**
 * Normalises a host typed by a human (or pasted from a dashboard) into a bare
 * hostname, or null when it is not usable. Accepts a full URL, a host:port, or a
 * trailing dot, and lower-cases the result — so "https://Go.InstaWeb.top/" and
 * "go.instaweb.top." both resolve to "go.instaweb.top" instead of failing an
 * equality check later.
 */
export function normalizeHostInput(input: string | null | undefined): string | null {
  if (!input) return null;
  let host = input.trim().toLowerCase();
  if (!host) return null;
  if (host.includes("://")) {
    try {
      host = new URL(host).hostname;
    } catch {
      return null;
    }
  }
  host = host.replace(/\.$/, "").split("/")[0];
  host = host.split(":")[0];
  return isValidHostname(host) ? host : null;
}

/** How many labels a hostname has: `instaweb.top` = 2, `a.b.instaweb.top` = 4. */
export function labelCount(host: string): number {
  return host.split(".").filter(Boolean).length;
}

/**
 * Whether Cloudflare's FREE Universal SSL covers this hostname.
 *
 * Verified against Cloudflare's docs: on a full setup Universal SSL covers the
 * apex and FIRST-LEVEL subdomains only (`example.com`, `www.example.com`). A
 * second-level name (`a.sites.example.com`) needs Total TLS or an advanced
 * certificate — both paid. This is why the premium SITE domain must be an apex
 * zone: `<slug>.<apex>` is three labels and covered, whereas pasting
 * `sites.example.com` as the base would produce a permanently certificate-less
 * host. Surfaced as a warning in the admin panel, never a silent failure.
 */
export function universalSslCovered(host: string): boolean {
  return labelCount(host) <= 3;
}

export interface SiteHostResolution {
  /** The full host a premium site is published at, e.g. "my-site.instaweb.top". */
  host: string;
  /** False when the host is too deep for free Universal SSL (needs Total TLS). */
  universalSslCovered: boolean;
}

/**
 * The host a premium SITE is served at: `<slug>.<baseDomain>`.
 *
 * Returns null when either half is missing or malformed, which is the signal for
 * the caller to fall back to the free `<project>.pages.dev` host — a null here is
 * never an error the user should see, it is the documented dev default.
 */
export function resolveSiteHost(
  baseDomain: string | null | undefined,
  slug: string
): SiteHostResolution | null {
  const base = normalizeHostInput(baseDomain);
  if (!base) return null;
  const label = slug.trim().toLowerCase();
  if (!LABEL_RE.test(label)) return null;
  const host = `${label}.${base}`;
  if (!isValidHostname(host)) return null;
  return { host, universalSslCovered: universalSslCovered(host) };
}

export interface LinkHostSources {
  /** AdminSetting.hostingPremiumLinkDomain — a full host, e.g. "go.instaweb.top". */
  premiumLinkDomain?: string | null;
  /** The account's first usable zone, used to derive `go.<zone>` when unset. */
  zoneName?: string | null;
  /** The account's workers.dev subdomain, the last-resort free host. */
  workersDevSubdomain?: string | null;
  /** The Worker script name, whose label prefixes the workers.dev host. */
  workerName?: string | null;
}

/**
 * The host a premium LINK redirect publishes under, in strict priority order:
 *
 *   1. the admin's `hostingPremiumLinkDomain` (a host, because the host is what
 *      becomes the Worker route);
 *   2. `go.<first usable zone>` — the pre-TASK_157 behaviour, kept so an account
 *      that configured nothing keeps working exactly as it does today;
 *   3. the account's `*.workers.dev` host — no domain, no DNS, no route.
 *
 * An empty string is treated exactly like unset, so the AdminSetting default
 * ("") means "fall through", not "publish to an empty host".
 */
export function resolveLinkHost(sources: LinkHostSources): string | null {
  const premium = normalizeHostInput(sources.premiumLinkDomain);
  if (premium) return premium;

  const zone = normalizeHostInput(sources.zoneName);
  if (zone) return `go.${zone}`;

  return resolveWorkersDevHost(sources.workerName, sources.workersDevSubdomain);
}

/**
 * Whether a host is served by Cloudflare's own workers.dev edge.
 *
 * This one predicate is what makes the free/premium split work at PUBLISH time,
 * because a workers.dev host is fundamentally different from a zoned host:
 * Cloudflare already owns the name, already serves it, and already routes
 * `<script>.workers.dev` to the script of that name. So there is no zone to
 * look up, no DNS record to create and no route to install — running the normal
 * zoned publish against one fails at the FIRST step with a confusing
 * "no zone" error, having changed nothing.
 *
 * `host.endsWith` alone would also match an attacker-supplied
 * `evilworkers.dev` or `x.workers.dev.attacker.com`, so the dot is required and
 * the label boundary is checked explicitly.
 */
export function isWorkersDevHost(host: string | null | undefined): boolean {
  if (!host) return false;
  return host.toLowerCase().split(".").slice(-2).join(".") === "workers.dev";
}

/**
 * The free, zero-domain host for a Worker: `<worker>.<account-subdomain>.workers.dev`.
 *
 * Cloudflare forms this URL itself, so the only thing we control is the account
 * subdomain (set once per account, globally unique across Cloudflare) and the
 * script name. Returns null when either is missing, which keeps the local
 * `/r/<token>` fallback as the last tier rather than inventing a host.
 */
export function resolveWorkersDevHost(
  workerName: string | null | undefined,
  subdomain: string | null | undefined
): string | null {
  const sub = subdomain?.trim().toLowerCase() ?? "";
  if (!isValidAccountSubdomain(sub)) return null;
  const name = workerName?.trim().toLowerCase() ?? "";
  if (!LABEL_RE.test(name)) return null;
  return `${name}.${sub}.workers.dev`;
}
