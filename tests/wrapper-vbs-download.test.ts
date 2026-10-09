// TASK_194 S2 — "Download .vbs" does nothing inside the wrapper EXE.
//
// The mint used the browser-only `URL.createObjectURL` + synthetic `<a
// download>` click. That pattern SILENTLY NO-OPS in WebView2 (the Tauri
// wrapper's webview) — same defect already fixed once as "Task 57 Bug 2" on the
// CSV export. This suite pins the shared Tauri-aware helper and the call site,
// so the browser-only pattern can never quietly come back into the devices UI.

import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");

describe("TASK_194 S2 — the shared download helper", () => {
  it("exists and is client-safe (no server-only guard — it runs in the browser)", () => {
    assert.ok(existsSync(join(ROOT, "lib/download-text.ts")), "lib/download-text.ts must exist");
    const src = read("lib/download-text.ts");
    // Match the IMPORT specifically — the file legitimately *mentions*
    // "server-only" in a comment explaining why it must not import it.
    assert.ok(
      !/(^|\n)\s*import\s+["']server-only["']/.test(src) && !src.includes('from "server-only"'),
      "a server-only import would break a client download helper",
    );
  });

  it("detects the Tauri shell the standard way and branches to the native plugins", () => {
    const src = read("lib/download-text.ts");
    // The bridge object that marks "we are inside the EXE's WebView2".
    assert.ok(src.includes("__TAURI_INTERNALS__"), "must detect Tauri via the runtime bridge object");
    // The ONLY mechanism that can actually save a file in WebView2.
    assert.ok(src.includes("@tauri-apps/plugin-dialog"), "native Save-As dialog is required");
    assert.ok(src.includes("@tauri-apps/plugin-fs"), "fs write is required to complete the save");
    assert.ok(src.includes("downloadTextFile"), "must export the download entry point");
  });

  it("keeps the browser path for the hosted web product (no behaviour change on web)", () => {
    const src = read("lib/download-text.ts");
    assert.ok(src.includes("createObjectURL"), "the browser Blob path must be preserved for the web product");
  });
});

describe("TASK_194 S2 — the devices UI uses it", () => {
  const ui = read("components/device-list.tsx");

  it("routes the .vbs download through the helper", () => {
    assert.ok(ui.includes('downloadTextFile(fileName, content, "text/vbscript", "vbs")'),
      "the .vbs mint must save via downloadTextFile with a .vbs filter");
  });

  it("no longer carries the browser-only blob download that no-ops in the EXE", () => {
    assert.ok(!ui.includes("createObjectURL"),
      "components/device-list.tsx must not download via URL.createObjectURL — it silently no-ops in WebView2");
  });
});
