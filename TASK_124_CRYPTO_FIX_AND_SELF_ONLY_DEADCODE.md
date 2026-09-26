# Task 124 — Browser-clone engine crypto fix (F1/F2) + retire `self_only` if dead

**Status: READY FOR BUILD — assigned to Cline, 2026-09-26 (owner priority pick).**
**Sources: `TASK_117_HOSTED_POOL_PROVISIONING.md` §D1 findings F1/F2 (root-caused with real proof,
2026-09-24/25 — do not re-diagnose, the bug is confirmed); `PIPELINE_CONSOLE_BROWSER_CLONE.md`
BUILD-6/BUILD-7.**

Two small, independent, low-risk fixes bundled into one task because both are "confirmed but off
the critical path" cleanup, not new features. Do them as two separate commits/sections if that's
cleaner to review.

## Part A — F1 + F2: the engine's Linux Chrome cookie/password crypto is wrong

**Read first**: `TASK_117_HOSTED_POOL_PROVISIONING.md` lines ~215–260 (F1, F2) — full proof already
done: real Chromium 151-written cookies were decrypted successfully with the CORRECT salt and
garbage with the current WRONG one; the engine's own PBKDF2 implementation matches Python's
`hashlib.pbkdf2_hmac` byte-for-byte and passes RFC 6070 — only the salt/prefix handling is wrong.

**File**: `michael/browser-clone/engine/pkg/crypto/password_handler.go`.

**F1 — wrong PBKDF2 arguments** (line ~240, `DeriveChromeKey`):
```go
func DeriveChromeKey(password []byte) (*ChromeKey, error) {
	...
	return &ChromeKey{Raw: PBKDF2SHA1([]byte("peanuts"), password, 1, 16)}, nil
}
```
`PBKDF2SHA1`'s real signature (line 122) is `PBKDF2SHA1(password, salt []byte, iter, dkLen int)` —
i.e. **first arg is the password, second is the salt**. Chromium's real Linux derivation is
`PBKDF2-SHA1(password="peanuts", salt="saltysalt", iterations=1, keylen=16)`. The call above passes
`"peanuts"` as the PASSWORD argument (coincidentally correct) but the caller-supplied `password`
parameter ends up in the SALT slot — never the literal `"saltysalt"` Chromium actually uses. Fix:
add a `ChromeLinuxSalt = []byte("saltysalt")` constant (or reuse/fix the existing unused
`ChromeSalt` var at line 180, which is currently declared but never referenced anywhere) and call
`PBKDF2SHA1([]byte("peanuts"), ChromeLinuxSalt, 1, 16)` — the function needs no external password
input at all for this legacy path; simplify its signature if that makes the fix cleaner, but check
first whether anything outside this package expects the current one (a repo-wide grep for
`DeriveChromeKey(` at time of writing found **zero callers** — this path is currently dead code,
which is exactly why the bug went unnoticed; do not assume it stays uncalled forever).

**F2 — the 16-byte Linux cookie prefix is never stripped**: a decrypted Linux cookie plaintext is
`<16-byte host-scoped prefix><value><PKCS7 padding>`, not `<value><PKCS7>` the way the Windows path
is. `DecryptChromeValue` (line 244) returns the whole plaintext including that prefix — proven live:
two different cookies for the same host decrypted to the *identical* 16-byte prefix despite
different names/values, and it does not match `SHA256(host)` or `MD5(host)` (so don't try to derive
it — just strip the fixed 16 bytes). Fix: after `pkcs7Unpad`, when the caller is on the Linux/cookie
path, drop the first 16 bytes of the unpadded plaintext before returning the value. Needs a new
parameter or a sibling function (e.g. `DecryptChromeCookieValue`) rather than silently changing
`DecryptChromeValue`'s existing behavior for password blobs (which do NOT carry this prefix) —
check any other caller of `DecryptChromeValue` before changing its shared behavior.

**Acceptance**: a unit test (Go, matching the existing `crypto_test.go` conventions) that decrypts a
known-good Chromium-written blob (the proof values are already in TASK_117 F1/F2 — reuse them, or
regenerate against a real Chromium instance if those exact bytes aren't in a form you can hardcode)
and asserts the recovered plaintext equals `"CHROMIUM-WROTE-THIS"` with NO leading prefix bytes —
both F1 and F2 fixed together, since F1 alone still leaves the prefix in the output. `go build
./...`, `go vet ./...`, and the full existing test suite stay green.

## Part B — retire `self_only` if it's now provably dead

**Read first**: `components/device-console.tsx` line ~89 comment ("TASK_116: WHY there is no host.
`self_only` is the loop the owner hit on 2026-09-24") and `lib/clone-setup.ts` line ~126's matching
comment, for the ORIGINAL reason this state exists.

**Where it lives**: `lib/clone-hosts.ts:76,153`, `lib/clone-setup.ts:125` (type
`"ok" | "no_host" | "self_only" | "offline"`, computed at line 153), `components/device-console.tsx:89,93,2059`
(same type mirrored, rendered specially at line 2059).

**The question, not yet answered**: `self_only` means "the only eligible hosted-pool destination is
the device you're setting up right now" — a real, reachable state on a ONE-PC account. Since the
hosted destination is now **ours** (TASK_117's whole pivot — a SpaceWorker-run pooled host, not a
customer-provisioned PC), check whether a customer's own device can still ever be selected as a
"hosted pool" destination candidate at all (grep `hostedPool`/`ROLE_ARTIFACTS.hosted`-adjacent
selection logic introduced by TASK_117's D1-D6). If a customer device can **never** be a hosted-pool
candidate anymore, `self_only` cannot occur and this is dead code — delete the reason, the type
narrows to `"ok" | "no_host" | "offline"`, and the special-cased render block at
`device-console.tsx:2059` goes with it. If a customer device CAN still somehow be selected (e.g. a
fallback path), leave it — the task doc's own caution stands: **"that has not been proven"**, so
prove it one way or the other before touching anything, and say which you found either way.

## Rules
- Commit only. Branch `agent/task-124-crypto-and-deadcode`. No deploy, no ssh, no `.env`.
- No heredocs; explicit paths; never `git add -A`.
- `go build ./...` + `go vet ./...` clean for Part A; `npx tsc --noEmit` clean for Part B (if
  anything changes — a "proved still needed, no change" outcome is a valid, complete result).
- Report which of Part A/B you touched, tool output, and (for Part B especially) what you found,
  not just what you changed.
