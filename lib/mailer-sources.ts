import type { PrismaClient } from "@prisma/client";

import { decryptSecretOrThrow } from "./mailbox-crypto";

// TASK_201 S2 — the Mailer EXE's "sources" payload: everything the local send
// engine and the Mailer UI need about THIS user's sending setup, in one fetch.
//
// WHY THIS LAYERING (route = thin auth shell, this lib = data + shape):
//   - The Tauri-bundled runtime has NO DATABASE_URL and NO
//     MAILBOX_ENCRYPTION_KEY (runtime-assemble.mjs scrubs the env down to
//     SPACEWORKER_LOCAL_EXE/BUILD_TARGET/EXE_LICENSE_SECRET), so neither the
//     query nor the decryption can happen in the EXE. The hosted
//     /api/exe-license/mailer-sources route does both and hands the EXE
//     plaintext over HTTPS — the owner-approved tradeoff documented in
//     TASK_201 (v1 local-only send needs real passwords; server-proxy
//     toggle deferred to v1.1).
//   - The payload shape is built FIELD BY FIELD, never by spreading a DB row.
//     The mailbox rows fetched here DO carry encryptedPassword/passwordIv/
//     passwordTag (decryption needs them), so a spread or a `{...row}` would
//     leak ciphertext into every response — the same class of mistake as
//     MAILBOX_SAFE_SELECT's existence, but inverted: here we must read the
//     secrets and must still never return them.
//   - Prisma stays a TYPE-only import so tests can drive both halves with a
//     fake db (house pattern, HOW_WE_MOVE_FAST §4): `prismaMailerSourcesStore`
//     takes the client as a parameter, `buildMailerSources` takes the store.

/** Rows the store must be able to list for a user. Supersets are fine
 *  (structural typing) — Prisma's full Mailbox/SendingDomain/EmailCampaign
 *  rows satisfy all three. */
export interface MailboxSourceRow {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  fromAddresses: string[];
  encryptedPassword: string;
  passwordIv: string;
  passwordTag: string;
  secure: boolean;
  allowInsecure: boolean;
  dailyLimit: number;
  active: boolean;
  sendRegion: string | null;
  lastTestedAt: Date | null;
  lastTestOk: boolean | null;
}

export interface SendingDomainSourceRow {
  id: string;
  domain: string;
  selector: string;
  publicKeyTxt: string;
  status: string;
  installedOnRelay: boolean;
  // Present on the real row; listed here ONLY so tests can prove the output
  // builder drops it — see the private-key test in tests/mailer-sources.test.ts.
  encryptedPrivateKey?: string;
  privateKeyIv?: string;
  privateKeyTag?: string;
}


// ── The exact payloads — EXACT key sets, asserted in tests ────────────────────

export interface MailerSourceMailbox {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  /** DECRYPTED SMTP password. "" when passwordError is set — never a
   *  half-truth: an empty password with a reason beats a silent failure at
   *  connect time. */
  password: string;
  passwordError?: string;
  fromAddresses: string[];
  secure: boolean;
  allowInsecure: boolean;
  dailyLimit: number;
  active: boolean;
  sendRegion: string | null;
  lastTestedAt: Date | null;
  lastTestOk: boolean | null;
}

export interface MailerSourceSendingDomain {
  id: string;
  domain: string;
  selector: string;
  publicKeyTxt: string;
  status: string;
  installedOnRelay: boolean;
  // NOTE: the DKIM PRIVATE key is deliberately absent. Hosted sends sign
  // server-side (OpenDKIM on the relay); the local engine authenticates via
  // the user's own SMTP provider, which signs with ITS own key. Shipping the
  // private key to the EXE would only widen the blast radius of a laptop.
}

export interface MailerSourceTemplate {
  id: string;
  name: string;
  bodyFormat: string;
  subject: string;
  bodyHtml: string;
  subjects: string[];
  bodies: string[];
  createdAt: Date;
  variants: { subject: string; bodyHtml: string }[];
}

export interface MailerSources {
  mailboxes: MailerSourceMailbox[];
  sendingDomains: MailerSourceSendingDomain[];
  templates: MailerSourceTemplate[];
}

// ── Prisma-backed store ───────────────────────────────────────────────────────

/** Query half. Parameterised on the client so the tests can pass a fake that
 *  records the exact args each list* received (proving userId scoping and the
 *  savedAsTemplate filter without a database). */
