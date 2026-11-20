# Task 119 (bit B9) — LIVE session mode: stream the user's real session into a clone

**Depends on:** B8 (`TASK_118_CLONE_HOSTED_DESTINATION_AND_LAUNCH.md`, DONE — hosted
destination + hosted launch + dial-out relay) and B7 (`TASK_117_HOSTED_POOL_PROVISIONING.md`,
DONE — `F6` proved CDP injection, `F10/F11/F12` closed every disk-based capture route).
**Guardrail:** **never touch a real customer device's session** (`WilkSF9`), and never the
owner's real Gmail. All testing uses a **disposable login on a throwaway site** on `Sc`.
**This task does NOT modify B8's `fresh` mode.** It adds a second, user-selected mode.

---

## What the owner asked for

Owner, 2026-09-25: *"the agent can stream the session live, not the flow that carries the
cookies and store in another route."* — i.e. two different clone behaviours, and the owner
wants the second one:

- **`fresh` (already shipped, route 3):** the clone is a brand-new browser. The user logs in
  inside it. **Nothing is copied from their machine.** Isolation was verified live: the clone
  profile held **0** cookies for the target domain before injection, at a completely separate
  filesystem path and docker mount from the private-browser profile.
- **`live` (THIS TASK):** the clone starts out **holding the user's real, logged-in session**,
  captured from a browser they are already signed into, delivered into the running clone
  **at runtime, through Chromium itself** — and still egressing through the user's device.

`fresh` stays the default and stays byte-for-byte unchanged. `live` is opt-in per clone job.

---

## Why this route and not the old one (already settled — do not re-litigate)

The old pipeline was **capture → transfer → inject into a stored profile**. TASK_117 killed it
with hard evidence:

| Finding | Result |
|---|---|
| **F10** — Windows Chrome 127+ cookie values are App-Bound-encrypted (`v20`); the key is released only to a path-validated Chrome | reading the DB out-of-process **cannot work** |
| **F11** — copying a profile gives a **different** ABE key (bound to the data-dir path); Chrome then deletes every row | staged clone: `cookie_rows=0` vs original `85` |
| **F12** — Chrome 136+ ignores `--remote-debugging-port` on the default profile | in-place CDP on the real profile **blocked** |
| **F4** — Chromium **discards any cookie row it did not itself write** (proven by injecting its own blob verbatim under a new name) | **disk-level injection is dead as a mechanism** |
| **F6** — `Storage.setCookies` over CDP works, needs **no attach**, and Chromium **persists** what it is given (survived a full container restart) | the delivery mechanism, **proven** |

There are exactly two supported ways to get a real session out of Chrome 127+:
**(1)** read cookies **inside** the browser process (`chrome.cookies`, i.e. the extension), or
**(2)** stop trying to transfer and log in inside the clone (`fresh`). This task wires (1)'s
capture to (2)'s delivery mechanism. Nothing else is left.


---

## The POC that passed (2026-09-25, disposable infra on the VPS only)

Run on two throwaway `ghcr.io/m1k1o/neko/chromium:latest` containers (the same image the real
hosted clone uses), a disposable login site, and the **already-committed** `scripts/clone-cdp.mjs`.
Nothing touched `Sc`'s real Chrome, `WilkSF9`, or the owner's real accounts.

1. **Live capture works, in-process, no disk, no decryption.**
   `clone-cdp.mjs export --domain …` against the running browser →
   `cookies_total=1 cookies_matched=1`, returning `sw_poc_session` **in plaintext**.
2. **Isolation is real, not assumed.** Before injection the clone reported `cookies_total=0`
   for the target domain.
3. **Runtime injection works.** `clone-cdp.mjs inject --cookies captured.json --url …` →
   `setCookies=1 verified=1 opened=…`.
4. **The CLONE's own browser made the request — driven by a script, not a human.** The test
   server logged the clone's request carrying the correct session value:
   `[server] / hit, cookie present=true match=true value=poc-…`

**Honest scope of that POC.** It proves the **delivery + isolation + agent-observability** half:
an automated agent can drive the clone and read the result, so this is not a hand-clicked demo.
It does **not** prove the capture half on a real Windows Chrome — the POC's source was a
container we could attach CDP to, which is exactly what F12 forbids on a customer's real
browser. **That capture half is the new build in this task, and it is the extension (Part B).**

---

## The bits

### B9-1 — `sessionMode` on the clone request (schema + API + UI)
- Add `CloneJob.sessionMode` (`"fresh" | "live"`, default `"fresh"`) — **hand-written migration**,
  mirroring the existing migration style. Additive + defaulted, so every existing row and every
  existing caller keeps today's behaviour.
