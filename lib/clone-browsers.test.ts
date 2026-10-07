import assert from "node:assert/strict";
import test from "node:test";

import {
  CHROMIUM_BROWSERS,
  CLONE_BROWSERS,
  cloneBrowserCarryRefusal,
  cloneBrowserLabel,
  isCarriableBrowser,
  isCloneBrowser,
} from "./clone-browsers";
import { STATE_SYNC_BROWSERS } from "./clone-state-sync-format";

// The vocabulary the whole clone feature agrees on. These assertions are the ones
// that would have caught the state in which Brave was fully implemented and nobody
// could select it.

test("the clone browser list is exactly what the product supports", () => {
  assert.deepEqual([...CLONE_BROWSERS], ["chrome", "edge", "brave", "firefox"]);
});

test("every carriable browser is a requestable browser", () => {
  for (const browser of CHROMIUM_BROWSERS) {
    assert.ok(isCloneBrowser(browser), `${browser} must be requestable`);
    assert.ok(isCarriableBrowser(browser), `${browser} must be carriable`);
  }
});

test("the state pipe and the clone feature agree on the carriable set", () => {
  // These are two independent literals on purpose (both are platform-side, but the
  // sync list is the vocabulary that crosses the trust boundary to the device), and
  // this is the assertion that keeps them from becoming two different answers.
  assert.deepEqual([...CHROMIUM_BROWSERS], [...STATE_SYNC_BROWSERS]);
});

test("firefox is requestable but carries nothing", () => {
  assert.ok(isCloneBrowser("firefox"));
  assert.equal(isCarriableBrowser("firefox"), false);
  const refusal = cloneBrowserCarryRefusal("firefox");
  assert.ok(refusal, "a non-carriable browser must have a stated reason");
  assert.match(refusal, /firefox/);
  // The way out is named, not implied.
  assert.match(refusal, /fresh session/);
  assert.match(refusal, /Chrome, Edge or Brave/);
});

test("a carriable browser has nothing to explain", () => {
  for (const browser of CHROMIUM_BROWSERS) {
    assert.equal(cloneBrowserCarryRefusal(browser), null);
  }
});

test("an unknown browser is neither requestable nor carriable", () => {
  for (const junk of ["", "chromium", "safari", "Chrome", "chrome ", "vivaldi", "opera"]) {
    assert.equal(isCloneBrowser(junk), false, `${JSON.stringify(junk)} must not be a clone browser`);
    assert.equal(isCarriableBrowser(junk), false, `${JSON.stringify(junk)} must not be carriable`);
  }
});

test("labels exist for every supported browser and pass anything else through", () => {
  for (const browser of CLONE_BROWSERS) {
    const label = cloneBrowserLabel(browser);
    assert.notEqual(label, browser, `${browser} should have a capitalised label`);
    assert.ok(label.length > 0);
  }
  assert.equal(cloneBrowserLabel("chrome"), "Chrome");
  assert.equal(cloneBrowserLabel("brave"), "Brave");
  assert.equal(cloneBrowserLabel("something-else"), "something-else");
});
