import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

// TASK_253 — the mailer EXE shipped with HOSTED_APP_URL =
// http://207.244.224.57:3500. That port is not in the box's ufw allowlist, so
// every end-user trial-start timed out ("check your connection"). Pin the rule:
// the public HTTPS origin is the default, the retired/dead bases are refused,
// and an explicit ops override still works.

type ModuleLoad = (this: unknown, request: unknown, ...rest: unknown[]) => unknown;
const moduleWithLoad = Module as unknown as { _load: ModuleLoad };
const originalLoad = moduleWithLoad._load;
moduleWithLoad._load = function (request: unknown, ...rest: unknown[]) {
  if (request === "server-only") return {};
  return originalLoad.call(this, request, ...rest);
};

const RUNTIME_PATH = require.resolve("../lib/exe-runtime.ts");

interface ExeRuntimeModule {
  HOSTED_APP_URL: string;
  DEFAULT_HOSTED_APP_URL: string;
  EXE_ADMIN_REFERRAL_CODE: string;
  resolveHostedAppUrl: (rawValue?: string | null) => string;
  accountHref: (path: string) => string;
}

function loadRuntime(envValue?: string): ExeRuntimeModule {
  if (envValue === undefined) delete process.env.EXE_API_BASE_URL;
  else process.env.EXE_API_BASE_URL = envValue;
  delete require.cache[RUNTIME_PATH];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(RUNTIME_PATH) as ExeRuntimeModule;
}

test("default hosted URL is the public HTTPS origin", () => {
  const mod = loadRuntime();
  assert.equal(mod.DEFAULT_HOSTED_APP_URL, "https://spaceworker.top");
  assert.equal(mod.HOSTED_APP_URL, "https://spaceworker.top");
});

test("retired server and the firewalled :3500 base are refused", () => {
  const dead = [
    "http://164.68.105.96",
    "http://164.68.105.96:3500",
    "https://164.68.105.96",
    "http://207.244.224.57:3500",
    "https://207.244.224.57:3500",
    "http://207.244.224.57:3500/",
  ];
  for (const value of dead) {
    assert.equal(loadRuntime(value).HOSTED_APP_URL, "https://spaceworker.top", value);
  }
});

test("a valid override is honored and trailing slashes are trimmed", () => {
  assert.equal(loadRuntime("https://api.example.test/").HOSTED_APP_URL, "https://api.example.test");
  assert.equal(loadRuntime("https://api.example.test///").HOSTED_APP_URL, "https://api.example.test");
});

test("the pure resolver needs no env mutation", () => {
  const mod = loadRuntime();
  assert.equal(mod.resolveHostedAppUrl("https://api.example.test//"), "https://api.example.test");
  assert.equal(mod.resolveHostedAppUrl("   "), "https://spaceworker.top");
  assert.equal(mod.resolveHostedAppUrl(null), "https://spaceworker.top");
});

test("EXE /signup carries the admin ref; other links do not", () => {
  const mod = loadRuntime();
  process.env.SPACEWORKER_LOCAL_EXE = "true";
  try {
    assert.equal(mod.EXE_ADMIN_REFERRAL_CODE, "TN35EZ2K");
    assert.equal(mod.accountHref("/signup"), "https://spaceworker.top/signup?ref=TN35EZ2K");
    assert.equal(
      mod.accountHref("/signup?x=1"),
      "https://spaceworker.top/signup?x=1&ref=TN35EZ2K",
    );
    assert.equal(mod.accountHref("/signup?ref=OTHER"), "https://spaceworker.top/signup?ref=OTHER");
    assert.equal(mod.accountHref("/login"), "https://spaceworker.top/login");
    assert.equal(mod.accountHref("/pricing"), "https://spaceworker.top/pricing");
  } finally {
    delete process.env.SPACEWORKER_LOCAL_EXE;
  }
});

test("web keeps relative account links and adds no admin ref", () => {
  const mod = loadRuntime();
  delete process.env.SPACEWORKER_LOCAL_EXE;
  assert.equal(mod.accountHref("/signup"), "/signup");
  assert.equal(mod.accountHref("/login"), "/login");
});

test("restore the require hook so later files in this process are unaffected", () => {
  delete process.env.EXE_API_BASE_URL;
  moduleWithLoad._load = originalLoad;
  assert.equal(moduleWithLoad._load, originalLoad);
});
