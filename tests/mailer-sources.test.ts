import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

// Type-only import so `ms.`-style value access stays from the require() below
// (house pattern) while the row/payload TYPES are available to tsc. Erased at
// compile time — it never loads the module, so the MAILBOX_ENCRYPTION_KEY
// requirement is still met by the require() after env is set.
import type {
  MailboxSourceRow,
  SendingDomainSourceRow,
  TemplateSourceRow,
} from "../lib/mailer-sources";

// TASK_201 S2 — regression guard for lib/mailer-sources.ts, the payload the
// hosted /api/exe-license/mailer-sources route hands to the Mailer EXE.
//
// WHY THIS FILE EXISTS: this payload carries DECRYPTED SMTP passwords — the
// most sensitive bytes the app can emit — assembled from rows that also carry
// the ciphertext triple. The two failure modes worth a permanent test:
//
//   1. LEAK: a `{...row}`-style shortcut (or a select widened without
//      noticing) would ship encryptedPassword/passwordIv/passwordTag — or the
//      DKIM PRIVATE key — to the EXE. The output key sets are asserted
//      EXACTLY, so any extra field fails the build.
//   2. BLANKET: one mailbox whose row can't be decrypted (rotated
//      MAILBOX_ENCRYPTION_KEY) must not blank the whole fetch; the per-row
//      contract is password:"" + passwordError, other mailboxes still ship.
//
// Also pins the query layer's tenancy: every list* is scoped to the ONE userId
// passed to buildMailerSources, templates only come from savedAsTemplate rows,
// and the sending-domain select never asks for the private key.
//
// House require pattern (HOW_WE_MOVE_FAST §4): "server-only" is stubbed, and
// MAILBOX_ENCRYPTION_KEY MUST be set BEFORE the require — lib/mailbox-crypto.ts
// reads it at import time (Buffer.from at module scope), so a missing key there
// is an import-time crash, not an assertion failure.

type Loader = {
  _load: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown;
};

// 32 bytes as hex — aes-256-gcm's key size. Any fixed value: the test only
// ever compares ciphertext produced and consumed under this same key.
const TEST_MAILBOX_KEY = "5f4dcc3b5aa765d61d8327deb882cf990f3a5e2b25b2f4d0aa72e519f2b6d3a1";

function installRequireHook(): void {
  const loader = Module as unknown as Loader;
  const original = loader._load;
  loader._load = function patched(request, parent, isMain) {
    if (request === "server-only") return {};
    return original.call(this, request, parent, isMain);
  };
}

process.env.MAILBOX_ENCRYPTION_KEY = TEST_MAILBOX_KEY;
installRequireHook();

/* eslint-disable @typescript-eslint/no-require-imports */
const ms = require("../lib/mailer-sources") as typeof import("../lib/mailer-sources");
const mc = require("../lib/mailbox-crypto") as typeof import("../lib/mailbox-crypto");
/* eslint-enable @typescript-eslint/no-require-imports */

// ── Fixtures ──────────────────────────────────────────────────────────────────

const USER = "user_tenant_a";

function encryptedTriple(plaintext: string): { encryptedPassword: string; passwordIv: string; passwordTag: string } {
  const e = mc.encryptSecret(plaintext);
  return { encryptedPassword: e.ciphertext, passwordIv: e.iv, passwordTag: e.tag };
}

function mailboxRow(overrides: Partial<MailboxSourceRow> = {}): MailboxSourceRow {
  return {
    id: "mbx_1",
    label: "Work Gmail",
    host: "smtp.gmail.com",
    port: 587,
    username: "me@example.com",
    fromAddresses: ["me@example.com", "hello@example.com"],
    ...encryptedTriple("s3cr3t-smtp-pass"),
    secure: true,
    allowInsecure: false,
    dailyLimit: 40,
    active: true,
    sendRegion: null,
    lastTestedAt: null,
    lastTestOk: null,
    ...overrides,
  };
}

