// Next.js instrumentation hook — runs ONCE when the server process boots,
// before it serves traffic. Used here for the environment health check so a
// deploy that silently lost env keys is visible in `journalctl` immediately
// instead of surfacing as feature-by-feature breakage hours later (owner
// incident 2026-09-24: extractor stuck "queued", private browser unconfigured,
// US/Canada routes missing — all three were just missing env keys).
export async function register(): Promise<void> {
  const { logEnvHealth } = await import("./lib/env-health");
  logEnvHealth();

  // TASK_201 S7 — mailer EXE local runtime only (SPACEWORKER_LOCAL_EXE=true is
  // written exclusively into the Tauri-bundled runtime's .env.local; the hosted
  // web app never sets it, so this branch is dead code there by design). Comes
  // up BEFORE any request is served: embedded PGlite Postgres + schema + the
  // single local user, then the auto-drain loop. The dynamic imports keep
  // PGlite entirely out of the web build's request path.
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.SPACEWORKER_LOCAL_EXE === "true" && process.env.BUILD_TARGET === "mailer") {
    const { initLocalExeDatabase } = await import("./lib/local-exe-db");
    await initLocalExeDatabase();
    const { startLocalExeDrainLoop } = await import("./lib/local-exe-drain");
    startLocalExeDrainLoop();
    console.log("[local-exe] database ready; auto-drain loop started");
  }
}
