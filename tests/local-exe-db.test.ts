import test from "node:test";
import assert from "node:assert/strict";

// TASK_201 S7 — proves the mailer EXE's embedded local database works end to
// end on the SAME schema the web app uses: PGlite (embedded WASM Postgres) via
// the pglite-prisma-adapter driver adapter. The critical assertions:
//   1. first boot applies the build-time schema DDL and seeds the ONE local
//      premium user (init idempotent on second boot),
//   2. the schema's Postgres-only String[] columns round-trip through Prisma
//      (this is the whole reason we chose embedded Postgres over SQLite — no
//      column rewrites, no drift from the hosted schema),
//   3. the synthetic local session resolves to that same user.
//
// House require pattern (HOW_WE_MOVE_FAST §4): "server-only" is stubbed.
// Environment (temp data dir + schema path) MUST be set BEFORE the require —
// exeDataDir()/schemaSqlPath() read process.env at call time, but the module's
// identity must be established first.

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Module from "node:module";

type Loader = {
  _load: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown;
};

function installRequireHook(): void {
  const loader = Module as unknown as Loader;
  const original = loader._load;
  loader._load = function patched(request, parent, isMain) {
    if (request === "server-only") return {};
    return original.call(this, request, parent, isMain);
  };
}
installRequireHook();

// Isolated per-run data dir + schema path (generated below from the REAL
// prisma/schema.prisma — exactly what runtime-assemble.mjs ships).
const tmp = mkdtempSync(path.join(tmpdir(), "exe-local-db-"));
process.env.SPACEWORKER_LOCAL_DATA_DIR = tmp;

// Build the DDL the same way the EXE build does (prisma migrate diff), so the
// test cannot pass against a hand-trimmed schema.
const schemaSql = execFileSync(
  process.execPath,
  [
    require.resolve("prisma/build/index.js"),
    "migrate",
    "diff",
    "--from-empty",
    "--to-schema-datamodel",
    path.join(process.cwd(), "prisma", "schema.prisma"),
    "--script",
  ],
  { cwd: process.cwd(), encoding: "utf8", maxBuffer: 128 * 1024 * 1024 },
);
const schemaPath = path.join(tmp, "schema.sql");
writeFileSync(schemaPath, schemaSql, "utf8");
process.env.EXE_DB_SCHEMA_PATH = schemaPath;

/* eslint-disable @typescript-eslint/no-require-imports */
const db = require("../lib/local-exe-db") as typeof import("../lib/local-exe-db");
/* eslint-enable @typescript-eslint/no-require-imports */

test("initLocalExeDatabase applies the real schema, seeds the local premium user, and is idempotent", async () => {
  await db.initLocalExeDatabase();
  const prisma = db.getLocalExePrismaSync();

  const user = await prisma.user.findUnique({ where: { id: db.EXE_LOCAL_USER_ID } });
  assert.ok(user, "local user row exists after first boot");
  assert.equal(user.email, db.EXE_LOCAL_USER_EMAIL);
  assert.equal(user.tier, 5, "standalone licensee is premium — never throttled");
  assert.equal(user.premiumExpiresAt, null, "grandfathered: never expires/reverts");

  // Second boot: marker table present → schema NOT re-applied, no error.
  await db.initLocalExeDatabase();
  const again = await prisma.user.findUnique({ where: { id: db.EXE_LOCAL_USER_ID } });
  assert.equal(again?.id, db.EXE_LOCAL_USER_ID);
});

test("String[] columns round-trip through Prisma on embedded Postgres", async () => {
  const prisma = db.getLocalExePrismaSync();

  const [mailbox, campaign] = await prisma.$transaction([
    prisma.mailbox.create({
      data: {
        userId: db.EXE_LOCAL_USER_ID,
        label: "Local SMTP",
        host: "smtp.example.test",
        port: 587,
        username: "user@example.test",
        encryptedPassword: "enc",
        passwordIv: "iv",
        passwordTag: "tag",
        fromAddresses: ["a@example.test", "b@example.test"],
      },
    }),
    prisma.emailCampaign.create({
      data: {
        userId: db.EXE_LOCAL_USER_ID,
        name: "local replica probe",
        subjects: ["Subject one", "Subject two"],
        bodies: ["<p>Body one</p>", "<p>Body two</p>"],
        mailboxIds: ["mbx_1", "mbx_2"],
      },
    }),
  ]);

  const campaignRead = await prisma.emailCampaign.findUniqueOrThrow({
    where: { id: campaign.id },
  });
  assert.deepEqual(campaignRead.subjects, ["Subject one", "Subject two"]);
  assert.deepEqual(campaignRead.bodies, ["<p>Body one</p>", "<p>Body two</p>"]);
  assert.deepEqual(campaignRead.mailboxIds, ["mbx_1", "mbx_2"]);

  const mailboxRead = await prisma.mailbox.findUniqueOrThrow({ where: { id: mailbox.id } });
  assert.deepEqual(mailboxRead.fromAddresses, ["a@example.test", "b@example.test"]);
  assert.equal(mailboxRead.dailyLimit, 40, "schema defaults survive DDL apply");
});

test("localExeSession resolves to the same local user, no cookie involved", async () => {
  const session = await db.localExeSession();
  assert.equal(session.sub, db.EXE_LOCAL_USER_ID);
  assert.equal(session.email, db.EXE_LOCAL_USER_EMAIL);
  assert.equal(session.emailVerified, true);
  assert.equal(session.scope, "full");
});
