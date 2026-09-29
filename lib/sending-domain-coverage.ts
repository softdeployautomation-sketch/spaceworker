import "server-only";
import { readFile } from "fs/promises";
import dns from "node:dns/promises";
import { prisma } from "@/lib/prisma";
import {
  dkimPublicKeyOf,
  dkimRecordName,
  DKIM_SELECTOR,
  domainOfAddress,
  evaluateSigningCoverage,
  normalizeDomain,
  parseSigningTableDomains,
  platformSendingDomain,
  RELAY_PATHS,
  type DkimRecordState,
  type SigningCoverage,
} from "@/lib/sending-domains";

/**
 * How long to wait for one TXT answer before declaring it "we could not tell".
 * Short on purpose: this feeds a verdict on the Test-connection screen, and a
 * stalled resolver must never become a stalled test.
 */
const DKIM_LOOKUP_TIMEOUT_MS = 2_500;

type TxtAnswer =
  | { kind: "rows"; rows: string[] }
  | { kind: "error"; code: string | undefined }
  | { kind: "timeout" };

/**
 * One TXT lookup that CANNOT hang and CANNOT reject.
 *
 * Both properties are load-bearing here. The verdict is rendered while the user
 * waits on the connection test, so the lookup is raced against a timer; and
 * because a raced-away promise may still settle later, its rejection is captured
 * as a value — an unhandled rejection from a lookup nobody is awaiting any more
 * would otherwise be free to take the process down.
 */
