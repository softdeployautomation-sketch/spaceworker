// TASK_201 S13 — open an external URL in whichever shell we're running in.
//
// WHY THIS EXISTS: `<a target="_blank">` is the browser-only way to leave the
// current page for an external site. Inside the desktop EXE (a Tauri window on
// WebView2) it SILENTLY NO-OPS — the user clicks "Get a license on the website
// →" and literally nothing happens, because there is no browser chrome for the
// webview to hand the link to. The ONLY thing that works in the EXE is the
// Tauri opener plugin, which asks the OS to launch the URL in the user's real
// default browser. This module mirrors lib/download-text.ts exactly: detect the
// Tauri shell, use the plugin when present, fall back to the browser pattern on
// the hosted web product. The plugin modules are imported LAZILY so they are
// never evaluated (nor bundled into the web product's critical path) outside the
// EXE.

/** True when running inside the Tauri EXE shell (WebView2), detected the
 *  standard way (the runtime bridge object the plugins speak through). Absent
 *  in a normal browser tab. Mirrors download-text.ts's isTauriShell() exactly. */
export function isTauriShell(): boolean {
  return (
    typeof window !== "undefined" &&
    !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  );
}

/**
 * Open `url` in the user's real browser / default handler.
 *
 * - Tauri EXE   → the opener plugin (the ONLY thing that works in WebView2).
 * - Browser     → `window.open` (unchanged behaviour on the hosted web product).
 *
 * Fail-safe both ways: if the native path throws for any reason we fall back to
 * `window.open`, so the link is never a dead end in either shell.
 */
export async function openExternalUrl(url: string): Promise<void> {
  if (!url) return;
  if (isTauriShell()) {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
      return;
    } catch {
      // Native open faulted — fall through to the browser path.
    }
  }
  if (typeof window !== "undefined") {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
