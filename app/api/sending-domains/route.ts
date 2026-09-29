import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { encryptSecret } from "@/lib/mailbox-crypto";
import {
  DKIM_SELECTOR,
  buildSendingDomainRecords,
  generateDkimKeypair,
  installRelayDkimKey,
  isValidSendingDomain,
  normalizeDomain,
  relayAddresses,
  type SendingDnsRecord,
} from "@/lib/sending-domains";
import { SENDING_DOMAIN_SAFE_SELECT, type SendingDomainView } from "@/lib/sending-domain-select";

// TASK_139 — sending domains (self-serve DKIM for mail sent via our relay).
//
// The relay already removes the dependency on a customer's own SMTP server for
// ACCEPTING mail. DKIM cannot be solved the same way: a receiver fetches the
// public key from the From domain's DNS, so the customer has to publish one
// small record. This endpoint makes that self-serve — it generates the keypair,
// puts the key on the relay, and hands back the exact records to publish.
//
// Ordering rule worth keeping: the row is created BEFORE the relay install is
// attempted. A half-failed install must never lose the keypair, because the
// customer may already have published the matching record; "Verify" retries the
// install instead of handing them a second, different key.

function withRecords(rows: SendingDomainView[]): (SendingDomainView & { records: SendingDnsRecord[] })[] {
  const { ipv4, ipv6 } = relayAddresses();
  return rows.map((row) => ({
    ...row,
    records: buildSendingDomainRecords({
      domain: row.domain,
      selector: row.selector,
      publicKeyTxt: row.publicKeyTxt,
      ipv4,
      ipv6,
    }),
  }));
}

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rows = await prisma.sendingDomain.findMany({
    where: { userId: session.userId },
    select: SENDING_DOMAIN_SAFE_SELECT,
    orderBy: { createdAt: "asc" },
  });

  // The relay's own addresses go out with the list so the panel can show what
  // the SPF record has to authorise (and say so plainly when the operator has
  // not configured them, rather than showing a bare, unexplained ✗).
  const { ipv4, ipv6 } = relayAddresses();
  return NextResponse.json({ domains: withRecords(rows), relay: { ipv4, ipv6 } });
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { domain?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const raw = (body.domain ?? "").trim();
  if (!isValidSendingDomain(raw)) {
    return NextResponse.json(
      { error: "Enter a domain name like example.com — no http://, no email address, no path." },
      { status: 400 }
    );
  }
  const domain = normalizeDomain(raw);

  const mine = await prisma.sendingDomain.findFirst({
    where: { userId: session.userId, domain },
    select: { id: true },
  });
  if (mine) {
    return NextResponse.json({ error: `${domain} has already been added.` }, { status: 409 });
  }

  // One domain, one signer. The relay's SigningTable is keyed by domain, so a
  // second account registering the same domain would overwrite the first
  // account's signing entry and break DKIM for BOTH (each side's DNS would be
  // publishing a key the relay no longer uses). Refuse, and say why.
  const taken = await prisma.sendingDomain.findFirst({
    where: { domain, NOT: { userId: session.userId } },
    select: { id: true },
  });
  if (taken) {
    return NextResponse.json(
      {
        error:
          `${domain} is already registered for relay signing by another account. A domain can ` +
          `only be signed by one account at a time — use a subdomain (e.g. mail.${domain}) instead.`,
      },
      { status: 409 }
    );
  }

  const keypair = generateDkimKeypair();
  const { ciphertext, iv, tag } = encryptSecret(keypair.privatePem);

  let created = await prisma.sendingDomain.create({
    data: {
      userId: session.userId,
      domain,
      selector: DKIM_SELECTOR,
      publicKeyTxt: keypair.publicKeyTxt,
      encryptedPrivateKey: ciphertext,
      privateKeyIv: iv,
      privateKeyTag: tag,
    },
    select: SENDING_DOMAIN_SAFE_SELECT,
  });

  try {
    await installRelayDkimKey({
      domain,
      selector: DKIM_SELECTOR,
      privatePem: keypair.privatePem,
      publicKeyTxt: keypair.publicKeyTxt,
    });
    created = await prisma.sendingDomain.update({
      where: { id: created.id },
      data: {
        installedOnRelay: true,
        lastCheckDetail: "Key installed on the sending relay. Publish the records below, then press Verify.",
      },
      select: SENDING_DOMAIN_SAFE_SELECT,
    });
  } catch (err) {
    created = await prisma.sendingDomain.update({
      where: { id: created.id },
      data: {
        installedOnRelay: false,
        lastCheckDetail:
          `The key was generated, but it could not be installed on the sending relay yet: ` +
          `${err instanceof Error ? err.message : String(err)} Press Verify to retry.`,
      },
      select: SENDING_DOMAIN_SAFE_SELECT,
    });
  }

  return NextResponse.json({ domain: withRecords([created])[0] }, { status: 201 });
}
