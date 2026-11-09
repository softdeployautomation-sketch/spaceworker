import Module from "module";

// TASK_201 S7c — Turbopack "hashed server externals" resolution shim.
//
// WHY THIS EXISTS (traced live from run 38052488430's artifact, not guessed):
// any package listed in next.config.ts's serverExternalPackages is compiled
// into the server chunks as a HASHED require alias —
//   require("@electric-sql/pglite-7966c14983af6418")
//   require("bcrypt-a3fecf8c027c10c9")
// — and Node must find a real directory of that exact name (the build trace
// files reference `node_modules/bcrypt-a3fecf8c027c10c9`). On the CI Windows
// build those hashed alias directories are NOT materialized into the standalone
// output, so at boot every hashed require throws MODULE_NOT_FOUND — the mailer
// EXE's instrumentation died on PGlite before serving a single request, and
// the same landmine sat under bcrypt/@prisma/client for request-time loads.
// The REAL packages (@electric-sql/pglite, pglite-prisma-adapter, bcrypt,
// @prisma/client) all ship correctly in the standalone node_modules — only the
// alias directories are missing.
//
// THE FIX: the exact technique Next.js itself uses in
// node_modules/next/dist/server/require-hook.js — patch
// Module._resolveFilename so that a request ending in `-[0-9a-f]{16}` which
// fails to resolve is retried with the suffix stripped. Real package names can
// never end in a 16-hex-char segment (npm forbids it in new names), so the
// fallback is collision-free; non-aliased resolution paths are untouched.
// Idempotent; inert on the hosted web app (its resolution never fails on a
// hashed alias, so the fallback never fires there).

const TURBOPACK_ALIAS_SUFFIX = /-[0-9a-f]{16}$/;

type ResolveFilename = (request: string, ...rest: unknown[]) => string;
const mod = Module as unknown as { _resolveFilename: ResolveFilename };

let installed = false;

/**
 * Idempotently install the hashed-external alias fallback on
 * Module._resolveFilename. Call FIRST in instrumentation register() — before
 * any serverExternalPackages module can be required — so every later
 * `require("pkg-<hash>")` (PGlite at boot, bcrypt/@prisma/client at request
 * time) resolves to the real shipped package.
 */
export function installTurbopackExternalAliasShim(): void {
  if (installed) return;
  installed = true;
  const original = mod._resolveFilename;
  mod._resolveFilename = function (request: string, ...rest: unknown[]) {
    try {
      return original.call(this, request, ...rest);
    } catch (err) {
      if (typeof request === "string" && TURBOPACK_ALIAS_SUFFIX.test(request)) {
        const stripped = request.replace(TURBOPACK_ALIAS_SUFFIX, "");
        if (stripped !== request) return original.call(this, stripped, ...rest);
      }
      throw err;
    }
  };
}
