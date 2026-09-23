# Task 97 — Browser Clone (P2) — hosted-PC act-as-you + Michael MT-1 contract

**Status: MT-1 REVIEWED, FIXED + INTEGRATED (2026-09-23). PR #2 is MERGED into main
(merge `be88e29`) with the two blocking findings fixed on top (`6a9cbcc`): F1
(zero cookies captured — both cookie DB locations are now copied) and F2
(sessionless clone could ship silently — hard guard + `cdp-zero` partial exit).
Mechanics re-verified independently via a Libre CDP harness on macOS (2,373
cookies / 632 domains). NEXT: build the CloneJob pipeline (deliverables below).**
**Plan: `PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md` §PRIORITY (P2), §SCHEMA, §CROSS-TRACK RULES.**

## Read first (mandatory)
- **`HOW_WE_MOVE_FAST.md`** §0–§3 (as TASK_92) — note: hosted clone PCs are dedicated devices (start on the personal-VM/lab host), NEVER the production VPS.
- **`PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md`** §PRIORITY P2 (full directive), §CROSS-TRACK RULES 1/2/5/6 (singular gate; secrets classes; shared primitives; total panic switch).
- **`DESIGN_BROWSER_CLONE_UI_AND_FLOW.md`** — UI placement (5th console tab + Summary card + new-tab session), per-clone record/history, the three launch modes ("same-IP" relay vs direct egress vs wake-then-clone), and the hidden-window findings. Read this before building any UI or launch policy.
- **`browser-server/`** in this repo — the existing headless-Chromium stack to reuse for the hosted runtime.
- Michael's directive in the plan §PRIORITY P2 (topology, relay policy, security boundary).

## Goal
Move a user's browser environment (profiles, sessions, cookies, extensions) from work PC → hosted SpaceWorker PC; agent operates it there; egress stays the user's network identity.

