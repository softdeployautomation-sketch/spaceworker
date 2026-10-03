import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module from "node:module";
import { randomUUID } from "node:crypto";

// TASK_155 P6c (PLAN §19.12) — the Workers/DNS token as a SECOND credential.
//
// The two tokens are stored independently because Cloudflare tokens are SCOPED:
// the Pages token cannot upload a Worker script. That makes two failure modes
// worth pinning down, neither of which a live publish would show clearly:
//   * a token stored in plaintext, or leaking into a view/response
//   * a save that silently WIPES the stored Workers token (a label edit, a
//     Pages-token rotation) — which would break link publishing with no error
// And one that is purely additive: a credential created before P6c (no worker
// token) must keep working exactly as it did.
//
// Driven against the REAL modules with a fake Prisma and the REAL AES-256-GCM
// helpers, so "is it actually encrypted" is answered by decryption rather than
// by pattern-matching a fake.

(process.env as Record<string, string>).NODE_ENV = "test";
process.env.APP_BASE_URL = "https://spaceworker.test";
// credentials.ts -> mailbox-crypto.ts reads MAILBOX_ENCRYPTION_KEY at import
// time; a real 32-byte hex key keeps the real AES-256-GCM path loadable.
process.env.MAILBOX_ENCRYPTION_KEY = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");

type CredRow = {
  id: string;
  userId: string;
  provider: string;
  accountId: string;
  label: string;
  tokenCiphertext: string;
  tokenIv: string;
  tokenTag: string;
  tokenHint: string;
  workerTokenCiphertext: string | null;
  workerTokenIv: string | null;
  workerTokenTag: string | null;
  workerTokenHint: string;
  workerTokenError: string | null;
  isDefault: boolean;
  status: string;
  lastVerifiedAt: Date | null;
  verifyError: string | null;
  createdAt: Date;
  updatedAt: Date;
};

let credRows: CredRow[] = [];
let credSeq = 0;

function matches(row: CredRow, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => (row as unknown as Record<string, unknown>)[k] === v);
}

const fakePrisma = {
  hostingCredential: {
    create: async ({ data }: { data: Partial<CredRow> }) => {
      // Mirrors the real column defaults so a create with no worker token looks
      // exactly like the row Prisma would have inserted for it.
      const row: CredRow = {
        id: "hc_" + ++credSeq,
        userId: "user_1",
        provider: "cloudflare",
        isDefault: false,
        status: "active",
        lastVerifiedAt: null,
        verifyError: null,
        workerTokenCiphertext: null,
        workerTokenIv: null,
        workerTokenTag: null,
        workerTokenHint: "",
        workerTokenError: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        tokenCiphertext: "",
        tokenIv: "",
        tokenTag: "",
        ...data,
      } as CredRow;
      credRows.push(row);
      return row;
    },
    findMany: async ({ where }: { where?: Record<string, unknown> }) =>
      credRows.filter((r) => (where ? matches(r, where) : true)),
    findFirst: async ({ where }: { where?: Record<string, unknown> }) =>
      credRows.filter((r) => (where ? matches(r, where) : true))[0] ?? null,
    findUnique: async ({ where }: { where: { id: string } }) => credRows.find((r) => r.id === where.id) ?? null,
    count: async ({ where }: { where?: Record<string, unknown> }) =>
      credRows.filter((r) => (where ? matches(r, where) : true)).length,
    update: async ({ where, data }: { where: { id: string }; data: Partial<CredRow> }) => {
      const row = credRows.find((r) => r.id === where.id);
      if (!row) throw new Error("not found");
      Object.assign(row, data);
      return row;
    },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<CredRow> }) => {
      const hits = credRows.filter((r) => matches(r, where));
      for (const r of hits) Object.assign(r, data);
      return { count: hits.length };
    },
  },
};

function installRequireHook(): void {
  const loader = Module as unknown as { _load: (r: string, p: NodeModule | undefined, m: boolean) => unknown };
  const original = loader._load;
  loader._load = function patched(request, parent, isMain) {
    if (request === "server-only") return {};
    if ((parent?.filename ?? "").includes("/lib/hosting/") && request === "../prisma") {
      return { prisma: fakePrisma };
    }
    return original.call(this, request, parent, isMain);
  };
}
installRequireHook();

/* eslint-disable @typescript-eslint/no-require-imports */
const creds = require("../lib/hosting/credentials") as typeof import("../lib/hosting/credentials");
/* eslint-enable @typescript-eslint/no-require-imports */

const {
  createHostingCredential,
  updateHostingCredential,
  toHostingCredentialView,
  getDefaultHostingCredential,
  getHostingCredentialById,
  readWorkerToken,
  buildWorkerTokenFields,
  workerTokenHintOf,
} = creds;

beforeEach(() => {
  credRows = [];
  credSeq = 0;
});
after(() => {
  credRows = [];
});

