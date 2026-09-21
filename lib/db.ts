import type { PrismaClient } from "@prisma/client";

// Prisma client singleton — avoids exhausting connections in dev (hot reload)
// and guards against duplicate instantiations across route handlers.
//
// Lazy (Proxy + deferred require) — same reason as lib/prisma.ts: importing
// "@prisma/client" AT ALL throws in the EXE-local runtime (Next standalone
// externalizes it and the module fails to load where the runtime deliberately
// ships without DATABASE_URL / the generated client). `import type` is erased
// at compile time; the real require() only runs inside the getter on first
// actual property access. Several EXE-local routes (e.g.
// app/api/exe-license/*) import this module on paths that gate on
// isLocalExeRuntime() and never touch the DB — merely importing must never
// crash them.

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

/* eslint-disable @typescript-eslint/no-require-imports */
function loadClient(): PrismaClient {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PrismaClient } = require("@prisma/client") as typeof import("@prisma/client");
  const c =
    globalForPrisma.prisma ??
    new PrismaClient({
      log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
    });
  if (process.env.NODE_ENV !== "production") {
    globalForPrisma.prisma = c;
  }
  return c;
}
/* eslint-enable @typescript-eslint/no-require-imports */

let client: PrismaClient | undefined;
export const db: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    if (prop === "then") return undefined;
    if (!client) client = loadClient();
    const value = Reflect.get(client, prop, receiver);
    return typeof value === "function" ? value.bind(client) : value;
  },
});