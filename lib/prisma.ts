import "server-only";
import type { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

// Lazy — importing "@prisma/client" AT ALL throws in the EXE-local runtime
// (Next standalone marks it external and the module fails to load where the
// runtime deliberately ships without DATABASE_URL / the generated client).
// So there is deliberately NO static import here — only `import type`
// (erased at compile time). The real module is require()d inside the getter,
// meaning merely IMPORTING this module — which happens transitively through
// layout.tsx's auth/session chain even on request paths that never call the
// DB — can never crash the EXE. Only an actual query attempt loads the
// client; nothing in EXE-local code should ever reach that point (all EXE
// routes gate on isLocalExeRuntime() and stay DB-free by design).
/* eslint-disable @typescript-eslint/no-require-imports */
function loadClient(): PrismaClient {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PrismaClient } = require("@prisma/client") as typeof import("@prisma/client");
  const c = globalForPrisma.prisma ?? new PrismaClient();
  if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = c;
  return c;
}
/* eslint-enable @typescript-eslint/no-require-imports */
let client: PrismaClient | undefined;
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    if (prop === "then") return undefined;
    if (!client) client = loadClient();
    const value = Reflect.get(client, prop, receiver);
    return typeof value === "function" ? value.bind(client) : value;
  },
});