function domainRow(overrides: Partial<SendingDomainSourceRow> = {}): SendingDomainSourceRow {
  return {
    id: "dom_1",
    domain: "example.com",
    selector: "sw",
    publicKeyTxt: "v=DKIM1; k=rsa; p=PUBLIC",
    status: "verified",
    installedOnRelay: true,
    // Deliberately present on the fixture: the row DOES carry the private key
    // material in the real schema, and the output builder must drop it.
    encryptedPrivateKey: "c1ph3r",
    privateKeyIv: "iviviviv",
    privateKeyTag: "tagtagtag",
    ...overrides,
  };
}

function templateRow(overrides: Partial<TemplateSourceRow> = {}): TemplateSourceRow {
  return {
    id: "tpl_1",
    name: "Intro v2",
    bodyFormat: "html",
    subject: "Quick idea",
    bodyHtml: "<p>Hi</p>",
    subjects: ["A", "B"],
    bodies: ["<p>a</p>", "<p>b</p>"],
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    variants: [{ subject: "v1 subj", bodyHtml: "<p>v1</p>" }],
    ...overrides,
  };
}

interface FakeDb {
  db: unknown;
  calls: Record<string, { where?: Record<string, unknown>; select?: Record<string, unknown>; orderBy?: unknown }>;
}

/** Fake Prisma that RECORDS the args each list* sent, so tenancy and the
 *  savedAsTemplate/select contract are asserted on the real query objects. */
function fakeDb(rows: {
  mailboxes?: MailboxSourceRow[];
  domains?: SendingDomainSourceRow[];
  templates?: TemplateSourceRow[];
}): FakeDb {
  const calls: FakeDb["calls"] = {};
  const db = {
    mailbox: {
      findMany: async (args: { where?: Record<string, unknown> }) => {
        calls.mailboxes = args;
        return rows.mailboxes ?? [];
      },
    },
    sendingDomain: {
      findMany: async (args: { where?: Record<string, unknown>; select?: Record<string, unknown> }) => {
        calls.domains = args;
        return rows.domains ?? [];
      },
    },
    emailCampaign: {
      findMany: async (args: { where?: Record<string, unknown> }) => {
        calls.templates = args;
        return rows.templates ?? [];
      },
    },
  };
  return { db, calls };
}

function storeOf(f: FakeDb): ReturnType<typeof ms.prismaMailerSourcesStore> {
  return ms.prismaMailerSourcesStore(f.db as Parameters<typeof ms.prismaMailerSourcesStore>[0]);
}

const ALL_KEYS = (o: object): string[] => Object.keys(o).sort();

// ── Mailbox payload: decrypt right, leak nothing ──────────────────────────────

test("a mailbox's decrypted password round-trips and NO ciphertext field survives", async () => {
  const f = fakeDb({ mailboxes: [mailboxRow()] });
  const out = await ms.buildMailerSources(storeOf(f), USER);

  assert.equal(out.mailboxes.length, 1);
  assert.equal(out.mailboxes[0].password, "s3cr3t-smtp-pass");
  // Exact key set — an accidental `{...row}` that adds ANY field fails here.
  assert.deepEqual(
    ALL_KEYS(out.mailboxes[0]),
    [
      "active", "allowInsecure", "dailyLimit", "fromAddresses", "host", "id",
      "label", "lastTestOk", "lastTestedAt", "password", "port", "secure",
      "sendRegion", "username",
    ],
  );
  const json = JSON.stringify(out.mailboxes[0]);
  assert.ok(!json.includes("encryptedPassword"), "ciphertext field must never serialize");
  assert.ok(!json.includes("c1ph3r"), "nor anything resembling key material");
});