async function resolveTxtBounded(name: string, timeoutMs: number): Promise<TxtAnswer> {
  let timer: NodeJS.Timeout | undefined;
  const lookup: Promise<TxtAnswer> = dns.resolveTxt(name).then(
    // resolveTxt gives one entry per record, each split into the 255-byte chunks a
    // long value is cut into — rejoin, or a valid 2048-bit key looks truncated.
    (rows) => ({ kind: "rows", rows: rows.map((chunks) => chunks.join("")) }),
    (e: NodeJS.ErrnoException) => ({ kind: "error", code: e?.code })
  );
  const timeout = new Promise<TxtAnswer>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
  });
  try {
    return await Promise.race([lookup, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * What the outside world can fetch at `<selector>._domainkey.<domain>`.
 *
 * The distinction that matters here, and the one that used to be missed: a
 * resolver answering "no such record" is a DEFINITE failure — a receiver fetches
 * exactly this name, finds nothing, and has no key to check our signature against.
 * Calling that "unknown" handed the user a warning they could not act on. A
 * resolver that did not answer, by contrast, must stay "unknown": turning a
 * momentary SERVFAIL into "no key is published" would accuse a domain that is set
 * up perfectly. Only ENOTFOUND/ENODATA mean the name genuinely does not exist.
 *
 * `expectedP` is the p= of the key we sign with, when we know it. We often do not:
 * the signing key lives in /etc/opendkim at 0600 for the opendkim user, which this
 * process deliberately cannot read. So for a domain added outside this UI we can
 * only say "a key is published" — and "published but unconfirmed" must never be
 * reported as a failure, which is why "present" exists.
 *
 * EXPORTED, and with the timeout injectable, for one reason: the rule that a
 * resolver failing to answer must NOT be read as "no key is published" is the
 * difference between a correct call to action and falsely accusing a domain that
 * is set up perfectly. That rule can only be pinned by driving this function with
 * a resolver that hangs, and it must not cost 2.5 seconds of test time to do so.
 */
export async function lookupDkimState(
  name: string,
  expectedP: string | null,
  timeoutMs: number = DKIM_LOOKUP_TIMEOUT_MS
): Promise<DkimRecordState> {
  const answer = await resolveTxtBounded(name, timeoutMs);
  if (answer.kind === "timeout") return "unknown";
  if (answer.kind === "error") {
    return answer.code === "ENOTFOUND" || answer.code === "ENODATA" ? "missing" : "unknown";
  }
  const keys = answer.rows.map(dkimPublicKeyOf).filter((p): p is string => Boolean(p));
  // A TXT exists but carries no p= (a policy record, or a paste that lost the key):
  // there is no usable public key there, which is exactly what "missing" means to a
  // receiver. Reporting "present" would promise something that cannot verify.
  if (keys.length === 0) return "missing";
  if (expectedP === null) return "present";
  return keys.includes(expectedP) ? "verified" : "mismatch";
}

/**
 * TASK_140 — will this mailbox's mail actually be DKIM-signed?
 *
 * WHY THIS IS A SEPARATE FILE: the decision itself lives in
 * lib/sending-domains.ts as a PURE function so tests/sending-domains.test.ts can
 * pin it with no database, no filesystem and no DNS. This file adds the one
 * thing that needs all three of those to be real — the lookup — and nothing else.
 *
 * The lookup deliberately spans two ownership scopes:
 *   - the caller's OWN sending domains (their From domains), and
 *   - the PLATFORM domain, which belongs to whichever operator account created
 *     it. It is our domain, not the customer's, so restricting it to the
 *     caller's userId would report it unsigned even when it is live — and the
 *     warning would then recommend a domain we cannot honour.
 */
export async function signingCoverageFor(opts: {
  userId: string;
  fromAddresses: string[];
}): Promise<SigningCoverage> {
  const platformDomain = platformSendingDomain();

  // Only the domains actually in play are queried — a mailbox with one From
  // address costs one lookup row, not the whole table.
  const domains = new Set<string>();
  for (const address of opts.fromAddresses) {
    const domain = domainOfAddress(address);
    if (domain !== "") domains.add(domain);
  }
  if (platformDomain) domains.add(platformDomain);

  const rows =
    domains.size === 0
      ? []
      : await prisma.sendingDomain.findMany({
          where: {
            OR: [
              { userId: opts.userId, domain: { in: [...domains] } },
              ...(platformDomain ? [{ domain: platformDomain }] : []),
            ],
          },
          select: {
            domain: true,
            selector: true,
            status: true,
            installedOnRelay: true,
            // The exact value we told this user to publish, so a live lookup can
            // prove the published key IS ours rather than merely existing.
            publicKeyTxt: true,
          },
        });

  // Ask the relay what it ACTUALLY signs, and prefer that answer over our own
  // records (see parseSigningTableDomains for why the two diverge). Fail-soft:
  // if the table cannot be read — a dev machine has no /etc/opendkim — pass
  // undefined and the decision falls back to the DB's installedOnRelay rather
  // than reporting every domain as unsigned.
  let relaySignedDomains: Set<string> | undefined;
  try {
    relaySignedDomains = parseSigningTableDomains(
      await readFile(RELAY_PATHS.signingTable, "utf8")
    );
  } catch {
    relaySignedDomains = undefined;
  }

  const byDomain = new Map(rows.map((row) => [normalizeDomain(row.domain), row] as const));

  // Only domains the relay actually signs are worth a DNS question: a domain with
  // no key on the relay cannot be rescued by anything published in DNS, and asking
  // would add latency to the test for nothing. When the relay table is unreadable
  // (dev), fall back to what the database believes so the lookup still runs where
  // it plausibly matters.
  const toLookUp = [...domains].filter((domain) => {
    const row = byDomain.get(domain);
    return relaySignedDomains !== undefined
      ? relaySignedDomains.has(domain)
      : (row?.installedOnRelay ?? false);
  });

  // In parallel — one small TXT question each, each independently bounded, so the
  // verdict costs one lookup of latency rather than one per domain.
  const dkimRecordStates = new Map<string, DkimRecordState>(
    await Promise.all(
      toLookUp.map(async (domain) => {
        const row = byDomain.get(domain);
        const name = dkimRecordName(domain, row?.selector || DKIM_SELECTOR);
        // No row => we hold no `publicKeyTxt`, so the lookup can only confirm that
        // SOMETHING is published — never that it is ours.
        const expectedP = row ? dkimPublicKeyOf(row.publicKeyTxt) : null;
        return [domain, await lookupDkimState(name, expectedP)] as const;
      })
    )
  );

  return evaluateSigningCoverage({
    fromAddresses: opts.fromAddresses,
    rows,
    platformDomain,
    ...(relaySignedDomains ? { relaySignedDomains } : {}),
    ...(dkimRecordStates.size > 0 ? { dkimRecordStates } : {}),
  });
}
