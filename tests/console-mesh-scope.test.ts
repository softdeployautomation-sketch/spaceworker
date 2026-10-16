import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// TASK_207 — source-contract tests for the customer-console leak fix.
//
// Why source-contract and not behavioral: the scope decision happens across
// repos (SpaceWorker → Vantra's /mesh-urls mint) and the mobile launcher is
// pure render output behind a live MeshCentral session. What MUST be locked
// is the contract between them:
//   1. the CUSTOMER path always asks Vantra for scope=device,
//   2. the ADMIN path never does (TASK_147 — intentional operator breadth),
//   3. a scoped-mint failure is loud, never silent,
//   4. mobile opens the scoped URL in a NEW TAB with an embed opt-out.

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

test("customer fetchMeshUrls always requests scope=device", () => {
  const src = read("lib/device-tools.ts");
  // Pin the customer call site: fetchMeshUrls must append the query param.
  const fnStart = src.indexOf("export async function fetchMeshUrls");
  assert.ok(fnStart > -1, "fetchMeshUrls must exist");
  const fnEnd = src.indexOf("\nexport ", fnStart + 10);
  const body = src.slice(fnStart, fnEnd > -1 ? fnEnd : undefined);
  assert.match(
    body,
    /mesh-urls\?scope=device/,
    "fetchMeshUrls must mint a per-device scoped share (the device-tree leak fix)",
  );
});

test("admin adminFetchMeshUrls NEVER sends scope (TASK_147 breadth)", () => {
  const src = read("lib/device-tools.ts");
  const fnStart = src.indexOf("export async function adminFetchMeshUrls");
  assert.ok(fnStart > -1, "adminFetchMeshUrls must exist");
  const fnEnd = src.indexOf("\nexport ", fnStart + 10);
  const body = src.slice(fnStart, fnEnd > -1 ? fnEnd : undefined);
  assert.ok(
    !body.includes("scope=device"),
    "the admin viewer must keep TRMM's broad URLs — operator visibility is intentional (TASK_147)",
  );
});

test("a scoped:false fallback is LOUD in the customer path", () => {
  const src = read("lib/device-tools.ts");
  const fnStart = src.indexOf("export async function fetchMeshUrls");
  const fnEnd = src.indexOf("\nexport ", fnStart + 10);
  const body = src.slice(fnStart, fnEnd > -1 ? fnEnd : undefined);
  assert.match(body, /scoped === false/, "the customer path must detect the unscoped fallback");
  assert.match(body, /console\.error/, "the unscoped fallback must be logged loudly, never silent");
});

test("mobile console opens the scoped viewer in a new tab (noopener)", () => {
  const src = read("components/device-console.tsx");
  assert.match(
    src,
    /window\.open\(mesh\.control, "_blank", "noopener,noreferrer"\)/,
    "the mobile launcher must open mesh.control in a new tab without granting the opener",
  );
  assert.match(
    src,
    /isMobileViewport && !embedInPage/,
    "the launcher must be mobile-only with a per-session embed opt-out (old embed kept, not removed)",
  );
});

test("mobile detection is hydration-safe (useSyncExternalStore, server=false)", () => {
  const src = read("components/device-console.tsx");
  const hook = src.indexOf("function useIsMobileViewport");
  assert.ok(hook > -1, "useIsMobileViewport must exist");
  const end = src.indexOf("\nfunction ", hook + 10);
  const body = src.slice(hook, end > -1 ? end : undefined);
  assert.match(body, /useSyncExternalStore/, "must use the TASK_208 hydration-safe store pattern");
  assert.match(
    body,
    /=> false,/,
    "the server snapshot must be false so SSR renders the desktop embed (no hydration mismatch)",
  );
});
