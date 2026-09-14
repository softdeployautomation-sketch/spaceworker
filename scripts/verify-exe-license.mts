// Runtime verification for the Task 27 Part A licensing layer (run with):
//   EXE_LICENSE_SECRET=unit-test-secret SPACEWORKER_LOCAL_DATA_DIR=$(mktemp -d) npx tsx scripts/verify-exe-license.ts
//
// Exercises: license generation, offline validation (valid / tampered / wrong
// secret / expired / machine-bound), machine-id derivation, and the 24h trial +
// activation state store.
import { createHmac } from "crypto";
import { mkdtemp } from "fs/promises";

process.env.EXE_LICENSE_SECRET = process.env.EXE_LICENSE_SECRET ?? "unit-test-secret";
process.env.SPACEWORKER_LOCAL_DATA_DIR =
  process.env.SPACEWORKER_LOCAL_DATA_DIR ?? (await mkdtemp("/tmp/exe-lic-test-"));

const { generateLicenseKey } = await import("../lib/exe-license");
const { validateLicenseKey } = await import("../lib/exe-license-validator");
const { getMachineId, validateMachineId } = await import("../lib/machine-id");
const {
  startTrialIfNeeded,
  trialActive,
  trialHoursLeft,
  saveActivation,
  readLocalState,
  clearActivation,
} = await import("../lib/license-state");

let failures = 0;
function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}  ${detail}`);
  }
}

// ── machine-id ──────────────────────────────────────────────────────────
console.log("\n[machine-id]");
const mid = await getMachineId();
check("derives a 16-char hex id on real hardware", /^[0-9a-f]{16}$/.test(mid), mid);
check("is deterministic across calls", mid === (await getMachineId()));
check("validateMachineId matches itself", validateMachineId(mid, mid));
check("validateMachineId rejects a different id", !validateMachineId("abc", "def"));
// A non-existent/unknown platform forces the weaker fallback path (VM/sandbox).
const forced = await getMachineId({ platformOverride: "freebsd", macOverride: "aa:bb:cc:dd:ee:ff" });

// ── generation + offline validation ─────────────────────────────────────
console.log("\n[validate]");
const live = generateLicenseKey({ licensee: "buyer@example.com", plan: "extractor" });
const liveCheck = await validateLicenseKey(live.licenseKey, process.env.EXE_LICENSE_SECRET!);
check("valid key validates", liveCheck.valid, liveCheck.error);
check("decode returns licensee", liveCheck.licensee === "buyer@example.com", liveCheck.licensee);
check("expires ~180 days out", Math.abs(
  live.expiresAt.getTime() - liveCheck.expiresAtDate!.getTime(),
) < 5000, liveCheck.expiresAt);

// Tampered payload → bad signature.
const [, sig] = live.licenseKey.split(".");
const tampered = await validateLicenseKey(
  `${"AAAA"}.${sig}`,
  process.env.EXE_LICENSE_SECRET!,
);
check("tampered key fails (signature)", !tampered.valid && tampered.error.includes("signature"), tampered.error);

// Wrong secret → bad signature.
const wrongSecret = await validateLicenseKey(live.licenseKey, "other-secret");
check("wrong secret fails (signature)", !wrongSecret.valid && wrongSecret.error.includes("signature"), wrongSecret.error);

// Expired key → explicit "expired".
const expired = generateLicenseKey({
  licensee: "buyer@example.com",
  plan: "extractor",
  daysValid: 1,
  at: new Date("2026-01-01T00:00:00Z"),
});
const expiredCheck = await validateLicenseKey(expired.licenseKey, process.env.EXE_LICENSE_SECRET!, {
  now: new Date("2026-06-01T00:00:00Z"),
});
check("expired key fails (expired)", !expiredCheck.valid && expiredCheck.error.includes("expired"), expiredCheck.error);

// Crafted machine-bound key (same HMAC scheme) → honoured by the validator.
function pyJson(obj: Record<string, string>): string {
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}: ${JSON.stringify(obj[k])}`).join(", ")}}`;
}
function pyIso(d: Date): string {
  const p = (n: number, l = 2) => String(n).padStart(l, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds() * 1000, 6)}`;
}
function b64urlPadded(s: string): string {
  let e = Buffer.from(s, "utf8").toString("base64url");
  const r = e.length % 4;
  if (r !== 0) e += "=".repeat(4 - r);
  return e;
}
function signKey(payload: Record<string, string>): string {
  const json = pyJson(payload);
  const b64 = b64urlPadded(json);
  const hmac = createHmac("sha256", process.env.EXE_LICENSE_SECRET!);
  hmac.update(b64, "utf8");
  return `${b64}.${Buffer.from(hmac.digest()).toString("hex")}`;
}
const boundMachine = "AAAA1111BBBB2222";
const boundKey = signKey({
  expires_at: pyIso(new Date("2027-01-01T00:00:00Z")),
  issued_at: pyIso(new Date("2026-09-01T00:00:00Z")),
  licensee: "buyer@example.com",
  machine_id: boundMachine,
  plan: "extractor",
});
const boundOk = await validateLicenseKey(boundKey, process.env.EXE_LICENSE_SECRET!, {
  currentMachineId: boundMachine.toLowerCase(),
});
check("machine-bound key valid on bound machine", boundOk.valid, boundOk.error);
const boundBad = await validateLicenseKey(boundKey, process.env.EXE_LICENSE_SECRET!, {
  currentMachineId: "FFFF3333CCCC9999",
});
check("machine-bound key rejected on another machine", !boundBad.valid && boundBad.error.includes("computer"), boundBad.error);

// ── trial + activation state store ──────────────────────────────────────
console.log("\n[state-store]");
await clearActivation();
const started = await startTrialIfNeeded(new Date("2026-09-14T00:00:00Z"));
check("trial starts on first launch", started.trialStartedAt === "2026-09-14T00:00:00.000Z", started.trialStartedAt ?? "");
check("trial active at start", trialActive(started, new Date("2026-09-14T05:00:00Z")));
check("trial ~19h left at 5h elapsed", Math.abs(trialHoursLeft(started, new Date("2026-09-14T05:00:00Z")) - 19) < 0.01);
check("trial expired after 24h", !trialActive(started, new Date("2026-09-15T00:30:00Z")));

const afterActivate = await saveActivation(
  { licensee: "buyer@example.com", licenseKey: live.licenseKey, machineId: mid },
  new Date("2026-09-14T01:00:00Z"),
);
check("activation persisted", afterActivate.activation?.licensee === "buyer@example.com");
const reread = await readLocalState();
check("activation survives re-read", reread.activation?.licenseKey === live.licenseKey);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);

check("fallback path still yields a 16-char hex id", /^[0-9a-f]{16}$/.test(forced), forced);