## Deliverables
1. **Migration**: `CloneJob` (userId, sourceDeviceId, destinationDeviceId, relayId, lifecycle, launchState, browserProfileRef) + `RelayHealth` + `HostedBrowserSession`.
2. **Clone flow (all through the ONE gate)**: proposal (kind "browser-clone") → approve (web/Telegram) → CloneJob → source-device agent runs capture (MT-1 scripts) → secure transfer → hosted device agent validates/injects → session active → audit (`AgentActionAudit` with sourceDeviceId/destinationDeviceId/cloneId).
3. **Hosted device provisioning**: hosted PCs register as Devices (Device B in the plan topology); hosted browser runtime = `browser-server` profile per CloneJob; TTL + teardown.
4. **Egress relay enforcement**: relay through the work PC as launch/runtime policy — launch MUST FAIL (never silently fall back) if required relay is down (`RelayHealth` gate).
5. **Panic switch integration**: global kill covers clone jobs + active sessions (extend the Task 92 panic primitive — no isolated revocation path).
6. **UI**: clone section in device detail (start/stop/status); active sessions visible; email-when-off works: (a) IMAP mailboxes via existing plumbing, (b) webmail via hosted clone browser; drafts → gated proposal either way.
7. **Admin limits (CROSS-TRACK RULE 7):** hosted clone PCs are RAM consumers — clone-session concurrency, per-user concurrent clone cap, and hosted-PC pool size are AdminSetting keys in the admin panel (pattern: admission-control's enabled + max + live counts). No hardwired limits.
8. **UI surface (after the first real clone passes):** `Browser clone` tab + Summary card + clone history (date/status/egress/TTL/Open·Revoke) + session view in a new full-screen tab. Exact spec + launch-mode policy in `DESIGN_BROWSER_CLONE_UI_AND_FLOW.md` — do NOT improvise placement.
9. **Egress policy is explicit, never a silent fallback:** relay mode fails closed when the work PC/relay is down (engine `[IP CHECK 2]`); direct egress requires the labeled `--proxy-optional` path; the mode actually used is recorded on the CloneJob and in the audit.

## Michael MT-1 contract (isolated build → owner integrates)
- **Deliverable**: device-side scripts for **browser profile capture/restore** — Chrome, Edge, Firefox. PowerShell (Windows first); runs headless under the Vantra agent; args: `--browser <name> --mode capture|restore --out <path> [--profile <name>]`.
- **Rules**: exit codes 0/1/2 (success/partial/fail); NO plaintext secrets, cookies, or passwords in stdout/logs (paths + counts only); handles locked-profile retry; capture output = encrypted archive (DPAPI on source, AES-256-GCM key provided by the SpaceWorker job env — key never written to disk).
- **Repo**: push to `michael-fork` remote (`github.com/Mikeolab/spaceworker`) branch `michael/browser-clone-scripts`, folder `michael/browser-clone/` + README per `MICHAEL_BRIEF.md` template. Owner merges + wraps into the CloneJob pipeline (this task).

## Acceptance
- VM test: clone Chrome profile from work-PC VM → hosted VM → open webmail session → draft reply → approve via Telegram → sent; relay-down test fails closed with clear audit; panic switch kills active clone instantly; `tsc --noEmit` clean; §2 deploy live-verified.

---

## PR integration (MT-1) — DO THIS FIRST

**PR:** `https://github.com/softdeployautomation-sketch/spaceworker/pull/2` —
branch `michael/browser-clone-scripts`, +9,329/−0, state OPEN.

Owner rule for this repo: **review the PR locally, test it, integrate it —
and only then build the CloneJob pipeline around it.** Do NOT merge blind, and do
NOT start the pipeline before the scripts are proven on the VM.

Review checklist (in this order):
1. **Read `michael/browser-clone/README.md`** (required by
   `MICHAEL_BRIEF.md`) — expected: what each script does, its args, exit codes
   (0/1/2), and the devices/browsers it was tested against.
2. **Contract check against this task's MT-1 section** — args
   `--browser <name> --mode capture|restore --out <path> [--profile <name>]`,
   encrypted archive output, DPAPI on source, key from job env, **no plaintext
   cookies/passwords/session tokens in stdout or any log** (grep the scripts for
   stdout writes of secrets — this is the one hard security gate).
3. `tsc --noEmit` is not enough here (PowerShell) — do a **static parse on the
   VM** (`[System.Management.Automation.Language.Parser]::ParseFile` → prove
   syntax without executing), same gate we used for the overlay scripts.
4. **Functional test on the VM** — capture a Chrome profile, verify the archive
   is encrypted and the key is not on disk, restore it into a second profile
   directory, launch that profile and confirm a logged-in session (e.g. a webmail
   tab) comes up. Firefox and Edge the same way if the scripts claim support.
5. **Failure-path test** — locked profile (browser running) → retry/exit code 2
   path; missing browser → exit 2; bad key → exit 1. Record what actually happens.
6. Then integrate: scripts ship under `michael/browser-clone/` unchanged (they are
   the device-side artifact the CloneJob will call); the pipeline (deliverables
   1–7 above) is ours.
7. `git push` your integration commit; the PR itself is merged only after the VM
   test passes — note the merge + test result in this file.

**Record results here** (date, VM, browsers tested, pass/fail per script, and any
deviation from the MT-1 contract that we accepted):

## Review + VM test results (2026-09-23 — VM 192.168.0.108, Windows PowerShell 5.1.26100.9444)

**Verdict: DO NOT MERGE YET — BLOCKED (F1/F2).** The Go engine is substantial and its
suite passes; the PowerShell contract skin is clean and fails closed. But the clone
**cannot currently deliver the flagship use case** (restore a logged-in session), so the
CloneJob pipeline must not start until F1+F2 are resolved.

### Gates executed (measured, not assumed)

| Gate | Result |
|---|---|
| `michael/browser-clone/README.md` present, contract documented | PASS |
| Contract args / exit codes 0-1-2 / container format | PASS (matches MT-1) |
| **Security gate — no secrets in stdout or logs** | PASS (ps1 + Go greps clean; archive plaintext scan = NONE) |
| Static parse on VM (`Parser::ParseFile`, no execution) | **9/9 PARSE_OK** |
| Self-test with job key (CNG/BCrypt path) | **12/12 PASS** |
| Self-test without key (DPAPI path) | 11 PASS + 1 SKIP (key-only case) |
| Real Chrome capture | exit 0; `SWCLN1`; protection byte 1 (AES-GCM); **job key never on disk** |
| Real restore fidelity | **5/5 SHA256 match** (Preferences, Bookmarks, Login Data, Web Data, History) |
| Failure paths (5 cases) | 5/5 correct — incl. **wrong key → exit 2, fail-closed, NO partial plaintext** |
| Engine build/test | `go build ./...` + `go test ./...` green (stdlib only, 0 deps); Windows cross-compile → 3 binaries |

Exit codes observed: missing browser → 2 · missing archive → 2 · wrong key → 2 ·
no `-In` → 2 · bad key length → 2.

### Findings

**F1 — BLOCKING. The MT-1 PowerShell path captures ZERO cookies.**
Proof: decrypted the archive the PS path produced → 31 entries,
`ZIP_HAS_COOKIES=False`, `ZIP_HAS_NETWORK=False`. Cause: `lib/ProfilePaths.ps1`
searches `Cookies` at the profile root and `Local State` at the profile root, but on
current Chrome the cookie store is `<profile>\Network\Cookies` and `Local State` lives at
the **User Data root** (parent of the profile) — so neither pattern can ever match.
The test profile contains 7 real cookies including **`proton.me`** (the flagship
webmail case); none are captured. A clone therefore restores a browser with no sessions.
Fix is small: add `Network\*` and resolve `Local State` from the User Data root.

**F2 — BLOCKING. Cookie values are machine-bound and nothing re-protects them.**
Proof: every cookie value on the VM begins `v20` (hex `763230`) = Chrome app-bound
encryption; the engine manifest (425 files) contains **no `Local State`**; and
`grep -riE 'v20|app_bound'` across the whole engine returns **zero** hits — there is no
cookie re-protection anywhere (passwords get re-protected; cookies ship raw).
Impact: even on the engine path, a clone restored on another machine cannot decrypt
cookie values → still not logged in.

**F3 — NEEDS CONFIRMATION. Chrome credential decryption is legacy-only.**
`DecryptChromeValue` is AES-**CBC** with a `v10` strip, and `DecodeChromeKey` has no
`app_bound_encrypted_key` case, while modern Chrome uses AES-**GCM** (`v10`) and
app-bound (`v20`). The engine's GCM (`SealGCM`/`OpenGCM`) is its own transport crypto,
not Chrome-value decryption. Decrypt errors are swallowed (`continue`), so this would
fail silently. Not provable on this profile (0 saved passwords) — needs a test with a
real saved password.

**F4 — documentation only.** This task text said "bad key → exit 1"; the implementation
returns **2** (fail). 2 is correct per the 0/1/2 contract (1 = partial). No code change.

**F5 — documentation only.** The README states "Local State is included in captures";
neither path captures it (the engine reads it only to derive the key; the PS path looks
in the wrong directory).

**F6 — engine path is the one to use.** The Go engine walks the profile recursively
(`collectProfileFiles`, depth < 6) and its `skipPath` excludes only images/fonts/tmp/cache —
so it captures `Network/Cookies`, `TransportSecurity`, `Trust Tokens`, `Device Bound
Sessions`, Safe Browsing cookies, and more (manifest: **425 files / 27,408,805 B**,
HMAC-SHA256 signed, `validation=OK:integrity-verified`). Confirms the PS path must not be
the production path.

### Evidence artifacts left in place
- VM: `C:\DepTest\pr2\` (source under test), `C:\DepTest\realcap\`, `C:\DepTest\inspect\`,
  `C:\DepTest\failpath\`, `C:\DepTest\eng\94c56a61-…/manifest.json`, `C:\DepTest\bin\` (engine binaries)
- Local: `/tmp/pr2/`, `/tmp/eng-manifest.json`, `/tmp/vm-cookies.db`
- Reusable gates: `C:\DepTest\parse-gate.ps1`, `run-selftest.ps1`, `real-capture-test.ps1`,
  `failpath-test.ps1`, `capture-inspect.ps1`

**Next action (owner decision):** F1 is a small fix in `lib/ProfilePaths.ps1`
(Michael's deliverable — recommend he patches it, keeping device-side authorship clean);
F2/F3 are design-level and need Michael's call on the cookie re-protection approach
(decrypt-and-reprotect with v20/app-bound support, vs. injecting a fresh key + Local State
into the destination profile and re-encrypting). Pipeline work stays paused until then.

