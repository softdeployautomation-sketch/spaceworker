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
              // 2026-09-25 (live incident): this reads process.env at
              // BUILD time, not per request — headers() is Next.js
              // configuration, resolved once into .next/routes-manifest.json
              // by `next build`. The VPS's own /opt/spaceworker/.env is
              // NEVER consulted for this value at runtime, unlike an
              // ordinary route handler's process.env read — so
              // MESH_FRAME_ORIGINS must be passed as a BUILD-TIME env var
              // (see .github/workflows/deploy.yml's build steps) with the
              // real value, not left to the fallback below. That fallback
              // is only a last-resort default for a build with no env
              // configured at all (e.g. a bare local `next build`) — every
              // CI build until now omitted the env var AND the fallback
              // pointed at a dead host (trmm.mikeolab.com, doesn't resolve),
              // so every real remote-control embed silently failed CSP with
              // no working default either way, until traced live from a
              // "This content is blocked" iframe.
              // 2026-09-25 (same incident, second layer): fixing the CSP
              // allowlist to the REAL meshcentral host (mesh.instaweb.top)
              // only revealed the NEXT failure — mesh.instaweb.top and this
              // app's own spaceworker.top are different registrable domains,
              // so the iframe loaded but MeshCentral's cookie-based session
              // auth was blocked as third-party. Fix: lib/device-tools.ts's
              // fetchMeshUrls() now rewrites every mesh URL's origin to
              // mesh.spaceworker.top (a second nginx vhost added in front of
              // the SAME MeshCentral backend, confirmed live to authenticate
              // identically) before it ever reaches the browser — so this
              // allowlist must match THAT host, not mesh.instaweb.top.
              `frame-src 'self' ${process.env.MESH_FRAME_ORIGINS ?? "https://mesh.spaceworker.top"};`,
          },
        ],
      },
      // 2026-09-25 — every /api/* route is session-scoped, dynamic data; none
      // of it should ever be cached by the browser. Without an explicit
      // no-store, a transient 500/502 hit during a deploy restart can get
      // cached by the browser's own heuristics and then silently replayed on
      // every later "refresh" — no request even reaches the server, so
      // server-side logs show nothing wrong while the user keeps seeing the
      // one bad response forever. Reproduced live: a deploy-window crash on
      // GET /api/devices left one browser showing "Unexpected token '<'"
      // (a stale HTML error page parsed as JSON) on every reload for
      // 45+ minutes after the server had fully recovered; it only cleared in
      // a fresh/incognito context. This is a blanket route-level guarantee,
      // not a per-route opt-in — a route that forgets to set it is exactly
      // the failure mode this closes.
      {
        source: "/api/:path*",
        headers: [{ key: "Cache-Control", value: "no-store, must-revalidate" }],
      },
    ];
  },
};

export default nextConfig;