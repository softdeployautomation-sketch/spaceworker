import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The capture-service LEAF (browser-capture/) is the one place a raw Playwright
// failure escaped to the owner's screen (DeviceScreenshot 2026-10-01 13:36:40,
// WilkSF9 — "capture_service_http_500: {…locator.click: Timeout 10000ms…}").
//
// Two things are proven here, both against the REAL leaf:
//   1. `connectRefusal` reports the console's DISABLED Connect button as
//      `offline` — WITHOUT ever paying the 10s click timeout that produced the
//      dump — and still rethrows a genuine, non-offline click failure.
//   2. The leaf's import graph stays free of `lib/` and `server-only`, because
//      it runs as its own bare-Node process on the VPS where a `server-only`
//      import THROWS at load (browser-capture/capture.ts, header). Importing it
//      at the top of this file already proves it loads under `tsx`; the source
//      assertions below pin the reason.
//
// This is the check the task doc requires to be able to FAIL: if `connectRefusal`
// ever stops guarding, test 1 (the disabled case) goes red.

import { connectRefusal, captureScreen, type ConnectButton } from "../browser-capture/capture";

/** A stand-in for a Playwright Locator, with call tracking (no browser needed). */
function fakeConnect(opts: {
  disabled?: boolean;
  clickThrows?: boolean;
  disabledAfterClick?: boolean;
}): { button: ConnectButton; clicks: () => number; disabledChecks: () => number } {
  let disabled = opts.disabled ?? false;
  let clicks = 0;
  let checks = 0;
  return {
    clicks: () => clicks,
    disabledChecks: () => checks,
    button: {
      async isDisabled() {
        checks += 1;
        return disabled;
      },
      async click() {
        clicks += 1;
        if (opts.clickThrows) {
          // A real Playwright click timeout carries this shape; the re-check must
          // read the button's post-attempt state.
          if (opts.disabledAfterClick) disabled = true;
          throw new Error("locator.click: Timeout 10000ms exceeded.\nCall log:\n  - element is not enabled");
        }
      },
    },
  };
}

test("a DISABLED Connect button is reported offline WITHOUT burning the click timeout", async () => {
  const fake = fakeConnect({ disabled: true });

  const outcome = await connectRefusal(fake.button);

  assert.equal(outcome, "offline");
  assert.equal(fake.clicks(), 0, "the click that produced the raw dump is never attempted");
  assert.equal(fake.disabledChecks(), 1, "the guard reads isDisabled() exactly once");
});

test("an ENABLED Connect button is clicked normally", async () => {
  const fake = fakeConnect({ disabled: false });

  assert.equal(await connectRefusal(fake.button), "clicked");
  assert.equal(fake.clicks(), 1);
});

test("a click that times out while the button goes disabled is STILL reported offline", async () => {
  // The machine can drop between the pre-check and the click; the re-check saves
  // the raw dump in exactly that race.
  const fake = fakeConnect({ disabled: false, clickThrows: true, disabledAfterClick: true });

  assert.equal(await connectRefusal(fake.button), "offline");
  assert.equal(fake.clicks(), 1);
});

test("a genuine click failure on a still-enabled button is NOT swallowed", async () => {
  const fake = fakeConnect({ disabled: false, clickThrows: true, disabledAfterClick: false });

  await assert.rejects(() => connectRefusal(fake.button), /locator\.click: Timeout/);
});

test("the leaf exposes captureScreen and imports neither lib/ nor server-only", () => {
  assert.equal(typeof captureScreen, "function");

  for (const file of ["capture.ts", "server.ts"] as const) {
    const src = readFileSync(new URL(`../browser-capture/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /\bimport\b[^;]*from\s+["']server-only["']/, `${file} must not import server-only`);
    assert.doesNotMatch(src, /\bfrom\s+["']lib\//, `${file} must not import lib/ (not shipped to the VPS)`);
    assert.doesNotMatch(src, /\bfrom\s+["']@\/lib\//, `${file} must not import @/lib/ (not shipped to the VPS)`);
  }
});
