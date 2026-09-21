import "server-only";
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

// Lazy — constructing PrismaClient eagerly throws immediately when
// DATABASE_URL is absent (the EXE-local runtime, which never touches the DB
// by design and deliberately ships without this var). Deferring construction
// to first actual property access means merely IMPORTING this module — which
// happens transitively through layout.tsx's auth/session chain even on
// request paths that never call the DB — can never crash the EXE. A real
// query attempt in EXE mode would still throw here, same as before; nothing
// in EXE-local code should ever reach that point (all EXE routes gate on
// isLocalExeRuntime() and stay DB-free by design), so this only removes the
// FALSE crash on mere import, not real DB-touching bugs.
let client: PrismaClient | undefined;
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    if (!client) {
      client = globalForPrisma.prisma ?? new PrismaClient();
      if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = client;
    }
    return Reflect.get(client, prop, receiver);
  },
});