import "server-only";

// TASK_201 S7 — the mailer EXE's LOCAL DATABASE: the "local server as a
// replicate of the server" (owner directive, 2026-10-10). Standalone tools in
// this space (GMass, any custom-SMTP sender) keep ALL of the user's state on
// the user's own machine and send through the user's own SMTP — nothing links
// back to a vendor backend. Until now the bundled runtime shipped with NO
// database and NO session by design, so campaigns/mailboxes/templates 500'd
// inside the EXE. This module makes the bundled Next server a genuine replica:
//
//   • PostgreSQL semantics INSIDE the EXE via PGlite (embedded WASM Postgres),
//     driven through Prisma's driver-adapter interface — so the schema, the
//     client, and EVERY existing API route stay byte-identical to the web app.
//     No SQLite column rewrites (the schema's String[] columns are
//     Postgres-only), no second data layer, no route branching.
//   • lib/prisma.ts / lib/db.ts route their lazy client here when
//     SPACEWORKER_LOCAL_EXE=true (their Proxy loaders stay sync — see
//     getLocalExePrismaSync — because callers do `prisma.user.findMany` as
//     property chains, which must exist synchronously).
//   • One local "user" per install: the seeded row is tier 5 (Premium,
//     premiumExpiresAt null = grandfathered-permanent per the User.tier
//     comment), so trial/governor daily caps never throttle a standalone
//     licensee. lib/auth.ts's getSession() short-circuits to this user when
//     isLocalExeRuntime() — no cookie, no hosted account, no login.
//
// Data lives in exeDataDir()/mailer-local-db (per-OS app-data dir, never
// Program Files). The schema DDL (db/schema.sql) is generated at BUILD time by
// scripts/runtime-assemble.mjs (`prisma migrate diff --from-empty
// --to-schema-datamodel`) and shipped in the runtime root — first boot applies
// it once; later boots detect the marker table and skip.
//
// Boot order: Next awaits instrumentation.ts's register() BEFORE serving any
// request, and that is where initLocalExeDatabase() is awaited — so by the time
// a route touches prisma, the schema and the local user already exist.

import { mkdirSync, readFileSync } from "fs";
import path from "path";
import type { PGlite } from "@electric-sql/pglite";
import type { PrismaClient } from "@prisma/client";

import { exeDataDir } from "./exe-data-dir";

/** Fixed identity of the one local user — stable across boots and upgrades. */
export const EXE_LOCAL_USER_ID = "exe_local_user";
export const EXE_LOCAL_USER_EMAIL = "local@mailer.exe";

interface ExeDbGlobals {
  exePglite?: PGlite;
  exePrisma?: PrismaClient;
  exeInit?: Promise<void>;
}

const globalScope = globalThis as unknown as { __spaceworkerExeDb?: ExeDbGlobals };
function gg(): ExeDbGlobals {
  return (globalScope.__spaceworkerExeDb ??= {});
}

/** Directory PGlite persists into (created on demand). */
export function localExeDbDir(): string {
  return path.join(exeDataDir(), "mailer-local-db");
}

function schemaSqlPath(): string {
  return (
    process.env.EXE_DB_SCHEMA_PATH || path.resolve(process.cwd(), "db", "schema.sql")
  );
}

/* eslint-disable @typescript-eslint/no-require-imports */
function openInstanceSync(): PGlite {
  const state = gg();
  if (!state.exePglite) {
     
    const { PGlite: Ctor } = require("@electric-sql/pglite") as typeof import("@electric-sql/pglite");
    mkdirSync(localExeDbDir(), { recursive: true });
    state.exePglite = new Ctor(localExeDbDir());
  }
  return state.exePglite;
}

/** Sync client construction — lib/prisma.ts/lib/db.ts's Proxy loaders are sync. */
export function getLocalExePrismaSync(): PrismaClient {
  const state = gg();
  if (!state.exePrisma) {
    // Adapter API (pglite-prisma-adapter 0.6.x): `new PrismaPGlite(pgInstance)`
    // — a SqlMigrationAwareDriverAdapterFactory handed straight to PrismaClient.
    //
    // The `as never` papers over a TYPE-IDENTITY-only mismatch: the adapter's
    // @prisma/driver-adapter-utils copy and @prisma/client's nested copy are
    // different module instances, so TS sees two nominally-different-but-
    // structurally-identical SqlDriverAdapterFactory interfaces. Runtime
    // interface is the documented one (verified by tests/local-exe-db.test.ts).
     
    const { PrismaPGlite } = require("pglite-prisma-adapter") as typeof import("pglite-prisma-adapter");
     
    const { PrismaClient: Client } = require("@prisma/client") as typeof import("@prisma/client");
    state.exePrisma = new Client({ adapter: new PrismaPGlite(openInstanceSync()) as never });
  }
  return state.exePrisma;
}
/* eslint-enable @typescript-eslint/no-require-imports */

let initPromise: Promise<void> | undefined;

/**
 * Idempotent one-time boot: open the embedded Postgres, apply the build-time
 * schema DDL if this is a fresh install, and seed the single local user.
 * Awaited from instrumentation.ts register() before the server accepts
 * traffic; safe (and cheap) to call again afterwards.
 */
export function initLocalExeDatabase(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      const instance = openInstanceSync();
      await instance.waitReady;
      const marker = (await instance.query(`SELECT to_regclass('public."User"') AS t`)) as {
        rows: Array<{ t: string | null }>;
      };
      if (!marker.rows[0]?.t) {
        const ddl = readFileSync(schemaSqlPath(), "utf8");
        await instance.exec(ddl);
      }
      const prisma = getLocalExePrismaSync();
      await prisma.user.upsert({
        where: { id: EXE_LOCAL_USER_ID },
        update: {},
        create: {
          id: EXE_LOCAL_USER_ID,
          email: EXE_LOCAL_USER_EMAIL,
          // Never used: getSession() short-circuits to this user in the local
          // runtime, so no password login path ever verifies against it.
          passwordHash: "local-exe-no-password",
          emailVerified: true,
          // tier 5 = Premium; premiumExpiresAt null = grandfathered, never
          // reverts (see the User.tier comment in prisma/schema.prisma).
          tier: 5,
        },
      });
    })().catch((err) => {
      // Allow a retry on the next call instead of memoizing the failure.
      initPromise = undefined;
      throw err;
    });
  }
  return initPromise;
}

export interface LocalExeSession {
  sub: string;
  email: string;
  emailVerified: boolean;
  scope: "full";
}

/**
 * The session lib/auth.ts resolves to when SPACEWORKER_LOCAL_EXE=true: always
 * the same local premium user. No cookie is read or minted — a standalone
 * install has exactly one user, and there is nothing to sign in TO.
 */
export async function localExeSession(): Promise<LocalExeSession> {
  await initLocalExeDatabase();
  return {
    sub: EXE_LOCAL_USER_ID,
    email: EXE_LOCAL_USER_EMAIL,
    emailVerified: true,
    scope: "full",
  };
}