test("one undecryptable mailbox degrades to passwordError — the rest still ship", async () => {
  // Written under a DIFFERENT key: decryptSecretOrThrow fails exactly like a
  // rotated MAILBOX_ENCRYPTION_KEY would in production.
  const broken: MailboxSourceRow = {
    ...mailboxRow({ id: "mbx_bad", label: "Old Relay" }),
    encryptedPassword: "deadbeef",
    passwordIv: "00112233445566778899",
    passwordTag: "00112233445566778899aabbccdd",
  };
  const f = fakeDb({ mailboxes: [broken, mailboxRow()] });
  const out = await ms.buildMailerSources(storeOf(f), USER);

  assert.equal(out.mailboxes.length, 2);
  const bad = out.mailboxes[0];
  assert.equal(bad.password, "");
  assert.match(bad.passwordError ?? "", /MAILBOX_ENCRYPTION_KEY/, "the actionable message must name the real cause");
  // Healthy row is unaffected by its neighbour's failure.
  assert.equal(out.mailboxes[1].password, "s3cr3t-smtp-pass");
  assert.equal(out.mailboxes[1].passwordError, undefined);
});


// ── Sending domains: public material only ─────────────────────────────────────

test("sending domains ship public material only — the DKIM private key never crosses", async () => {
  const f = fakeDb({ domains: [domainRow()] });
  const out = await ms.buildMailerSources(storeOf(f), USER);

  assert.equal(out.sendingDomains.length, 1);
  const d = out.sendingDomains[0];
  // Exact key set: id, domain, selector, publicKeyTxt, status, installedOnRelay.
  assert.deepEqual(ALL_KEYS(d), [
    "domain", "id", "installedOnRelay", "publicKeyTxt", "selector", "status",
  ]);
  const json = JSON.stringify(d);
  assert.ok(!json.includes("c1ph3r"), "encrypted private key must not serialize");
  assert.ok(!json.includes("privateKey"), "nor any privateKey-shaped field");
  assert.equal(d.publicKeyTxt, "v=DKIM1; k=rsa; p=PUBLIC", "public key still ships for DNS display");
});

test("the sending-domain query never even SELECTS the private key columns", async () => {
  const f = fakeDb({ domains: [domainRow()] });
  await ms.buildMailerSources(storeOf(f), USER);
  const select = f.calls.domains?.select ?? {};
  assert.deepEqual(
    Object.keys(select).sort(),
    ["domain", "id", "installedOnRelay", "publicKeyTxt", "selector", "status"],
    "select whitelist is the contract — a widened select is a leak waiting to happen",
  );
});

// ── Templates ─────────────────────────────────────────────────────────────────

test("templates ship legacy fields + ordered variants, nothing campaign-like", async () => {
  const f = fakeDb({ templates: [templateRow()] });
  const out = await ms.buildMailerSources(storeOf(f), USER);

  assert.equal(out.templates.length, 1);
  const t = out.templates[0];
  assert.deepEqual(ALL_KEYS(t), [
    "bodies", "bodyFormat", "bodyHtml", "createdAt", "id", "name", "subject", "subjects", "variants",
  ]);
  assert.equal(t.subject, "Quick idea");
  assert.deepEqual(t.variants, [{ subject: "v1 subj", bodyHtml: "<p>v1</p>" }]);
});

// ── Tenancy + template filter, asserted on the real query args ────────────────

test("every query is scoped to the ONE userId, and templates are savedAsTemplate only", async () => {
  const f = fakeDb({ mailboxes: [mailboxRow()], domains: [domainRow()], templates: [templateRow()] });
  await ms.buildMailerSources(storeOf(f), USER);

  assert.deepEqual(f.calls.mailboxes?.where, { userId: USER });
  assert.deepEqual(f.calls.domains?.where, { userId: USER });
  assert.deepEqual(f.calls.templates?.where, { userId: USER, savedAsTemplate: true });
  // Ordinary (non-template) campaigns must never be reachable through this
  // route: the filter is in the query, so a missing userId in a where clause
  // fails here rather than exposing another tenant's rows in production.
  const passed = f.calls.templates?.where?.userId;
  assert.equal(passed, USER);
});

