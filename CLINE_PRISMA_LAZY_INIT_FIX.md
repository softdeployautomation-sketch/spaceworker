# The actual root cause: `lib/prisma.ts` constructs eagerly, at import time

`lib/prisma.ts` currently:
```ts
export const prisma = globalForPrisma.prisma ?? new PrismaClient();
```
Prisma's generated client throws `PrismaClientInitializationError: environment variable not found: DATABASE_URL` **synchronously, at construction** when that var is missing — which it always is in the EXE's runtime (`runtime-assemble.mjs` only writes `SPACEWORKER_LOCAL_EXE`/`BUILD_TARGET`/`EXE_LICENSE_SECRET`/`NEXT_TELEMETRY_DISABLED`, deliberately no `DATABASE_URL`).

`app/dashboard/layout.tsx` runs server-side on every `/dashboard/*` request, EXE included, and almost certainly imports an auth/session helper that transitively imports this module. ES imports are evaluated eagerly regardless of which runtime branch later executes — so the crash fires the instant that import graph loads, before `isLocalExeRuntime()` ever gets a chance to skip anything. This is the same class of bug as the proxy.ts maintenance-check crash (an unconditional DB touch in a DB-less runtime) — just one layer deeper.

## The fix

Don't chase every file that transitively imports `lib/prisma.ts` (layout.tsx today, something else tomorrow) — fix it once, at the source. Make construction lazy via a `Proxy`, so importing the module never constructs anything; only an actual property access (i.e. an actual query attempt) does:

```ts
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
```

## Verification expected

- `npx tsc --noEmit -p .` clean (Proxy-wrapped `prisma` must still satisfy every existing call site's types — it will, since the Proxy is typed as `PrismaClient`).
- Hosted web app: completely unaffected — first real query still constructs the client exactly as before, same singleton-across-hot-reloads behavior in dev.
- EXE: rebuild (`BUILD_TARGET=extractor npm run exe:build:web`), reinstall on the Windows VM, launch, confirm `/dashboard/extract` renders (no blank white "Internal Server Error").
- Search the rest of the EXE's route/layout import graph for any OTHER top-level eager construction with the same shape (anything doing `new SomeClient()` or similar unconditionally at module scope, not just Prisma) — this bug class isn't unique to Prisma, just the first one found.
