import { PrismaClient } from "@prisma/client";

// Prisma client singleton — avoids exhausting connections in dev (hot reload)
// and guards against duplicate instantiations across route handlers.
//
// Lazy (Proxy) — same reason as lib/prisma.ts: constructing PrismaClient
// eagerly throws immediately when DATABASE_URL is absent, which is always
// true in the EXE-local runtime by design (no DATABASE_URL shipped). Several
// EXE-local routes (e.g. app/api/exe-license/*) import this module on paths
// that gate on isLocalExeRuntime() and never touch the DB — merely importing
// must never crash them. Only an actual query attempt constructs the client.

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

let client: PrismaClient | undefined;
export const db: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    if (!client) {
      client =
        globalForPrisma.prisma ??
        new PrismaClient({
          log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
        });
      if (process.env.NODE_ENV !== "production") {
        globalForPrisma.prisma = client;
      }
    }
    return Reflect.get(client, prop, receiver);
  },
});