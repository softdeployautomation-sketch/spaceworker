import "server-only";
import type { Prisma } from "@prisma/client";

// Never select/return encryptedPrivateKey, privateKeyIv or privateKeyTag. The
// public key is deliberately included: it IS the value the customer publishes,
// and verification compares the published copy against it.
export const SENDING_DOMAIN_SAFE_SELECT = {
  id: true,
  domain: true,
  selector: true,
  publicKeyTxt: true,
  status: true,
  installedOnRelay: true,
  lastCheckedAt: true,
  lastCheckDetail: true,
  createdAt: true,
} as const satisfies Prisma.SendingDomainSelect;

export type SendingDomainView = Prisma.SendingDomainGetPayload<{
  select: typeof SENDING_DOMAIN_SAFE_SELECT;
}>;
