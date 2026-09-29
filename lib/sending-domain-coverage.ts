import "server-only";
import { prisma } from "@/lib/prisma";
import {
  domainOfAddress,
  evaluateSigningCoverage,
  platformSendingDomain,
  type SigningCoverage,
} from "@/lib/sending-domains";

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
          select: { domain: true, status: true, installedOnRelay: true },
        });

  return evaluateSigningCoverage({
    fromAddresses: opts.fromAddresses,
    rows,
    platformDomain,
  });
}