- Accept `sessionMode` in `POST /api/devices/[deviceId]/clones`
  (`app/api/devices/[deviceId]/clones/route.ts`) and validate it against the literal set →
  `400` on anything else (same shape as the existing `egress`/`browser` validation).
- Console: a **mode selector** on the Start card, with copy that states the difference in plain
  words — *"Start fresh (log in inside the clone)"* vs *"Carry my current session"* — and the
  live option's real caveat: **the extension must be installed and the user must be signed in
  in that browser**. Do not show it as magic.

### B9-2 — capture: the extension reads cookies from inside Chrome (Part B, Cline)
`chrome.cookies.getAll()` runs **inside the browser process**, so it receives **plaintext**
regardless of how the value is encrypted at rest — that is the whole reason this route survives
F10/F11/F12. Files, payload shape and test plan are in **Part B** below.

MV3 note the implementer must handle: **`chrome.cookies` requires host permission for the
cookie's host**, so `"cookies"` in `permissions` alone returns nothing. **DECIDED (Q1, owner,
2026-09-25): `host_permissions: ["<all_urls>"]`** — all sites, no picker, no
`optional_host_permissions` flow. The permission is broad and the code says so in a comment.

### B9-3 — transport: the payload the server accepts (Part A)
Define the ingest contract **once**, here, and keep both sides to it:

```
POST /api/devices/clone-capture
  PUBLIC device-facing route — the DEVICE TOKEN is the credential (A5a). Mirrors
  app/api/devices/pin-callback/route.ts. NOT /api/internal/* (a device must never
  hold the server-to-server internal bearer).
  Header: Authorization: Bearer <per-device token>
{
  "cloneJobId": "<id>",           // the job this capture is for
  "deviceId":   "<id>",           // the source device that sent it (must own the job)
  "browser":    "chrome",
  "capturedAt": "<iso8601>",
  "cookies": [ { "name","value","domain","path","secure","httpOnly","sameSite","expirationDate" } ],
  "truncated":  false             // true when the sender hit its own cap — see below
}
→ 202 { "ok": true, "accepted": <n> }     // count only, never any value
```

Hard rules for this route:

- **Owner-scope every write**: the `cloneJobId` must belong to the user that `deviceId` belongs
  to, and the job must be in a state that expects a capture; otherwise `404`/`409`, never a write.
- **Never log a cookie value** — not in the request log, not in the audit, not in an error
  message. Record **counts and domains only** (`cookieCount`, `domainCount`). This is
  CROSS-TRACK RULE 5, and it is enforced structurally: the audit row takes integers.
- **Size cap**: native messaging is capped at **1 MiB per message** (`cmd/native-host/main.go`,
  `maxMessageBytes`). A real profile can hold thousands of cookies, so the sender must either
  chunk (e.g. ≤500 cookies per message, one `POST` each, `truncated` + a count on the last) or
  cap and report honestly. **A silently truncated jar is a bug that looks like "some sites work
  and some don't".**
- **Short TTL**: the captured payload is held only long enough to inject it, then discarded. It is
  a live credential; treat it like one (memory or a `0600` file, deleted on inject, on failure,
  and on job teardown).

### B9-4 — injection: the captured cookies land in the running clone (Part A)
- Expose a **per-session CDP endpoint** for the clone container. B8-2 already leaves
  `HostedBrowserSession.cdpPort` in the schema unfilled — this is what fills it.
- **CDP binds container-loopback only** (TASK_117's recorded finding; the image ships no
  `socat`/`nc`), and recent Chromium ignores `--remote-debugging-address=0.0.0.0` for external
  reach, so a **forwarder** is required — the `swfwd` static binary already scoped in
  `TASK_117` (deliverable D3), mounted into the container and started as a supervisord program,
  with `-p 127.0.0.1:<allocated>:<forwarder port>`. **The published port MUST be host-loopback**
  — this endpoint grants full control of the browser and must never be publicly reachable.
  (`browser-server` runs on the host, so host-loopback is directly dialable by it.)
- Move the proven CDP client out of `scripts/clone-cdp.mjs` into a **server-only module**
  (`lib/cdp.ts`) so the script and the server share **one** implementation; keep it
  **dependency-free** (node built-ins only — `ws` is deliberately not a repo dependency), and
  carry over the two traps that cost hours: the **corked HTTP-upgrade socket**, and the
  **`/devtools/page/<id>` endpoint that completes the handshake but silently ignores every
  command** (hence: browser endpoint + `Storage.setCookies` + `Target.createTarget`, **no
  attach** — `Target.attachToTarget` returns `Not allowed`).
- **Fail closed and label honestly.** If `sessionMode: "live"` yields **0 cookies**, the launch
  must **refuse with a named reason** — never silently fall back to a `fresh` clone. A user who
  asked to carry their session and silently got an empty browser will conclude the product is
  broken and will not know why. Record `sessionMode` and the counts on the audit row.