const PAGES_TOKEN = "cf-pages-token-abcdefgh1234";
// Synthetic, never a real credential — a pasted live token must never reach git.
const WORKER_TOKEN = "cfut_FAKE_TOKEN_FOR_TESTS_0000";
const USER_ID = "user_1";

test("P6c: a create with NO worker token is untouched by P6c (purely additive)", async () => {
  const res = await createHostingCredential({
    userId: USER_ID,
    accountId: "acct_1",
    label: "Pages only",
    token: PAGES_TOKEN,
  });
  assert.ok(res.ok, "create should succeed without a worker token");
  const row = credRows[0];
  assert.equal(row.workerTokenCiphertext, null, "no worker ciphertext when none was supplied");
  assert.equal(row.workerTokenHint, "", "hint defaults to empty, not a fake 4-char token");
  assert.equal(res.value.hasWorkerToken, false, "the view says so honestly");
});

test("P6c: the worker token is encrypted at rest and never appears in the view", async () => {
  const res = await createHostingCredential({
    userId: USER_ID,
    accountId: "acct_1",
    label: "Both",
    token: PAGES_TOKEN,
    workerToken: WORKER_TOKEN,
  });
  assert.ok(res.ok);

  const row = credRows[0];
  // At rest: ciphertext only, and it must not BE the token.
  assert.notEqual(row.workerTokenCiphertext, WORKER_TOKEN);
  assert.ok(!row.workerTokenCiphertext?.includes(WORKER_TOKEN), "no plaintext in its own ciphertext");

  // In the view: a 4-char hint and a boolean, never the secret.
  assert.equal(row.workerTokenHint, workerTokenHintOf(WORKER_TOKEN));
  assert.equal(row.workerTokenHint, WORKER_TOKEN.slice(-4));
  const serialised = JSON.stringify(res.value);
  assert.ok(!serialised.includes(WORKER_TOKEN), "the create response must not contain the worker token");
  assert.ok(!("workerTokenCiphertext" in res.value), "the view has no ciphertext field");
  assert.ok(!("workerToken" in res.value), "the view has no plaintext token field");
  assert.equal(res.value.hasWorkerToken, true);
});

test("P6c: both tokens are stored INDEPENDENTLY and decrypt to their own values", async () => {
  await createHostingCredential({
    userId: USER_ID,
    accountId: "acct_1",
    label: "Both",
    token: PAGES_TOKEN,
    workerToken: WORKER_TOKEN,
  });
  const decrypted = await getDefaultHostingCredential(USER_ID);
  assert.ok(decrypted, "the default credential resolves");
  assert.equal(decrypted.token, PAGES_TOKEN, "the Pages token decrypts to itself");
  assert.equal(decrypted.workerToken, WORKER_TOKEN, "the Workers token decrypts to itself");
  // Distinct ciphertexts: proof they are two separate secrets, not one reused.
  assert.notEqual(credRows[0].tokenCiphertext, credRows[0].workerTokenCiphertext);
});

test("P6c: replacing the worker token leaves the Pages token and the label alone", async () => {
  const created = await createHostingCredential({
    userId: USER_ID,
    accountId: "acct_1",
    label: "Both",
    token: PAGES_TOKEN,
    workerToken: WORKER_TOKEN,
  });
  assert.ok(created.ok);

  const rotated = await updateHostingCredential({
    userId: USER_ID,
    id: created.value.id,
    workerToken: "cfut_SECOND_token_0000zzz9999",
  });
  assert.ok(rotated.ok);

  const decrypted = await getHostingCredentialById(USER_ID, created.value.id);
  assert.ok(decrypted);
  assert.equal(decrypted.token, PAGES_TOKEN, "the Pages token must survive a worker-token rotation");
  assert.equal(decrypted.workerToken, "cfut_SECOND_token_0000zzz9999");
  assert.equal(rotated.value.label, "Both", "the label is untouched too");
});

test("P6c: a label-only edit does NOT wipe the stored worker token", async () => {
  // The regression this guards is quiet: `workerToken: undefined` must mean
  // "leave it alone", not "set it to nothing". Wiping it would break link
  // publishing for a user who only wanted to rename an account.
  const created = await createHostingCredential({
    userId: USER_ID,
    accountId: "acct_1",
    label: "Old name",
    token: PAGES_TOKEN,
    workerToken: WORKER_TOKEN,
  });
  assert.ok(created.ok);

  const edited = await updateHostingCredential({
    userId: USER_ID,
    id: created.value.id,
    label: "New name",
    accountId: "acct_2",
  });
  assert.ok(edited.ok);

  const decrypted = await getHostingCredentialById(USER_ID, created.value.id);
  assert.ok(decrypted);
  assert.equal(decrypted.workerToken, WORKER_TOKEN, "the worker token must survive an unrelated edit");
});

