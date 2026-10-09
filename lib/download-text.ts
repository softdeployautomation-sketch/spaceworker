// TASK_194 S2 — one download helper that works in BOTH shells.
//
// WHY THIS EXISTS: `URL.createObjectURL` + a synthetic `<a download>` click is
// the browser-only download pattern. Inside the devices-wrapper EXE (a Tauri
// window, WebView2) it SILENTLY NO-OPS — the user clicks "Download .vbs" and
// literally nothing happens. That is the same defect already fixed once as
// "Task 57 Bug 2" in app/dashboard/extract/local-extract.tsx (the CSV export);
// this module lifts that proven pattern so the wrapper's VBS download — and
// any future client-generated file — gets it for free instead of re-deriving
// it a third time.
//
// Deliberately NO `server-only` import: this runs in the browser. The Tauri
// plugin modules are imported LAZILY, so they are never evaluated (nor bundled
// into the web product's critical path) outside the EXE.

/** True when running inside the Tauri EXE shell (WebView2), detected the
 *  standard way (the runtime bridge object the plugins speak through). Absent
 *  in a normal browser tab, so the hosted web product always takes the browser
 *  path. Mirrors local-extract.tsx's isTauri() exactly. */
export function isTauriShell(): boolean {
  return (
    typeof window !== "undefined" &&
    !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  );
}

/** Browser (hosted web product) download path — Blob → object URL → synthetic
 *  click. Kept byte-compatible with the pre-Tauri behaviour so the web build is
 *  unchanged by this module. */
function browserDownload(filename: string, contents: string, mime: string): void {
  if (typeof document === "undefined") return;
  const url = URL.createObjectURL(new Blob([contents], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked a tick later so the click can never race the revoke (the original
  // VBS mint used a 1s timeout for this reason — preserved here).
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Save a client-generated text file to disk, in whichever shell we're running.
 *
 * - Tauri EXE → native Save-As dialog + fs write (the ONLY thing that works in
 *   WebView2; the browser pattern silently no-ops there).
 * - Browser   → the unchanged Blob/object-URL click.
 *
 * Fail-safe in BOTH directions: if the native path throws for ANY reason (user
 * dismisses is not a throw, but a plugin fault is) we fall back to the browser
 * download so the user's bytes are never trapped by a broken native path.
 *
 * @param filename  suggested name (and the dialog's default).
 * @param contents  the file's text.
 * @param mime      Blob MIME for the browser path; also the dialog's file-type
 *                  filter is derived from `extension`, not this.
 * @param extension lowercase file extension without the dot (e.g. "vbs").
 */
export async function downloadTextFile(
  filename: string,
  contents: string,
  mime: string,
  extension: string,
): Promise<void> {
  if (isTauriShell()) {
    try {
      const [{ save }, { writeTextFile }] = await Promise.all([
        import("@tauri-apps/plugin-dialog"),
        import("@tauri-apps/plugin-fs"),
      ]);
      const path = await save({
        defaultPath: filename,
        filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
      });
      // null === user cancelled the dialog; that is NOT an error and must not
      // fall through to the browser path (which would pop a second, useless
      // download the user already declined).
      if (path) await writeTextFile(path, contents);
      return;
    } catch {
      // Native save faulted — fall through to the browser path so the file is
      // still delivered if WebView2 happens to honour it.
    }
  }
  browserDownload(filename, contents, mime);
}