- Injection happens **once per launch**; Chromium persists what it is given (proven, F6), so
  re-injection on relay/session restart is a supported recovery, not the primary path.

### B9-5 — isolation (must not regress)
- The live clone keeps its **own profile dir**, keyed by `cloneJobId` — **never** shared with the
  private-browser profiles and never between two clone jobs. B8-2 already builds
  `profileDirPath(sessionId)` this way; this task must not change that.
- On disk those are two distinct paths, and they must stay two distinct paths. State it in the
  verification bar so a future refactor can't quietly merge them.


---

## Part A / Part B split (so two agents can work without touching the same files)

| | **Part A — server, state machine, CDP** | **Part B — extension + native host** |
|---|---|---|
| Owner | the primary agent (state machine + trust boundary) | **Cline** (self-contained, independently testable) |
| Files | `prisma/schema.prisma` + one hand-written migration · `lib/clone.ts` · `lib/clone-hosted-launch.ts` · `lib/cdp.ts` (new, extracted from `scripts/clone-cdp.mjs`) · `lib/clone-live-capture.ts` (new, ingest + TTL) · `app/api/devices/clone-capture/route.ts` (new — device-facing, device-token auth) · `app/api/devices/[deviceId]/clones/route.ts` · `browser-server/server.ts` · `components/device-console.tsx` | `michael/browser-clone/engine/extension/manifest.json` · `.../extension/background.js` · `.../extension/popup.js` · `.../extension/popup.html` · `michael/browser-clone/engine/cmd/native-host/main.go` · `michael/browser-clone/engine/pkg/types/types.go` · `michael/browser-clone/tests/Test-CookieCapture.ps1` (new) |
| Deliverable | `sessionMode` end to end, CDP port exposed + injected, ingest route, fail-closed, copy | a **verified cookie capture** on `Sc`: manifest + permission, `chrome.cookies.getAll()` in the background worker, chunked native-message payload, no value ever logged |
| Blocked by | needs Part B's **payload shape** (frozen in B9-3) — otherwise independent | nothing — can start immediately |

The two parts meet at exactly one thing: **the JSON in B9-3.** It is frozen above, so neither part
waits on the other.

---

## Part B — the Cline task, in full

**Goal:** prove that a real Chrome profile's live session cookies can be read from **inside** the
browser and handed to the native host, on `Sc`, against a **disposable login**.

1. **`manifest.json`** — add cookie access: **`"cookies"` in `permissions` + `host_permissions:
   ["<all_urls>"]`** (owner decision Q1, 2026-09-25 — all sites, **no domain picker**). `chrome.cookies`
   requires host permission for the cookie's host, so `"cookies"` alone returns nothing — which looks
   exactly like a broken feature. State in a comment why the permission is broad and that it is
   deliberate. Also replace the stale `spaceworker.yourcompany.com` placeholder in
   `externally_connectable` if it is still there — it is not a real host (and the same dead URL is
   hard-coded in a `fetch` in `popup.js`).
2. **`background.js`** — add a `capture_cookies` command:
   - `chrome.cookies.getAll({})` (optionally filtered by a domain allow-list passed in the message);
   - map each cookie to the B9-3 shape (`name, value, domain, path, secure, httpOnly, sameSite,
     expirationDate`);
   - **chunk** to stay under 1 MiB per native message, and report `truncated`;
   - forward through `chrome.runtime.sendNativeMessage('com.spaceworker.clone', …)`;
   - **never** log a value; log counts only.
3. **`popup.js` / `popup.html`** — a second action beside the existing Clone button:
   *"Carry my current session"* → request permissions if optional → send `capture_cookies` →
   show the **count** returned ("142 cookies from 17 sites") or the error. No values in the UI.
4. **`cmd/native-host/main.go`** — a `capture_cookies` command: validate the payload, hold it, and
   POST it to the B9-3 route (reuse the existing transport; **do not** add a new auth mechanism).
   Keep the existing `clone_browser` / `get_clone_status` commands untouched.
5. **`pkg/types/types.go`** — the payload struct, shared with the chunking logic.
6. **`michael/browser-clone/tests/Test-CookieCapture.ps1`** (new) — the proof harness, in the
   style of the existing `tests/Test-Roundtrip.ps1`:
   - stand up a **disposable login** (a local test page that sets a session cookie is acceptable
     and is what the POC used) — **never** a real account;
   - assert the capture returns that cookie, by name, with a non-empty value;
   - assert the count/domain inventory;
   - assert **no value is written to any log file** the harness produces;
   - assert chunking: a synthetic oversized jar is split and flagged `truncated`.

