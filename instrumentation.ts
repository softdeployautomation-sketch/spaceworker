// Next.js instrumentation hook — runs ONCE when the server process boots,
// before it serves traffic. Used here for the environment health check so a
// deploy that silently lost env keys is visible in `journalctl` immediately
// instead of surfacing as feature-by-feature breakage hours later (owner
// incident 2026-09-24: extractor stuck "queued", private browser unconfigured,
// US/Canada routes missing — all three were just missing env keys).
export async function register(): Promise<void> {
  const { logEnvHealth } = await import("./lib/env-health");
  logEnvHealth();
}
