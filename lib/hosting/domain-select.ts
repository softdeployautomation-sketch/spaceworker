// TASK_249 — the PURE rules behind the admin's domain selectors.
//
// No prisma, no network, no env: the account-pin resolution and the
// host-belongs-to-zone test are what decide whether the admin's click can ever
// work, so they are provable in a unit test instead of only on the VPS.
//
// The owner's rule: a domain dropdown lists only zones in the account that
// PURPOSE is pinned to. Files & installer share one host and default to the
// PREMIUM LINKS pin (both are Workers/DNS purposes) — never the sites pin.

export type DomainPurpose = "links" | "sites" | "public";

export interface PurposeAccountPins {
  links: string | null;
  sites: string | null;
  public: string | null;
}

/**
 * The Cloudflare account a purpose publishes to.
 *
 *   links  -> premium links pin
 *   sites  -> premium sites pin
 *   public -> files & installer pin, else the premium links pin
 *
 * Empty/null means "unpinned": the caller falls back to priority rotation.
 */
export function resolvePurposeAccount(
  purpose: DomainPurpose,
  pins: PurposeAccountPins
): string | null {
  switch (purpose) {
    case "links":
      return pins.links;
    case "sites":
      return pins.sites;
    case "public":
      return pins.public || pins.links;
  }
}

/** A bare hostname from admin input, or null when it cannot be one. */
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
  host = host.replace(/\.+$/, "").split("/")[0].split(":")[0];
  if (!host || host.length > 253) return null;
  const labels = host.split(".");
  if (labels.length < 2) return null;
  for (const label of labels) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) return null;
  }
  return host;
}

/**
 * True when `host` can be published under `zoneName`.
 *
 *   sites (isApex)  -> host MUST be the zone itself (example.com)
 *   links/public    -> host MUST be exactly one label deeper (go.example.com)
 *
 * The depth rule is what makes the host covered by Cloudflare's free
 * Universal SSL (`label.apex`), and it is also what stops the admin from
 * routing the apex itself to a Worker (which would shadow the whole zone).
 */
export function zoneMatchesHost(
  host: string,
  zoneName: string,
  isApex: boolean
): boolean {
  const h = normalizeHostInput(host);
  const z = normalizeHostInput(zoneName);
  if (!h || !z) return false;
  if (isApex) return h === z;
  const suffix = `.${z}`;
  if (!h.endsWith(suffix)) return false;
  const label = h.slice(0, -suffix.length);
  return label.length > 0 && !label.includes(".");
}

/** Combine an admin's label + zone into the stored host (pure, for the panel). */
export function hostForZone(
  zoneName: string,
  label: string | null | undefined,
  isApex: boolean
): string | null {
  const zone = normalizeHostInput(zoneName);
  if (!zone) return null;
  if (isApex) return zone;
  const clean = (label ?? "").trim().toLowerCase().replace(/\.+$/, "");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(clean)) return null;
  return `${clean}.${zone}`;
}

/** The apex a host belongs to, without importing the Workers engine. */
export function apexOfHost(input: string | null | undefined): string | null {
  const host = normalizeHostInput(input);
  if (!host) return null;
  const parts = host.split(".");
  return parts.length <= 2 ? host : parts.slice(-2).join(".");
}
