import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // SpaceWorker runs as a real Node server (holds the Resend key and, later,
  // worker/JWT secrets server-side). Do NOT set output:"export" — that would
  // break server-only code and route handlers. We DO use `output: "standalone"`
  // so `next build` also emits a self-contained `.next/standalone/` server tree
  // that the desktop EXE packs as its bundled local runtime (Task 27 Part A —
  // see scripts/runtime-assemble.mjs); the hosted web deploy runs the same build
  // and is unaffected (standalone is additive, `.next` is still produced).
  output: "standalone",
  // Only native-binding packages need to be externalized (bcrypt, Prisma); do NOT
  // add "server-only"/"jose"/"resend" here — those are pure JS and if externalized
  // the real npm "server-only" resolves to its throwing index.js and breaks builds.
  serverExternalPackages: ["bcrypt", "@prisma/client"],
  // Pin the workspace root explicitly — an unrelated package.json in the parent
  // home directory otherwise confuses Turbopack's root inference, causing bogus
  // "/ROOT/..." module resolution errors that abort the production build.
  turbopack: {
    root: __dirname,
  },
  // 2026-09-14 — SpaceWorker's admin panel is embedded (iframed) inside Vantra's
  // unified Ops Console at vantra.instaweb.top, which needs framing allowed
  // there. There was previously no frame-ancestors restriction at all (any site
  // could iframe this app, a latent clickjacking gap) — this both enables the
  // console embed AND closes that gap by allowing exactly one trusted origin
  // instead of leaving it wide open.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: "frame-ancestors 'self' https://vantra.instaweb.top;",
          },
        ],
      },
    ];
  },
};

export default nextConfig;