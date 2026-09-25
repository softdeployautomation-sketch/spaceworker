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
POST /api/internal/clone-live-capture   (bearer-gated, same class as the other /api/internal routes)
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
| `prisma/schema.prisma` + one **hand-written** migration | `CloneJob.sessionMode`; `HostedBrowserSession` capture/session fields (see A1/A6) |
| `lib/cdp.ts` | **new** — the dependency-free CDP client, extracted from `scripts/clone-cdp.mjs` |
| `lib/clone-live-capture.ts` | **new** — ingest validation, short TTL, injection orchestration |
| `app/api/internal/clone-live-capture/route.ts` | **new** — the contract above |
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

**A5 — ingest (`lib/clone-live-capture.ts` + the route).** Enforce, in this order:
1. bearer auth (same class as the other `/api/internal` routes);
2. the `cloneJobId` **belongs to the user that `deviceId` belongs to**, and the job is **in a state
   that expects a capture** → otherwise `404`/`409`, **never a write**;
3. payload validation (shape, caps, sanity) → `400` naming the field;
4. **no value is ever logged, echoed, audited or persisted beyond its short TTL.** The audit row
   takes **integers**: `cookieCount`, `domainCount`, `truncated`. This is CROSS-TRACK RULE 5 and it
   must hold structurally, not by discipline.

Hold the payload only long enough to inject it (memory or a `0600` file), and delete it on inject,
on failure, and on job teardown. **A live capture is a credential.**

**A6 — injection + fail-closed launch.** For a `live` job with a hosted destination: create the
profile dir (per job, unchanged) → start the session → wait for the CDP endpoint →
`Storage.setCookies` → verify → record `cookieCount`/`domainCount` and `sessionMode`.
**If the capture yields 0 cookies, or injection cannot be verified, the launch REFUSES with a named
reason** — **never** a silent fallback to `fresh`. A user who asked to carry their session and
silently got an empty browser will conclude the product is broken and will not know why. Keep B8's
existing fail-closed relay behaviour exactly as it is.

**A7 — detection (Q2), single source of truth.** Add a `live`-capture capability that the
device-side one-click setup records when the extension + native host are present (the native-host
registration path already exists: `install-registry.ps1` writes it for Chrome/Edge/Brave under
HKLM, silently, with no user interaction). Expose it on the setup read model
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
4. The ingest route: unauth → `401`; a job that isn't the sender's → `404`; malformed payload →
   `400` naming the field; a valid payload → `202` with a **count only**.
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

