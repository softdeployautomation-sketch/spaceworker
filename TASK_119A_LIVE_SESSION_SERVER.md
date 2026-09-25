# Task 119A (bit B9-A) — PATH A: `sessionMode`, the capture ingest, and CDP injection

**This file is standalone.** It contains everything you need. You do not need to read
`TASK_119B` (that is Cline's extension half) — but you do need the two mandatory reads in *Rules*.
The **only** thing the two paths share is the frozen JSON contract below; it is reproduced
verbatim in both files, so changing it means changing **both files in the same commit**.

**Owner, 2026-09-25 (settled, do not re-litigate):**
- **Q1 — capture ALL sites.** No domain picker anywhere. The user or the agent decides what to
  open *after* the clone is running; the capture is not where we get selective.
- **Q2 — a missing extension offers `fresh`.** The console detects whether a device can do a
  `live` capture: if yes → *"Carry my current session"* (`live`); if no → offer **`fresh`** as the
  real working choice **plus** the existing one-click silent setup, never a dead `live` button that
  fails after Start.

**B8 is DONE and deployed** (`TASK_118`: hosted destination, hosted launch, dial-out relay). This
path extends it; it must not regress it. **`fresh` (route 3) stays the default and byte-for-byte
unchanged.**

---

## Context you need (and a POC that already passed)

Today a clone is `fresh`: a brand-new browser on our side, egressing through the user's device.
The user logs in inside it; nothing is copied from their machine. This path adds an **opt-in
second mode** that starts the clone **already holding the user's real session**.

The delivery mechanism is **proven**, not assumed. POC on the VPS, disposable infra only (nothing
touched `Sc`'s real Chrome or `WilkSF9`):

- CDP capture **in-process** — `export --domain` → `cookies_total=1 cookies_matched=1`, plaintext,
  **no disk read and no decryption** (which is why it dodges the dead routes);
- clone **isolation** — `cookies_total=0` for the target domain *before* injection;
- CDP `Storage.setCookies` injection → `setCookies=1 verified=1 opened=…`;
- the **clone's own browser** then carried the cookie to the server —
  `[server] / hit, cookie present=true match=true` — script-driven, so an agent can observe the
  result, not merely a human.

What the POC did **not** prove — and must not be claimed: capture from a **real Windows Chrome**.
That needs the extension (Path B). Your half starts once a payload arrives.

The two mechanical traps already paid for, and which your CDP module must carry over:
**(a)** Node's HTTP client leaves the upgrade socket **corked**, so writes never reach the wire and
the handshake hangs silently with no event; **(b)** a direct `/devtools/page/<id>` socket
**completes the handshake and answers ping/pong but silently ignores every command** — so use the
**browser** endpoint with `Storage.setCookies` + `Target.createTarget`, and **no attach**
(`Target.attachToTarget` returns `Not allowed`).

---

## THE FROZEN WIRE CONTRACT — do not change it alone

The only coupling between the paths. Path B's native host sends this; you receive it.

```
POST /api/devices/clone-capture
  PUBLIC device-facing route — the DEVICE TOKEN is the credential.
  Mirrors app/api/devices/pin-callback/route.ts. NOT /api/internal/* — see A5a.
  Header: Authorization: Bearer <per-device token>
{
  "cloneJobId": "<id>",
  "deviceId":   "<id>",
  "browser":    "chrome",
  "capturedAt": "<iso8601>",
  "cookies": [ { "name","value","domain","path","secure","httpOnly","sameSite","expirationDate" } ],
  "truncated":  false
}
→ 202 { "ok": true, "accepted": <n> }     // count only, NEVER a value
```

The sender accumulates its own 1 MiB-per-message chunks and makes **one** POST — your route does
**not** assemble chunks. `truncated: true` means the jar is incomplete and must be treated as such.

---

## Your files — exactly these, nothing else

| File | Change |
|---|---|
| `prisma/schema.prisma` + one **hand-written** migration | `CloneJob.sessionMode`; `Device.liveCaptureTokenHash` (A5a); `HostedBrowserSession` capture/session fields (A1/A6) |
| `lib/cdp.ts` | **new** — the dependency-free CDP client, extracted from `scripts/clone-cdp.mjs` |
| `lib/clone-live-capture.ts` | **new** — ingest validation, short TTL, injection orchestration |
| `app/api/devices/clone-capture/route.ts` | **new** — the device-facing public route for the contract above (the device token IS the credential; A5/A5a) |
| `app/api/devices/[deviceId]/clones/route.ts` | accept + validate `sessionMode` |
| `lib/clone.ts` | `sessionMode` in `requestClone`; fail-closed on an empty live capture |
| `lib/clone-hosted-launch.ts` | expose the session's CDP endpoint; inject after the container is up |
| `lib/clone-setup.ts` | the `live`-capability read model (Q2 detection) |
| `browser-server/server.ts` | per-session CDP endpoint, **host-loopback only**, + forwarder wiring |
| `components/device-console.tsx` | the mode selector + the detection copy |
| `michael/browser-clone/engine/cmd/swfwd/main.go` | **new** — the static loopback forwarder |
| `scripts/engine-dist.mjs` + `engine-dist/**` | regenerate so the forwarder ships in the signed bundle |
| `scripts/clone-cdp.mjs` | re-pointed at `lib/cdp.ts`'s logic (keep the CLI working) |

Stay inside this list. If you must leave it, **stop and ask** — in particular do **not** touch the
extension or `cmd/native-host` (those are Path B's, and a concurrent agent may be in them).


---

## The bits

**A1 — `sessionMode` on the job.** `CloneJob.sessionMode` (`"fresh" | "live"`, **default
`"fresh"`**), hand-written migration mirroring the existing style. Additive and defaulted, so every
existing row and caller keeps today's behaviour. `fresh` stays the default **everywhere**.

**A2 — API + validation.** Accept `sessionMode` in `POST /api/devices/[deviceId]/clones`; validate
against the literal set → `400` on anything else, in the same shape as the existing
`egress`/`browser` validation. A `live` request on a device that cannot capture must be refused
**before** a job is created (see A7), with a nameable reason — not accepted and then failed.

**A3 — the CDP module (`lib/cdp.ts`).** Move the proven client out of `scripts/clone-cdp.mjs` so the
script and the server share **one** implementation. **Dependency-free** (node built-ins only; `ws`
is deliberately not a repo dependency). Carry over both traps from *Context* above, the
per-request timeout, and the existing exit-code semantics. `scripts/clone-cdp.mjs` must keep
working (probe / inject / export) after the move — re-point it rather than duplicating logic.

**A4 — the per-session CDP endpoint (host-loopback ONLY).** CDP binds **container-loopback**, and
recent Chromium ignores `--remote-debugging-address=0.0.0.0` for external reach, so a forwarder is
required: build `cmd/swfwd` (the static forwarder TASK_117 D3 scoped), mount it into the session
container, start it via supervisord, and publish with
`-p 127.0.0.1:<allocated>:<forwarder port>`. **The published port MUST be host-loopback** — this
endpoint grants full control of the browser and must never be publicly reachable. `browser-server`
runs on the host, so host-loopback is directly dialable by it. Stamp the port on
`HostedBrowserSession.cdpPort` (the column already exists, unfilled since B8-2).

**A5 — ingest (`lib/clone-live-capture.ts` + the route).** The route is **device-facing and
public** (`app/api/devices/clone-capture/route.ts`), mirroring `app/api/devices/pin-callback/route.ts`:
**the device token IS the credential.** Enforce, in this order:
1. **body size cap FIRST** (reject an oversized body before parsing it) — this is a public route;
2. `Authorization: Bearer <token>` → `sha256Hex(token)` → **unique lookup** on
   `Device.liveCaptureTokenHash`. An unknown token returns the **same neutral response** as a
   job/token mismatch — no oracle telling an attacker which half was wrong;
3. the `cloneJobId` belongs to **that device's user**, and the job is **in a state that expects a
   capture** → otherwise neutral `404`/`409`, **never a write**;
4. payload validation (shape, caps, sanity) → `400` naming the field;
5. per-device rate limit on the route.
6. **No value is ever logged, echoed, audited or persisted beyond its short TTL.** The audit row
   takes **integers**: `cookieCount`, `domainCount`, `truncated`. CROSS-TRACK RULE 5, enforced
   structurally, not by discipline.

**A5a — the per-device credential (owner amendment, 2026-09-25 — folds the fleet-secret risk).**
The first draft of this route used the fleet-wide internal bearer. That is wrong for a
device-facing route and is now **forbidden**: one leaked customer device could then forge another
customer's capture, and it would mean placing the **server-to-server** secret on a machine we do
not control. Concretely:

- **No `requireInternalBearer` on this route.** `INTERNAL_BEARER_TOKEN` / `VANTRA_INTERNAL_TOKEN`
  must **never** exist on a device. Do not add this route to the internal-bearer set.
- **Mint per device.** ⚠️ *Corrected 2026-09-25 after review:* the first draft of this bit named a
  `generateToken()` in `lib/clone-transport.ts` — **no such function exists** (see V1 below; that was
  the owner's error, not the agent's). What exists is `mintCloneJobKey()` (line 115,
  `crypto.randomBytes(32).toString("base64")`) — but that is the AES-256-GCM **job key**, documented
  as *never persisted*, so it must not be reused for a value we deliberately store as a hash. Mint
  with the same primitive shape, directly (`crypto.randomBytes(32).toString("base64")`, node
  built-in) or via a small `mintDeviceToken()` beside it. Hash with the existing **`sha256Hex()`**
  (line 119) — the same function `runRelayInstall` already uses for the relay token's hash. Do
  **not** invent a second token or hashing *scheme*.
- **Store the SHA-256 only**: new unique column `Device.liveCaptureTokenHash`, written with
  `sha256Hex()`. The raw token is never persisted, never logged, never in audit detail — the same
  documented contract `RelayHealth.tokenHash` already carries ("only its SHA-256 is stored").
- **Deliver it at setup over the existing one-click channel** — the exact seam the relay token
  already uses: `runRelayInstall` (`lib/clone-transport.ts:699`) accepts a caller-supplied token,
  stores **only** `sha256Hex(token)` on the `RelayHealth` row (line 767) and forwards the **raw**
  token to the installer as a **parameter** — it lands in the on-device config only, never in our DB,
  logs, or audit detail. Mirror that exactly: write `Device.liveCaptureTokenHash`, hand the raw token
  to the source-role install so it writes `live-capture.json` (`0600`), and **never** ask the user to
  copy or paste a secret.
- **Rotate / revoke**: writing a new hash rotates; clearing the hash immediately revokes that
  device's ability to post, and device teardown/cleanup must clear it.
- Documented as a *deliberate* trade-off: this is a long-lived per-device token, which is
  proportionate for a single-tenant rollout. The tighter future step — a **per-job** token minted
  at Start and handed to the device through the agent channel — is recorded as a follow-up, not
  silently skipped.

**A5b — the sender side (Path B's contract obligation).** The native host reads the token from its
installed config (`0600`, written by the one-click setup), sends it on every POST, and **never**
puts it in the payload, in the extension, in a log, or in an error message.

Hold the payload only long enough to inject it (memory or a `0600` file), and delete it on inject,
on failure, and on job teardown. **A live capture is a credential.**

**A6 — injection + fail-closed launch.** For a `live` job with a hosted destination: create the
profile dir (per job, unchanged) → start the session → wait for the CDP endpoint →
`Storage.setCookies` → verify → record `cookieCount`/`domainCount` and `sessionMode`.
**If the capture yields 0 cookies, or injection cannot be verified, the launch REFUSES with a named
reason** — **never** a silent fallback to `fresh`. A user who asked to carry their session and
silently got an empty browser will conclude the product is broken and will not know why. Keep B8's
existing fail-closed relay behaviour exactly as it is.

**A7 — detection (Q2), single source of truth.** ⚠️ *Sharpened 2026-09-25 after review (see V2):*
the canonical set is `CLONE_CAPABILITIES = ["clone-capture", "clone-host", "relay"]`
(`lib/clone-transport.ts:104`), and **`clone-capture` is already recorded** for the source role
(`lib/clone-setup.ts:638`; the source readiness test at line 661 is literally
`capabilities.includes("clone-capture")`). **Do not invent a fourth string.** Either reuse
`clone-capture`, or add the new value to `CLONE_CAPABILITIES` **and** record it in that same setup
block — a capability that is read but never written is a feature that never appears, and a string
outside the typed set is invisible to `tsc` (`DeviceCapability.capability` is a `String` column, not
`CloneCapability`). The capability must be recorded when the extension + native host are present (the
native-host registration path already exists: `install-registry.ps1` writes it for Chrome/Edge/Brave
under HKLM, silently, with no user interaction). Expose it on the setup read model
(`lib/clone-setup.ts`) — the **same one place** pattern TASK_116 established, so the card and the
gate can never disagree — and surface it in the console:

- capable → offer `live`;
- not capable → offer **`fresh`** and the existing one-click setup, **and state the honest caveat
  before the user enables it**: deploying the extension uses Chrome's `ExtensionInstallForcelist`
  policy, which makes Chrome show **"Managed by your organization"**. That is a real, visible
  change on the user's browser; do not hide it.

**A8 — audit.** `sessionMode` and the counts on the job/audit rows. **No step may report a mode it
did not use** (the existing TASK_97 rule).


---

## Rules (the pipeline's STANDARD AGENT CONTRACT — read it in the tracker)

> **COMMIT ONLY. DO NOT DEPLOY.**
> - Branch: **`agent/task-119a-live-session`**.
> - `npx tsc --noEmit` clean. `gofmt -l` / `go vet` clean and `go build ./...` green for the Go
>   parts (`cd michael/browser-clone/engine`).
> - **Never** edit, create or rsync `.env`; never ssh the VPS; never run `npm run build` or
>   `prisma migrate deploy` on the server. **Hand-write** the migration SQL (never `migrate dev`) —
>   mirror the existing migrations.
> - **Never** write JSX/TS/Go through a shell heredoc — use the file editor, then verify
>   (`HOW_WE_MOVE_FAST.md` §6).
> - Stay inside the file list. If you must go outside it, **stop and ask**.
> - Regenerate the engine bundle with `node scripts/engine-dist.mjs` **after** adding `cmd/swfwd`,
>   so the forwarded binary is inside the signed manifest (a binary that isn't in the manifest will
>   be refused by the downloader's hash check).

**Mandatory reads:** `HOW_WE_MOVE_FAST.md` (§0–§3 deploy discipline, §6 gotchas),
`PIPELINE_CONSOLE_BROWSER_CLONE.md` (the bits table + the standard agent contract + the B8 rows),
`TASK_118_CLONE_HOSTED_DESTINATION_AND_LAUNCH.md` (what you are extending),
`TASK_117_HOSTED_POOL_PROVISIONING.md` findings **F4/F6/F10/F11/F12** (why the mechanism is what it
is — do not re-derive them), and `DESIGN_BROWSER_CLONE_UI_AND_FLOW.md` for the console copy.

**Safety guardrails, non-negotiable:**
- **A real customer device (`WilkSF9`) is never a test target** — not for a clone, a capture, a
  probe or a fallback.
- Never capture or carry the **owner's real signed-in accounts** in a test; use a disposable login.
- Any file or row holding a captured payload is `0600` / short-TTL and deleted after use.

---

## Acceptance

1. **`fresh` is unchanged** — same behaviour, same records, same egress proof, still the default.
2. `live` end to end on a disposable login: capture → ingest (`202`, counts) → clone opens **already
   signed in** → the session's `egressIp` is the **device's** IP, not ours.
3. `live` with **0** cookies → **refusal with a named reason**, **no clone created**.
4. The capture route: no/invalid device token → `401`; **the same neutral response** for an unknown
   token and for a valid token naming a job that isn't that device's → no oracle; malformed payload
   → `400` naming the field; a valid post → `202` with a **count only**. **An oversized body is
   rejected before it is parsed.** Clearing `Device.liveCaptureTokenHash` **revokes** that device
   (its next post is `401`). The token — raw or hashed — appears **nowhere** in any log or audit row.
5. **No cookie value** appears in any log, audit row, error message or API response — counts and
   domains only.
6. `HostedBrowserSession.cdpPort` is stamped for a live session, and the published CDP port is
   **host-loopback** (`ss -lntp` shows `127.0.0.1:<port>`, never `0.0.0.0`).
7. Isolation: the clone's profile path differs from the private-browser profile path **and** from
   any other clone job's; the clone starts with 0 cookies for the target domain before injection.
8. `scripts/clone-cdp.mjs probe|inject|export` still work after the `lib/cdp.ts` extraction.
9. Never `WilkSF9`; the VM is left clean.

## Rollback

Additive and defaulted: a new column defaulting to `"fresh"`, a new route, a new CDP helper, an
opt-in mode. Reverting = hiding the mode in the UI; every existing `fresh` job and every existing
caller behaves exactly as it does today.

## Report back with

1. Files changed (exactly the list above), and `tsc` / `gofmt` / `go vet` / `go build` results.
2. The migration SQL.
3. Live-ish evidence you could produce **without** deploying: route unit behaviour, the CDP module
   against a local container, the forwarder's loopback binding.
4. Anything you could **not** verify locally, stated plainly.
5. Confirmation that the frozen contract was **not** modified (if it was, stop and flag it).

---

## Path A — verification findings (owner review, 2026-09-25)

The four Path A commits (`e841a78`, `46f7cb6`, `47a88fd`, `10d2b73`) were reviewed against this file,
and `npx tsc --noEmit` was reproduced independently (clean). **The route and the schema are right —
but verification is not completion.** The following must be fixed before this is called done; V1–V4
mean the live path cannot run end to end today.

**V1 (blocking) — nothing mints or delivers the device token, so the live path cannot run.**
`liveCaptureTokenHash` is *read* by the route and declared in the schema, but **no application code
ever writes it**, and nothing writes `live-capture.json` on the device. A real device therefore
posts unauthenticated → `401` → launch refuses. A5a's mint **and** deliver half is unbuilt. The seam
to mirror is `runRelayInstall` (`lib/clone-transport.ts:699`): it takes a caller-supplied token,
stores **only** `sha256Hex(token)` on the `RelayHealth` row (line 767), and forwards the raw token to
the installer as a **parameter** (never in our DB, logs, or audit detail). Do it in the same setup
block (`lib/clone-setup.ts:620-638`) that already calls `runRelayInstall` and records capabilities.

**V2 (blocking) — detection reads a capability that nothing records.**
`canCaptureLiveSession()` (`lib/clone-setup.ts:437`) queries `capability: "live-capture"`. That
string is **not** in the canonical set (`lib/clone-transport.ts:104`) and **nothing ever writes it**,
so the query returns `false` forever and the Q2 offer never appears. Note `clone-capture` **is**
already recorded for the source role (`lib/clone-setup.ts:638`) and is already the source readiness
test (line 661). Either reuse `clone-capture`, or add the new value to `CLONE_CAPABILITIES` **and**
record it in that block. `tsc` cannot catch this: `DeviceCapability.capability` is a `String` column,
not `CloneCapability`.

**V3 (blocking) — the state machine and the audit row are bypassed.**
`app/api/devices/clone-capture/route.ts:160` does a **raw** `db.cloneJob.update({ status: "captured" })`.
`captured` is not a legal edge from either accepted state: `PIPELINE_NEXT` (`lib/clone.ts:111`) allows
`requested → [awaiting_source, ready]`, `awaiting_source → [capturing]`, `capturing → [captured]` — so
the legal path is `awaiting_source → capturing → captured`. Every other lifecycle write in the
codebase goes through `transitionClone` (`lib/clone.ts:229`), which calls `assertCloneTransition`
**and writes the audit row**; a raw update skips both, so an illegal status is written with no audit
trail. Route it through the state machine (deciding the `live`-hosted edge inside the machine, the way
B8-2 decided `requested → ready` for a hosted destination) rather than writing status directly.

**V4 (blocking) — injection fails OPEN, which is the exact thing A6 forbids.**
`lib/clone-hosted-launch.ts:168` is `if (job?.sessionMode === "live" && cdpPort)`. `cdpPort` comes from
`startedData?.cdpPort` (line 136) and is optional; if it is missing — or the job lookup returns `null` —
injection is **skipped silently** and the function returns `ok: true` with a `viewUrl`. The user asked
to carry their session and silently gets an empty browser: precisely what lines 174-177 forbid
("**never** a silent fallback to `fresh`"). Both branches must **refuse with a named reason**
(e.g. `session_injection_unavailable: no_cdp_port`, `clone_job_not_found`) and tear the session down,
exactly as the existing injection-failure branch already does.

**V9 (blocking — the deepest one) — the live state model was never designed into the machine;
`stepRequested` still skips capture for *every* hosted destination.**
`lib/clone.ts:858` sends **any** hosted destination straight to `ready`
(`transitionClone(job, "ready", …)` with `skipped: "capture_transfer_inject (hosted destination,
route 3 — nothing to copy)"`) — **unconditionally**, with no `sessionMode` check. But A6's live
scenario *is* "a `live` job with a hosted destination", so:
- the job sits in **`ready`**, and the capture route does **not** accept `ready`
  (`acceptedStates = ["requested", "awaiting_source"]`) → every legitimate capture is rejected `401`;
- and nothing ever **waits** for the capture: `ready → stepLaunch` fires immediately → calls
  `launchHostedClone` → `injectLiveCapture` → `capture_not_found` → refusal.

So even with V1 fixed (a token minted and delivered), the live path can neither ingest nor launch.
Route 3's comment — "the hosted browser logs in for itself, nothing to copy" — **is** the `fresh`
assumption that live mode exists to replace. This needs a **state-machine decision in
`lib/clone.ts`**, not a patch inside the route: e.g. hosted + `live` → `awaiting_source` (wait for
the cookie capture) → `captured` → `ready`, with the launch gate refusing to launch a `live` job in
`ready` before its capture has landed. Decide it once, in the machine (as B8-2 decided the hosted
`requested → ready` edge), and record it here.

**V5 (security) — the A5 body cap is bypassable.**
`route.ts:35` caps only on the `content-length` **header**. A chunked request omits it, so the cap is
skipped and the body is then fully buffered by `await request.json()` — on a **public** route. Count
bytes instead: read the body as text/stream and reject over `BODY_SIZE_CAP` **before** parsing.

**V6 (review) — an arbitrary error object is logged, and error text is echoed back.**
`route.ts:176` `console.error("[clone-capture]", err)` runs in a scope where `rawToken` (line 63) and
the raw cookie payload are live — and A5's rule is structural, not "unlikely to leak". Separately,
`injectLiveCapture` returns `injection_error: ${err.message}` (`lib/clone-live-capture.ts:108`), which
`lib/clone-hosted-launch.ts:181` interpolates into the launch error. A CDP error can echo the command
params it was given — i.e. cookie **values** — so the route needs a fixed log line (code + error
`name` only) and the injection failure a **fixed named reason** with no interpolated message.

**V7 (cosmetic, but it is the contract) — a wrong clause is cited.**
`lib/clone-live-capture.ts:53` attributes the fail-closed rule to "A5b". **A5b is the sender-side rule**
(line 164); fail-closed injection is **A6** (line 171). Fix the citation so the next agent is not sent
to the wrong paragraph.

**V8 (deployment constraint) — the payload store is per-process.** `payloadStore` is an in-process
`Map` (`lib/clone-live-capture.ts:23`), so the capture POST and the hosted launch must land in the
**same** Node process or injection gets `capture_not_found` and the launch refuses. That fails closed
(good), but on a multi-instance/serverless deployment it is a functional break. B8's docker container
is single-process, so this is acceptable today — record the constraint, or move the TTL store to a
table. Minor: `clearCapture` does not clear the `setTimeout` handle.

**Verified correct — do not re-litigate.** The migration's **partial** unique index
(`... WHERE "liveCaptureTokenHash" IS NOT NULL`) and Prisma's expected index name; **no**
`requireInternalBearer` / internal-bearer reference anywhere on the route; a single neutral `401` for
*every* failure mode (genuinely no oracle, including device/job mismatch); the request body is
camelCase and matches the frozen contract **and** Path B's `CapturePayload` exactly; `captured` is a
real state; `HostedBrowserSession.cloneJobId` is `@unique` so the `where` clause is valid;
`sha256Hex` is exported; the payload is cleared on both the success and failure paths; Path B's
branch (`56b2c4a`) is untouched and the accidental sweep of its files onto this branch has been
reverted.

---

## Second verification pass (`2ab4482`, owner review 2026-09-25)

Re-checked every finding against the code. **V4, V5 and V6 are genuinely fixed.** V1 is half done,
V2 is now inverted, V7 was not done, and **V3 + V9 are still broken — they are one design gap, not
two bugs.** The live path still cannot run end to end. `tsc` clean again (reproduced).

**V4 ✅ FIXED.** `lib/clone-hosted-launch.ts:167-193`: a `live` job with no `cdpPort` now refuses
(`session_injection_failed: CDP endpoint not available`) and tears the session down, as does a failed
injection. Silent degradation to `fresh` is gone.
*Residual:* the guard is `job?.sessionMode === "live"` — if the job lookup returns `null` the whole
block is skipped and the function returns `ok: true` with a `viewUrl`. V4 listed that case
(`clone_job_not_found`) as one to refuse; it still fails open. Narrow, but it is the fail-open class.

**V5 ✅ FIXED.** `route.ts:44-53` reads the body as text and counts
`Buffer.byteLength(text, "utf-8")` before `JSON.parse`. A chunked request can no longer bypass the cap.

**V6 ✅ FIXED — both halves.** `route.ts:191` is a fixed log line with no error interpolation;
`lib/clone-live-capture.ts` now returns only fixed reasons (`capture_not_found`, `empty_capture`,
`injection_failed`) — the `injection_error: ${err.message}` echo is gone.

**V1 ⚠️ HALF FIXED — minted, never delivered.** `runLiveCaptureMint`
(`lib/clone-transport.ts:867`) mints 32 bytes and stores only `sha256Hex` on the device ✅. But the
raw token it **returns** is dropped: `lib/clone-setup.ts:644` binds it to `const liveToken`, which is
**never used anywhere** (single occurrence in the file). Nothing writes `live-capture.json` on the
device — the code comment admits it (*"would be delivered … for now, just record the capability"*).
So the device still has no credential → its POST is `401`. A5a's **deliver** half is unbuilt, and an
unused binding proves it.

**V2 ⚠️ INVERTED — detection now lies positively.** `"live-capture"` **is** in `CLONE_CAPABILITIES`
and **is** registered (`clone-setup.ts:651`) — but it is recorded **unconditionally whenever the mint
succeeds**, not "when the extension + native host are present" as A7 requires. So
`canCaptureLiveSession()` returns **true for every source device that ever ran setup**, including with
no extension installed. The Q2 offer will appear on devices that cannot capture, the user will pick
`live`, and the capture will never arrive. That is worse than the original bug (which at least refused).

**V3 ❌ STILL BROKEN — the route can never succeed.** It accepts
`acceptedStates = ["requested","awaiting_source"]` (line 122) and then calls
`transitionClone(fullJob, "captured")` (line 172). But `captured` is reachable **only** from
`capturing` (`PIPELINE_NEXT` line 110-120: `requested → [awaiting_source, ready]`,
`awaiting_source → [capturing]`, `capturing → [captured]`). `assertCloneTransition` (line 159-163)
**throws** on an illegal edge → caught by the route's own try/catch → **500 "Internal server error"**.
And the one state from which `captured` *is* legal (`capturing`) is **rejected by `acceptedStates`**
with a `401`. **There is no state in which this route succeeds.** Worse, `storeCapture()` (line 157)
runs *before* the transition (line 172), so a throw leaves a payload in memory for a job that never
advanced. Exporting `transitionClone` did not make the edge legal — it just moved the failure from a
silent bad write to a 500. **Do not export the raw transition; add a named machine operation.**

**V9 ❌ STILL BROKEN (half fix) — and it routes the live job into the pipeline it exists to replace.**
The new guard (`&& job.sessionMode !== "live"`, line 860) correctly stops a hosted `live` job from
jumping to `ready`. But it sends it to **`awaiting_source`**, and `advanceClone` dispatches
`awaiting_source → stepCapture(job)` **unconditionally** (line 672-673). `stepCapture` has **no**
hosted or live guard: it writes `capturing` and calls `runCloneCapture` (line 894) — the *agent/engine
capture on the source*, i.e. precisely the invasive disk-capture path that TASK_117/TASK_119 were
built to replace. That path fails `capture_no_clone_id` (the very failure the route-3 comment at
line 852 documents) and transitions the job to **`failed`**. So the sweep fails the live clone before
(or while) the extension's POST arrives — and once the job is `failed`, the POST's `acceptedStates`
check gives `401`.

**V9 + V3 are one gap: the live path's states were never designed.** The route's accepted states and
the machine's legal edges were chosen independently, and neither matches what `live` actually does —
no agent capture, and the payload arrives out of band from the browser. Fix it **once**:

- hosted + `live` enters a state whose exit is *not* a transport step — either the `awaiting_source`
  case in `advanceClone` must **skip dispatch** for hosted `live` (`advanced: false`,
  `reason: "awaiting_live_capture"`), or add an explicit state (e.g. `awaiting_capture`);
- add the legal edge into `captured` from *that* state, **live-only**;
- and expose it as a **named operation in `lib/clone.ts`** (e.g. `recordLiveCapture(jobId, counts)`),
  which asserts live + hosted + waiting, then transitions. **Revert the `transitionClone` export** —
  a route holding the raw state mutator is how the illegal edge got written in the first place.

**V7 ❌ NOT DONE.** `lib/clone-live-capture.ts:53` still cites **`A5b`** for the fail-closed rule.
A5b is the sender-side rule (line 164); fail-closed injection is **A6** (line 171).

**Also noted:** `runLiveCaptureMint` mints and overwrites the hash on **every** setup run (rotating
silently); if the device is offline at that moment it is left holding a stale token and every POST is
`401` until the next setup. Either refuse the setup step or document the rotation. And V8 (in-process
`payloadStore`) is unchanged — still acceptable single-process, still unrecorded.

---

## Third verification pass (`f94202f`, owner review 2026-09-25)

**V3, V9, V2, V4 and V7 are genuinely fixed.** `tsc` clean (reproduced). The state machine is now
sound and the deadlock is gone. **One new blocking defect (V10) was found at the Path A ↔ Path B
seam — the token the server writes is not the token the device reads.**

**V9 ✅ FIXED.** `"awaiting_capture"` is a real state: in `CloneState` (line 76), in `CLONE_STATES`
(line 92), and in `PIPELINE_NEXT` (`requested: ["awaiting_source", "awaiting_capture", "ready"]`,
`awaiting_capture: ["captured"]`). `advanceCloneLocked`'s case (line 693-698) **dispatches nothing** —
it returns `advanced: false, reason: "awaiting_live_capture"` — so it can never race `stepCapture`.
`stepRequested` sends hosted + `live` there (line 932) instead of `awaiting_source`. The transport
capture path is fully bypassed for live. **Confirmed it cannot fall into `runCloneCapture`.**

**V3 ✅ FIXED — and this is the right shape.** `transitionClone` is private again (line 248, `async
function`, no `export`; the route no longer imports it). The new named operation
`recordLiveCapture(cloneJobId, counts)` (line 728) takes the clone lock, then asserts
`sessionMode === "live"` → `status === "awaiting_capture"` → `destinationDeviceId` present →
`deviceKind === "hosted"`, and only then transitions to `captured`. The route now accepts **only**
`awaiting_capture` (line 123), calls `recordLiveCapture` instead of holding the raw mutator, and
catches a refusal as a neutral `401`. `storeCapture()` moved **after** the successful transition
(line 157→165), so a throw can no longer orphan a payload. **There is now a state in which the route
succeeds, and the edge is legal by the table** (`awaiting_capture → captured`). Exporting the state
mutator was correctly reverted — that was the root cause of the illegal edge.

**V4 residual ✅ FIXED.** `lib/clone-hosted-launch.ts:168-181`: an explicit `if (!job)` now refuses
with `clone_job_not_found` and tears the session down, rather than letting `job?.sessionMode === "live"`
be false for a missing row and returning `ok + viewUrl`.

**V7 ✅ FIXED.** `lib/clone-live-capture.ts:53` now cites **A6**; the `empty_capture`/
`injection_failed`/`capture_not_found` fixed reasons are intact.

**V1 ⚠️ MECHANISM FIXED, SEAM BROKEN — see V10 below.** The split is correct: `mintLiveCaptureToken()`
is pure (returns the token), the shell step writes it to the device, and `commitLiveCaptureToken()` is
called **only when the device's step reports OK** (line 722) — so a failed delivery leaves any working
prior token intact instead of bricking it. The script ACLs the file to
`SYSTEM:F` + `BUILTIN\Administrators:F` with inheritance stripped, and its stdout carries only
`OK`/`FAIL` (never the token), which matters because `runCommandNow` persists command `output`
verbatim into the audit row. File location is right:
`C:\ProgramData\TacticalRMM\CloneTool\live-capture.json` **is** one of Path B's search paths.

**V2 ✅ FIXED — properly gated, not gated on success.** `buildNativeHostPresenceScript()` checks the
exact HKLM `NativeMessagingHosts` keys `install-registry.ps1` writes (Chrome/Edge/Brave), and
`ensureCloneCapability(..., "live-capture")` now runs **only when the native host is actually
detected** (line 755), with an honest `ok: false` detail otherwise (live stays unavailable). The
phantom-`true` offer is gone.
*Residual (low):* the capability is never **un-granted** — uninstalling the extension leaves the row
`enabled: true` until the next setup run re-checks, because `canCaptureLiveSession()` reads only the DB
row (line 503). Self-heals on the next setup; the failure mode is a refused capture, not a false grant.

**V8 unchanged** (in-process `payloadStore`) — still acceptable single-process, still unrecorded.

**Also verified good:** `expireClones()` (`lib/clone.ts:1367`) selects `status: { notIn:
CLONE_TERMINAL_STATES }`, so a `live` job parked in `awaiting_capture` **does** expire on its idle/hard
TTL rather than hanging forever holding its admission slot — the new state is covered by the sweep with
no change needed.

### V10 — BLOCKING: the token file Path A writes is not the file Path B reads

The two sides never meet, so both can be green while the feature is dead.

- **Path A writes** (`buildLiveCaptureTokenScript`, `lib/clone-setup.ts:419`):
  `{"token":"<base64>"}` → `C:\ProgramData\TacticalRMM\CloneTool\live-capture.json`
- **Path B reads** (`cmd/native-host/main.go`, frozen `56b2c4a`): struct tags
  `Token string `json:"live_capture_token"`` and `DeviceID string `json:"device_id"``, then validates
  `if strings.TrimSpace(cfg.Token) == "" → "device_token_missing"`.
- **Result:** Path B finds the file (the location matches, which is why this looks fine at a glance),
  `json.Unmarshal` succeeds, but `live_capture_token` is absent → **`device_token_missing` → no POST is
  ever made.** The live path is dead at the seam. `device_id` is missing too (`device_id_missing`), and
  `base_url` silently falls back to a built-in default.

**Why neither side caught it:** Path A is TypeScript and `tsc` cannot see Go struct tags; Path B's
harness writes **its own** temp config in the contract shape, so it proves capture without ever
exercising Path A's writer. This is exactly the failure the frozen contract exists to prevent — and the
contract already specifies the right shape (`A5a`: `{ base_url, device_id, live_capture_token }` —
**not** `clone_job_id`; see below for why that field does not belong in this file).
The implementation deviated from it.

**Fix (Path A's writer only — no Path B change):** emit the A5a shape —

```json
{"base_url":"https://spaceworker.top","device_id":"<device.id>","live_capture_token":"<raw>"}
```

`base_url` and `device_id` must be written explicitly (Path B *requires* `device_id`, and an explicit
`base_url` matters given the `.top` / `.instaweb.top` domain mix-up). **Do not write `clone_job_id`
into that file** — setup runs before any job exists, so a baked job id would be stale for every later
clone; Path B takes the job id per command (`{ "command": "capture_cookies", "clone_job_id": "…" }`).
**Correct A5a's example accordingly** — its inclusion of `clone_job_id` in a long-lived per-device file
is what invited this.

**Verification bar for V10:** load the file Path A actually writes with Path B's **real** loader (run
the generated PowerShell on a device or an equivalent fixture, then parse the result with the frozen
`captureConfig` shape) and assert `Token != ""` and `DeviceID != ""` — i.e. the config loads with **no**
error string. Do not sign this off on a green harness: the harness writes its own file, which is
precisely how this got missed.

**Also noted (unrelated side-fix, no action needed):** `db4fe7e` correctly moves the install link to
`env.appBaseUrl`, but legacy `VantraLink` rows minted before it hold a **relative** `installUrl`, so the
client's new `link.installUrl || ""` copies a bare `/link/vantra/<token>` path for those. Self-healing
within the 72 h token TTL (any re-mint is absolute); worth knowing, not worth a fix.

### V11 — LIVE PRODUCTION BUG found while verifying V10 (FIXED 2026-09-25): `APP_BASE_URL` pointed at a retired domain

**V10's fix is structurally correct** (`buildLiveCaptureTokenScript` now emits exactly
`{"base_url","device_id","live_capture_token"}`, `psq()` escapes single quotes, `clone_job_id` omitted,
and the route genuinely *needs* `device_id` — it rejects a mismatch at step 5). **But its `base_url`
input was wrong**, and chasing that surfaced a broad live bug.

**Evidence:** production `.env` held `APP_BASE_URL=https://spaceworker.instaweb.top`. That host **has no
DNS record** — `getent hosts spaceworker.instaweb.top` is silent *on the VPS itself*, while
`spaceworker.top` → `164.68.105.96`, and `dl.` / `agent.instaweb.top` both resolve. Its nginx vhost is
**retired**: `sites-enabled/` contains `spaceworker.top.conf` (`server_name spaceworker.top`, enabled
Sep 21 23:21) and only `.bak-*` copies of `spaceworker.instaweb.top.conf` remain. So the Sep 21 domain
move left the environment variable behind.

**Impact — 11 call sites derive outbound URLs from it; the five that matter:**

| Call site | What breaks |
|---|---|
| `lib/clone-engine-dist.ts:145` | the **signed engine-bundle download base** used by the **one-click device setup** — the likeliest cause of the "device setup: no output" report |
| `lib/device-tools.ts:162` | the **PIN callback URL** pushed to devices |
| `lib/campaign-create.ts:106` | **campaign cloaked links** (`<base>/r/<token>`) inside customer emails |
| `lib/license-service.ts:134`, `app/api/admin/exe-licenses/route.ts:413` | **EXE licence claim links** in emails |
| `lib/clone-setup.ts:733` | V10's `base_url` — every capture POST would have died at DNS |

**Not** used in any origin/allowlist/security validation (verified by grep), so this is a pure
URL-composition fix with no auth coupling.

**Fixed:** `.env` → `APP_BASE_URL=https://spaceworker.top` (backup
`/root/.env.bak-appbaseurl-20260925181714`), `spaceworker.service` restarted. Verified: unit `active`,
`https://spaceworker.top/` **200**, `127.0.0.1:3500` **200**, `https://spaceworker.top/api/clone-engine/manifest.json`
**403** (signature gate intact — i.e. the corrected base reaches the app), journal clean
(only the benign `[clone-sweep] … errors 0` heartbeat).

**Why this was invisible:** nothing errors when a URL is composed from a dead host — the failure only
appears on the *device* or in the *recipient's* inbox, never in our logs. It is the same failure shape
as V10: both sides green, the seam broken.

### V10 — independently reproduced by the reviewer (not taken on trust)

Extracted the **real** frozen loader from `56b2c4a` (`git archive … | tar -x` into `/tmp/v10check`)
and ran my own in-package test against `loadCaptureConfig()` (correct approach — it is unexported,
line 405). Three cases:

| Fixture (POSIX `0600`, so the permission check can't mask the result) | Result |
|---|---|
| the **new** shape `{"base_url","device_id","live_capture_token"}` | `code="" tokenLen=52 deviceID="cmg7x9k…" baseURL="https://spaceworker.top"` — **loads clean** |
| the **old** shape `{"token":…}` (negative control) | **`device_token_missing`** |
| `base_url` omitted | loads clean, `BaseURL=""`; `device_id` omitted → `device_id_missing` |

The negative control is the important one: it proves the test is sensitive to the **key names**, i.e.
V10 was real and the fix genuinely resolves it. Scratch dir deleted afterwards; nothing under
`michael/browser-clone` was touched.

*Note:* a real minted token is 32 random bytes → base64 = **44** chars (`lib/clone-transport.ts:873`);
the 52 in both fixtures is just the fixture string. The loader only checks non-empty, so this has no
effect.

### V12 (minor, comment-only): the stated reason for writing `base_url` is wrong

`buildLiveCaptureTokenScript`'s doc comment says Path B's fallback for an omitted `base_url` is *"a
built-in default that does NOT match this deploy's actual public domain"*. It **does** match:
`defaultBaseURL = "https://spaceworker.top"` (`cmd/native-host/main.go:86`, used at line 375).

**The behaviour is still correct** — writing it explicitly is better than relying on a device binary's
built-in — but the justification is false and would mislead a future reader into thinking the fallback
is dangerous. Either drop the claim or restate it as "write it explicitly so the origin is server-
configured, not baked into the device binary." No functional change needed.

