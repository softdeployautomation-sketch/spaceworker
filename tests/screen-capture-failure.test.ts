import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The capture-service LEAF (browser-capture/) is the one place a raw Playwright
// failure escaped to the owner's screen (DeviceScreenshot 2026-10-01 13:36:40,
// WilkSF9 — "capture_service_http_500: {…locator.click: Timeout 10000ms…}").
//
// Two things are proven here, both against the REAL leaf:
//   1. `connectRefusal` reports a Connect button that stays DISABLED through a
//      click timeout as `offline` — WITHOUT letting the raw Playwright dump
//      escape — and still rethrows a genuine, non-offline click failure.
//   2. The leaf's import graph stays free of `lib/` and `server-only`, because
//      it runs as its own bare-Node process on the VPS where a `server-only`
//      import THROWS at load (browser-capture/capture.ts, header). Importing it
//      at the top of this file already proves it loads under `tsx`; the source
//      assertions below pin the reason.
//
// This is the check the task doc requires to be able to FAIL: if `connectRefusal`
// ever stops guarding, tests 3 (the disabled case) and 4 (the rethrow case) go red.
//
// 2026-10-02 — there is deliberately NO instant `isDisabled()` pre-check, after
// a regression proved it reads the console's LOADING state as offline (the
// button is `disabled={!isOnline}` while `device` is still `null`; capture's
// `visible` wait resolves on SSR'd HTML before hydration). An instant guard
// reported every ONLINE machine offline, so `connectRefusal` now always lets
// the click — which natively waits for enabled — attempt first and only maps a
// timed-out click on a still-disabled button to offline.

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

test("a click that times out on a DISABLED Connect button is reported offline", async () => {
  // The console's button is disabled while the page still loads an online
  // machine (device state starts null), so the click must be ATTEMPTED —
  // Playwright waits for enabled and lands it — and only a timeout on a button
  // that is STILL disabled counts as offline.
  const fake = fakeConnect({ disabled: true, clickThrows: true });

  const outcome = await connectRefusal(fake.button);

  assert.equal(outcome, "offline");
  assert.equal(fake.clicks(), 1, "an instant skip would mistake loading for offline");
  assert.equal(fake.disabledChecks(), 1, "the re-check after the timeout reads isDisabled() once");
});

test("an ENABLED Connect button is clicked without an upfront disabled read", async () => {
  const fake = fakeConnect({ disabled: false });

  assert.equal(await connectRefusal(fake.button), "clicked");
  assert.equal(fake.clicks(), 1);
  assert.equal(
    fake.disabledChecks(),
    0,
    "no instant pre-check: the click itself waits for enabled, because a read before hydration mistakes LOADING for offline",
  );
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