export function prismaMailerSourcesStore(db: PrismaClient): MailerSourcesStore {
  return {
    async listMailboxes(userId: string): Promise<MailboxSourceRow[]> {
      // Full rows on purpose: decryption needs the encrypted triple. The
      // triple is stripped by buildMailboxSource below, field by field.
      return db.mailbox.findMany({
        where: { userId },
        orderBy: { createdAt: "asc" },
      });
    },
    async listSendingDomains(userId: string): Promise<SendingDomainSourceRow[]> {
      return db.sendingDomain.findMany({
        where: { userId },
        orderBy: { domain: "asc" },
        // Belt and braces with the field-by-field builder: the private key
        // never even leaves the database layer on this path.
        select: {
          id: true,
          domain: true,
          selector: true,
          publicKeyTxt: true,
          status: true,
          installedOnRelay: true,
        },
      });
    },
    async listTemplates(userId: string): Promise<TemplateSourceRow[]> {
      return db.emailCampaign.findMany({
        where: { userId, savedAsTemplate: true },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          name: true,
          bodyFormat: true,
          subject: true,
          bodyHtml: true,
          subjects: true,
          bodies: true,
          createdAt: true,
          variants: {
            orderBy: { createdAt: "asc" },
            select: { subject: true, bodyHtml: true },
          },
        },
      });
    },
  };
}

// ── Builders ──────────────────────────────────────────────────────────────────

export function buildMailboxSource(row: MailboxSourceRow): MailerSourceMailbox {
  let password = "";
  let passwordError: string | undefined;
  try {
    password = decryptSecretOrThrow(
      row.encryptedPassword,
      row.passwordIv,
      row.passwordTag,
      `mailbox "${row.label}"`,
    );
  } catch (err) {
    // One undecryptable row (rotated MAILBOX_ENCRYPTION_KEY, row written by
    // another deployment) must not blank the WHOLE source list — the user
    // still sees their other mailboxes and gets the actionable message
    // decryptSecretOrThrow crafted for exactly this failure.
    passwordError = err instanceof Error ? err.message : String(err);
    password = "";
  }
  return {
    id: row.id,
    label: row.label,
    host: row.host,
    port: row.port,
    username: row.username,
    password,
    ...(passwordError ? { passwordError } : {}),
    fromAddresses: row.fromAddresses,
    secure: row.secure,
    allowInsecure: row.allowInsecure,
    dailyLimit: row.dailyLimit,
    active: row.active,
    sendRegion: row.sendRegion,
    lastTestedAt: row.lastTestedAt,
    lastTestOk: row.lastTestOk,
  };
}

export function buildSendingDomainSource(row: SendingDomainSourceRow): MailerSourceSendingDomain {
  return {
    id: row.id,
    domain: row.domain,
    selector: row.selector,
    publicKeyTxt: row.publicKeyTxt,
    status: row.status,
    installedOnRelay: row.installedOnRelay,
  };
}

export function buildTemplateSource(row: TemplateSourceRow): MailerSourceTemplate {
  return {
    id: row.id,
    name: row.name,
    bodyFormat: row.bodyFormat,
    subject: row.subject,
    bodyHtml: row.bodyHtml,
    subjects: row.subjects,
    bodies: row.bodies,
    createdAt: row.createdAt,
    variants: row.variants.map((v) => ({ subject: v.subject, bodyHtml: v.bodyHtml })),
  };
}

export async function buildMailerSources(
  store: MailerSourcesStore,
  userId: string,
): Promise<MailerSources> {
  const [mailboxRows, domainRows, templateRows] = await Promise.all([
    store.listMailboxes(userId),
    store.listSendingDomains(userId),
    store.listTemplates(userId),
  ]);
  return {
    mailboxes: mailboxRows.map(buildMailboxSource),
    sendingDomains: domainRows.map(buildSendingDomainSource),
    templates: templateRows.map(buildTemplateSource),
  };
}

export interface TemplateSourceRow {
  id: string;
  name: string;
  bodyFormat: string;
  subject: string;
  bodyHtml: string;
  subjects: string[];
  bodies: string[];
  createdAt: Date;
  variants: { subject: string; bodyHtml: string }[];
}

/** The read side of the payload. Implemented by prismaMailerSourcesStore in
 *  production and by fakes in tests — this interface is the whole seam. */
export interface MailerSourcesStore {
  listMailboxes(userId: string): Promise<MailboxSourceRow[]>;
  listSendingDomains(userId: string): Promise<SendingDomainSourceRow[]>;
  listTemplates(userId: string): Promise<TemplateSourceRow[]>;
}