**Do NOT, in Part B:** install anything on a customer device, touch `WilkSF9`, touch the owner's
real Gmail, add a store listing, or change the clone pipeline. Extension code + harness only.

**Part B acceptance (owner-runnable, on `Sc`):**
> Load the unpacked extension in a Chrome where a **disposable** site is logged in, click
> *Carry my current session*, and see a **count** — then confirm the same cookie arrives at the
> B9-3 route and the clone opens **signed in** to that disposable site.


---

## Decisions the owner has already made (do not re-litigate)

- One browser on our side, **one profile per clone job** (B8's design) — unchanged.
- Egress **through the user's device**, via the dial-out relay (B8-3) — unchanged.
- **`fresh` stays the default**; `live` is opt-in per job.
- **No silent fallback**: a `live` job that cannot get its session **refuses** and says why.

## Owner decisions (2026-09-25 — settled, do not re-litigate)

- **Q1 — capture scope: ALL sites.** Owner: *"just capture all site, easier to setup, and no need
  selection, user can open what session they want or the agent can."* So the extension takes
  `<all_urls>` in `host_permissions` (the simple, broad option) and **no domain picker is built**.
  The user (or the agent) decides what to open *after* the clone is running — the capture is not
  the place to be selective. Record the permission honestly in the manifest and in the copy; do
  not dress it up.
- **Q2 — a missing extension offers `fresh`, and the install stays silent.** The console must
  **detect** whether the device can do a `live` capture and then:
  - **capable** → offer *"Carry my current session"* (`live`);
  - **not capable** → offer **`fresh`** as the real, working choice, plus the existing **one-click
    silent setup** to enable session carry — never a dead `live` button that fails after Start.

  "Silently, as the plan" means exactly what the pipeline already does: the extension + native
  messaging host are installed by the **one-click device setup** (`TASK_114`, `install-registry.ps1`
  already registers the native host for Chrome/Edge/Brave under HKLM with no user interaction).
  The one honest caveat that must be surfaced — not hidden: deploying the extension itself uses
  Chrome's `ExtensionInstallForcelist` policy, which makes Chrome show **"Managed by your
  organization"**. That is a real, visible side effect on the user's browser and the UI must say
  so before the user enables it.
- **Q3 — per-device credential on the capture route (owner amendment, 2026-09-25).** The route is
  **device-facing and public**, and takes a **per-device token** — **never** the fleet-wide
  internal bearer (a device must never hold `INTERNAL_BEARER_TOKEN`/`VANTRA_INTERNAL_TOKEN`, and one
  leaked device must not be able to forge another customer's capture). Minted with the relay
  token's existing primitive, stored as **SHA-256 only** in `Device.liveCaptureTokenHash`, delivered
  at setup over the existing one-click channel, rotatable/revocable by replacing/clearing the hash.
  Full detail in Path A **A5a**; the sender-side obligation is stated in Path A **A5b** and binds
  Path B's native host.

## The two paths (this file is the umbrella; each path is standalone)

This bit is split so two agents can work at the same time without touching the same files. Each
path file contains **everything** needed for that agent — goal, the frozen wire contract, its own
file list, its acceptance bar and its rules. Neither agent needs to read the other's file.

| Path | File | Who | What |
|---|---|---|---|
| **A** | **`TASK_119A_LIVE_SESSION_SERVER.md`** | the primary agent (state machine + trust boundary) | `sessionMode` end to end, the ingest route, the CDP module + per-session port + forwarder, launch wiring, fail-closed, the console mode UI, extension detection |
| **B** | **`TASK_119B_LIVE_SESSION_EXTENSION.md`** | **Cline** (self-contained, independently testable) | the extension (`chrome.cookies.getAll()`), the native-host command, the chunked payload, the proof harness |

They meet at exactly one artifact: **the JSON contract in B9-3**, reproduced verbatim in both path
files. Changing it means changing **both** files in the same commit — that is the only coupling.

## Verification for the bit as a whole

1. `fresh` is **unchanged**: same behaviour, same records, same egress proof.
2. `live` on a disposable login → the clone opens on a page **already signed in**, and the
   session's `egressIp` is the **device's** IP, not ours.
3. `live` with **0** captured cookies → **refusal with a named reason**, no clone.
4. Isolation: the clone's profile path differs from the private-browser profile path **and** from
   any other clone job's; the clone starts with 0 cookies for the target domain before injection.
5. No cookie **value** appears in any log, audit row, or API response — counts and domains only.
6. Never `WilkSF9`; the VM is left clean (no containers, no temp scripts, no stray files).

## Rollback

Additive and defaulted: a new `sessionMode` column defaulting to `"fresh"`, a new ingest route, a
new CDP helper, and an opt-in extension command. Reverting = dropping the mode from the UI; every
existing `fresh` job and every existing caller behaves exactly as it does today.

