import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // SpaceWorker runs as a real Node server (holds the Resend key and, later,
  // worker/JWT secrets server-side). Do NOT set output:"export" — that would
  // break server-only code and route handlers. `output: "standalone"` is ONLY
  // set when BUILD_TARGET is present (the EXE build path — CI's build-exe.yml
  // sets BUILD_TARGET=extractor before `next build`; scripts/runtime-assemble.mjs
  // packs the resulting `.next/standalone/` tree as the desktop EXE's bundled
  // runtime, Task 27 Part A). The hosted web deploy never sets BUILD_TARGET, so
  // it gets plain (non-standalone) output — matching what its systemd unit
  // actually runs (`next start`). Next.js itself warns "next start does not
  // work with output: standalone configuration"; this was previously set
  // unconditionally on the (wrong) assumption that standalone output is purely
  // additive/harmless for a `next start` deploy — conditioning it here removes
  // that risk for the hosted app without touching the EXE build at all.
  output: process.env.BUILD_TARGET ? "standalone" : undefined,
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
  // unified Ops Console, which needs framing allowed there (console moved to
  // vantra.spaceworker.top in Task 84). There was previously no frame-ancestors restriction at all (any site
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
            value:
              "frame-ancestors 'self' https://vantra.spaceworker.top; " +
              // Task 95 — Devices v2 remote control: MeshCentral's desktop /
              // terminal / file panes load in iframes on the device console.
              // The exact MeshCentral public origin lives in VPS env (TRMM's
              // meshcentral hostname / MESH_WSS_URL) — set MESH_FRAME_ORIGINS
              // in /opt/spaceworker/.env at deploy (space-separated https://
              // origins). Default keeps the mikeolab.com family allowed.
              `frame-src 'self' ${process.env.MESH_FRAME_ORIGINS ?? "https://trmm.mikeolab.com https://*.mikeolab.com"};`,
          },
        ],
      },
    ];
  },
};

export default nextConfig;