test("P6c: re-sending the Pages token does NOT wipe the worker token", async () => {
  const created = await createHostingCredential({
    userId: USER_ID,
    accountId: "acct_1",
    label: "Both",
    token: PAGES_TOKEN,
    workerToken: WORKER_TOKEN,
  });
  assert.ok(created.ok);

  const rotated = await updateHostingCredential({
    userId: USER_ID,
    id: created.value.id,
    token: "cf-pages-token-ROTATED9999",
  });
  assert.ok(rotated.ok);

  const decrypted = await getHostingCredentialById(USER_ID, created.value.id);
  assert.ok(decrypted);
  assert.equal(decrypted.token, "cf-pages-token-ROTATED9999");
  assert.equal(decrypted.workerToken, WORKER_TOKEN, "rotating Pages must not clear Workers");
});

test("P6c: an EMPTY worker token on update is rejected, never stored as blank", async () => {
  // The UI cannot send "" (the button is disabled), but a script can. Storing an
  // empty string would encrypt into a valid-looking ciphertext that can never work.
  const created = await createHostingCredential({
    userId: USER_ID,
    accountId: "acct_1",
    label: "Both",
    token: PAGES_TOKEN,
    workerToken: WORKER_TOKEN,
  });
  assert.ok(created.ok);

  const bad = await updateHostingCredential({
    userId: USER_ID,
    id: created.value.id,
    workerToken: "   ",
  });
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.equal(bad.status, 400);
    assert.equal(bad.code, "invalid_worker_token");
  }
  const decrypted = await getHostingCredentialById(USER_ID, created.value.id);
  assert.equal(decrypted?.workerToken, WORKER_TOKEN, "a rejected save leaves the old token in place");
});

test("P6c: readWorkerToken returns null when absent, and never throws on a corrupt row", () => {
  assert.equal(readWorkerToken({ workerTokenCiphertext: null, workerTokenIv: null, workerTokenTag: null }), null);
  // A row whose ciphertext is unreadable must not take down a link publish.
  assert.equal(
    readWorkerToken({ workerTokenCiphertext: "garbage", workerTokenIv: "garbage", workerTokenTag: "garbage" }),
    null
  );
});

test("P6c: buildWorkerTokenFields returns undefined for a missing token (keep-stored semantics)", () => {
  assert.equal(buildWorkerTokenFields(undefined), undefined);
  assert.equal(buildWorkerTokenFields(""), undefined);
  assert.equal(buildWorkerTokenFields("   "), undefined);
  const fields = buildWorkerTokenFields(WORKER_TOKEN);
  assert.ok(fields);
  assert.equal(fields.workerTokenHint, WORKER_TOKEN.slice(-4));
  assert.equal(fields.workerTokenError, null, "a fresh token starts with a clean slate");
});

test("P6c: the view never serialises a worker token, even for a row that has one", () => {
  const row: CredRow = {
    id: "hc_view",
    userId: USER_ID,
    provider: "cloudflare",
    accountId: "acct_1",
    label: "Both",
    tokenCiphertext: "x",
    tokenIv: "x",
    tokenTag: "x",
    tokenHint: "1234",
    workerTokenCiphertext: "x",
    workerTokenIv: "x",
    workerTokenTag: "x",
    workerTokenHint: "ac94",
    workerTokenError: null,
    isDefault: true,
    status: "active",
    lastVerifiedAt: null,
    verifyError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const view = toHostingCredentialView(row);
  assert.ok(!/ciphertext/i.test(JSON.stringify(view)), "no ciphertext-shaped field may reach a view");
  assert.equal(view.hasWorkerToken, true);
  assert.ok(!("workerTokenIv" in (view as unknown as Record<string, unknown>)));
});

test("P6c: the help names both required permissions, the fallback, and both audiences", () => {
  // A regression guard on the DOCUMENTATION, not just the code: the point of the
  // expandable help is that "Workers Scripts: Edit" — the permission Cloudflare
  // never mentions in an error — is discoverable without a support round-trip.
  const help = readFileSync(new URL("../components/hosting-worker-token-help.tsx", import.meta.url), "utf8");
  assert.ok(help.includes("Workers Scripts"), "the help must name Workers Scripts");
  assert.ok(help.includes("DNS"), "the help must name DNS");
  assert.ok(help.includes("Edit"), "the help must say the access level is Edit");
  assert.ok(/\/r\//.test(help), "the help must explain that links still work without the token");

  // Both surfaces must render it, so an admin and a user read identical steps.
  const admin = readFileSync(new URL("../components/admin/platform-accounts-panel.tsx", import.meta.url), "utf8");
  const settings = readFileSync(new URL("../components/hosting-credentials-settings.tsx", import.meta.url), "utf8");
  assert.ok(admin.includes('<WorkerTokenHelp audience="admin"'), "the admin roster must show the help");
  assert.ok(settings.includes('<WorkerTokenHelp audience="user"'), "user settings must show the help");
  // The secret inputs must be password fields with autocomplete off, so a token
  // isn't echoed on screen or offered back by the browser.
  assert.ok(settings.includes('type="password"') && admin.includes('type="password"'));
  assert.ok(admin.includes('autoComplete="off"'));
});