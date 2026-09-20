# Task 57 — EXE (Lead Extractor): Stop leaves the run stuck "running", and Export CSV does nothing

**Status: ready to build. Owner-requested 2026-09-20**, found live testing the built extractor EXE on Windows: "when I click stop, it stops the run, but I still see it showing running in the leads, and when I click export csv, it just does nothing. Nothing is exported."

Both bugs are in `app/dashboard/extract/local-extract.tsx` (the EXE's local extraction UI — no server round-trip for the run list itself, everything lives in the page's in-memory `runs` state).

## Bug 1 — Stop doesn't update the run's status (confirmed root cause, precise fix)

`stopSearch()` (line 804):
```ts
function stopSearch() {
  cancelRef.current = true;
  void readerRef.current?.cancel();
}
```
This sets the cancel flag and cancels the stream reader — but **never calls `patchRun()`** to change the run's `status` away from `"running"`. Tracing where the streaming loop actually exits on a manual stop (`startSearch()` around line 759-792, and the identical shape in `startAdvancedSearch()` around line 892-926): the `while (!cancelRef.current)` loop's `if (cancelRef.current) break;` path exits silently with no `patchRun` call, and the `catch` block explicitly guards `if (!cancelRef.current)` before calling `patchRun(runId, { status: "failed" })` — i.e. the code deliberately avoids marking a manual stop as "failed", but never substitutes any other status update. Only `setRunning(false)` runs (in `finally`), which just flips the top toolbar's Search/Stop button back — it has no effect on the per-run status pill in the runs list (`runStatusMeta()`, line 145), which is what's still reading `status: "running"` from the never-patched run record.

The UI already has the right vocabulary for this — `runStatusMeta()` already handles `stoppedReason === "stopped"` → label "stopped" (line 153) — it's just never triggered from the manual-stop path.

**The fix needs one more piece of state**: `stopSearch()` has no way to know *which* run in the `runs` array is the one currently streaming — `cancelRef`/`readerRef` are correctly single global refs (only one run streams at a time), but there's no equivalent `activeRunIdRef`. `runId` is only ever in the local closure scope of `startSearch()`/`startAdvancedSearch()`, out of `stopSearch()`'s reach.

1. Add `const activeRunIdRef = useRef<number | null>(null);` next to `cancelRef`/`readerRef` (line ~307).
2. In both `startSearch()` and `startAdvancedSearch()`, set `activeRunIdRef.current = runId;` right where `readerRef.current = reader;` is set (lines 756 and 889), and clear it (`activeRunIdRef.current = null;`) in each `finally` block alongside `readerRef.current = null;` (lines 800 and 932).
3. In `stopSearch()`, after cancelling, patch the run:
   ```ts
   function stopSearch() {
     cancelRef.current = true;
     void readerRef.current?.cancel();
     if (activeRunIdRef.current !== null) {
       patchRun(activeRunIdRef.current, { status: "done", stoppedReason: "stopped" });
     }
   }
   ```
   `patchRun` (defined line 348) already does a plain `Partial<RunRecord>` merge — this is a direct, minimal change, no new plumbing needed elsewhere.

**Verification**: start a search in the built EXE (or `npm run exe:dev:server` if that's faster to iterate on), click Stop mid-run, confirm the run's pill in the sidebar list immediately shows "stopped" (not "running"), and confirm the leads already collected are still there and exportable. Also test via `startAdvancedSearch()`'s Stop button (same fix, same pattern) — don't fix only one of the two entry points.

## Bug 2 — Export CSV does nothing (diagnosed, needs on-device confirmation before picking the fix)

`exportRun()` (line 427) builds the CSV rows correctly in memory (this part is very unlikely to be the problem — it's plain string building, easy to eyeball-verify against `run.leads`) and hands off to `downloadCsv()` (line 250):
```ts
function downloadCsv(filename: string, rows: string[]): void {
  if (typeof document === "undefined") return;
  const blob = new Blob([rows.join("")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
```
This is the standard **browser** download pattern (Blob → object URL → synthetic `<a download>` click). It works fine in a real browser tab (this is presumably how it behaves correctly on the *web* product — worth a quick sanity check there to confirm this function itself isn't the issue). Inside the **Tauri-bundled EXE's WebView, it's a well-known unreliable pattern** — WebView2 (Windows) does not always wire a blob-URL anchor click through to a native "Save As" dialog / Downloads folder the way a full browser does, and can silently swallow it with no error, no console warning, nothing — which matches "just does nothing" exactly.

Two concrete facts that point the same direction:
- `package.json` has **no** `@tauri-apps/api`, `@tauri-apps/plugin-dialog`, or `@tauri-apps/plugin-fs` — only `@tauri-apps/cli` (a build-time-only dependency). The EXE frontend currently has **zero** wired-up Tauri JS bridge or native file-system/dialog capability.
- `src-tauri/capabilities/default.json` only grants `"core:default"` — no `fs`/`dialog` plugin permissions exist to grant even if the JS packages were added.

**Recommended fix** (the standard, reliable Tauri v2 pattern for "Save As" flows — don't reach for a Rust-side download-event hack instead, it's more moving parts for the same result):
1. Add `@tauri-apps/plugin-dialog` and `@tauri-apps/plugin-fs` to `package.json`, and the matching Rust crates (`tauri-plugin-dialog`, `tauri-plugin-fs`) to `src-tauri/Cargo.toml`, registered in `src-tauri/src/lib.rs` (or wherever the `tauri::Builder` is assembled — find the existing `.plugin(...)` chain, there may already be one for other reasons).
2. Add `"dialog:default"` and `"fs:allow-write-file"` (or the narrower scoped equivalent — check the plugin's own docs for the minimal permission, don't grant broad fs write access) to `src-tauri/capabilities/default.json`'s `permissions` array.
3. Replace `downloadCsv()`'s body with the dialog-save flow: `save()` from `@tauri-apps/plugin-dialog` (with `defaultPath: filename`, `filters: [{ name: "CSV", extensions: ["csv"] }]`) to get a real path from the user, then `writeTextFile(path, rows.join(""))` from `@tauri-apps/plugin-fs`. Keep the existing web-browser code path too (this same component/file may or may not be shared with the hosted web product — check `app/dashboard/extract/page.tsx` and whether a non-EXE build ever renders `LocalExtractPage`; if it's EXE-only, the swap is unconditional, if it's shared, branch on the existing `isLocalExeRuntime()`-style check used elsewhere in this repo).

**Before implementing**: reproduce this live on the actual Windows VM first (`HOW_WE_MOVE_FAST.md` §0/§5 has the SSH access and install cycle) — confirm it really is a total no-op with no OS-level save dialog appearing anywhere (including behind the main window) and no error in the EXE's own console/logs, so the diagnosis above isn't chasing the wrong thing. If it turns out something *does* happen (e.g. a file silently lands in a default Downloads folder with no dialog), the fix is smaller — just surfacing that location to the user rather than adding the dialog/fs plugins at all.

**Verification expected**: run a search (or Load an old one) with leads in it, click Export CSV (and separately, Emails only) from the Actions dropdown, confirm a real save dialog appears, confirm the saved file opens with the correct rows/columns for the run's current `resultMode`, and confirm the Task 54 domain-filter chips still correctly narrow the exported rows when some are selected (that logic in `exportRun()` itself doesn't need to change — only `downloadCsv()`'s delivery mechanism does).
