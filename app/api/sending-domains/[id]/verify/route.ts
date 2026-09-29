import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { decryptSecretOrThrow } from "@/lib/mailbox-crypto";
import {
  buildSendingDomainRecords,
  installRelayDkimKey,
  relayAddresses,
  verifySendingDomainDns,
} from "@/lib/sending-domains";
import { SENDING_DOMAIN_SAFE_SELECT } from "@/lib/sending-domain-select";

// TASK_139 — "Verify" means: make the relay ready, then check the DNS.
//
// Bundling the (idempotent) relay install into the verify action gives a failed
// install a natural retry that does NOT hand the customer a new key — important
// because they may already have published the current one somewhere we cannot
// see (that Linode box's DNS is not ours to read or edit).
//
// "verified" deliberately means the WHOLE chain works: records published AND the
// key installed on the relay. A perfect DNS answer with no key on the relay
// signs nothing, so reporting it as verified would be a green tick over mail
// that still lands in spam.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params; // MUST await — async in Next.js 16
  const row = await prisma.sendingDomain.findFirst({ where: { id, userId: session.userId } });
  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { ipv4, ipv6 } = relayAddresses();

  let installed = row.installedOnRelay;
  let installError: string | null = null;
  if (!installed) {
    try {
      const privatePem = decryptSecretOrThrow(
        row.encryptedPrivateKey,
        row.privateKeyIv,
        row.privateKeyTag,
        `sending domain ${row.domain}`
      );
      await installRelayDkimKey({
        domain: row.domain,
        selector: row.selector,
        privatePem,
        publicKeyTxt: row.publicKeyTxt,
      });
      installed = true;
    } catch (err) {
      installError = err instanceof Error ? err.message : String(err);
    }
  }

  const result = await verifySendingDomainDns({
    domain: row.domain,
    selector: row.selector,
    publicKeyTxt: row.publicKeyTxt,
    ipv4,
    ipv6,
  });

  const verified = result.ok && installed;
  const detail = installError
    ? `Relay key could not be installed: ${installError} ${result.detail}`
    : result.detail;

  const updated = await prisma.sendingDomain.update({
    where: { id: row.id },
    data: {
      status: verified ? "verified" : "invalid",
      lastCheckedAt: new Date(),
      lastCheckDetail: detail,
      installedOnRelay: installed,
    },
    select: SENDING_DOMAIN_SAFE_SELECT,
  });

  return NextResponse.json({
    domain: {
      ...updated,
      records: buildSendingDomainRecords({
        domain: updated.domain,
        selector: updated.selector,
        publicKeyTxt: updated.publicKeyTxt,
        ipv4,
        ipv6,
      }),
    },
    checks: result.checks,
  });
}
