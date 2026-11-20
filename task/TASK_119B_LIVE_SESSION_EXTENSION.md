# Task 119B (bit B9-B) — PATH B: read the live session out of Chrome, from inside Chrome

**This file is standalone.** It contains everything you need. You do **not** need to read
`TASK_119A` or any other task file to do this work — but you **do** need the two mandatory reads
in *Rules* below (`HOW_WE_MOVE_FAST.md`, and the agent contract in the tracker).

**Owner, 2026-09-25:** *"just capture all site, easier to setup, and no need selection, user can
open what session they want or the agent can."* → **capture everything, build no domain picker.**

---

## Why this exists (the one paragraph you must understand before writing code)

A "browser clone" runs the user's browser session on our side, with its traffic leaving through
the user's own PC. To make the clone **already signed in**, we must get the user's cookies out of
their browser. On Windows Chrome 127+ every one of the three obvious ways is **dead by design**,
and this was proven with measurements, not guessed (full detail in
`TASK_117_HOSTED_POOL_PROVISIONING.md` findings F10/F11/F12):

| Route | Why it is dead |
|---|---|
| Read `Cookies` + `Local State` and decrypt ourselves | values are App-Bound-encrypted (`v20`); the key is released only to a path-validated Chrome. Measured: `rows=85 decrypted=0 failed=85 schemes=map[v20:85]` |
| Copy the profile, launch our own Chrome on the copy, read it over CDP | the key is bound to the **data-directory path**, so Chrome cannot decrypt the copy and **deletes every row**: 85 → 0 |
| Attach a debug port to the user's **own** Chrome | Chrome 136+ ignores `--remote-debugging-port` on the default profile |

**The only route that survives is reading the cookies from *inside* the browser process** —
`chrome.cookies.getAll()` in an extension. Chrome hands the extension **plaintext** because the
extension runs in-process; no decryption, no debug port, no profile copying. That is this task.

---

## What "done" looks like

A **verified capture** on a disposable login: a Chrome/Edge/Brave profile signed into a
**throwaway** test site yields that site's session cookie, by name, with a non-empty value, through
`chrome.cookies` → the MV3 service worker → the native messaging host → one POST of the frozen
contract payload. Plus the harness that proves it, and proof that **no cookie value** ever reaches
a log, the UI, or an error message.

Your part ends at the native host having **sent** the payload. Receiving it (the server route) is
Path A — which is why your harness must be able to prove capture **without** Path A being deployed.

---

## THE FROZEN WIRE CONTRACT — do not change it alone

Both paths are written against this. The **only** coupling between Path A and Path B is this JSON.
If you believe it must change, say so in your report and stop — do not silently diverge.

**Extension → native host** (one native message per chunk; native messaging frames each message
with a 4-byte little-endian length and is capped at **1 MiB per message** —
`cmd/native-host/main.go`, `maxMessageBytes`):

```json
{
  "command": "capture_cookies",
  "clone_job_id": "<id>",
  "browser": "chrome",
  "captured_at": "<iso8601>",
  "chunk_index": 0,
  "chunk_count": 3,
  "truncated": false,
  "cookies": [ { "name": "", "value": "", "domain": "", "path": "/",
                 "secure": true, "httpOnly": true, "sameSite": "lax",
                 "expirationDate": 1234567890 } ]
}
```

- `chunk_index` counts from 0; `chunk_count` is how many messages this capture was split into. The
  host **accumulates chunks in memory** (validate contiguous indices; hard cap 25 MB) and makes
  **one** POST — the 1 MiB limit is a framing limit, not a reason for the server to assemble.
- `truncated: true` means the extension hit **its own** cap and the jar is incomplete. Report it;
  never send a partial jar as if it were whole.
- `expirationDate` may be absent for session cookies — pass it through as-is.

**Native host → server** (Path A implements the receiver):

```
POST /api/devices/clone-capture
  PUBLIC device-facing route — the DEVICE TOKEN is the credential (Path A's A5a).
  Mirrors app/api/devices/pin-callback/route.ts. NOT /api/internal/*.
  Header: Authorization: Bearer <per-device token from the installed config>
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

**Hard rules on that payload:** never log, print or persist a cookie **value** — nor the **device
token** — anywhere except the payload/header that carries it; the response and any audit take
**counts and domains only**.

---

## Your files — exactly these, nothing else

| File | Change |
|---|---|
| `michael/browser-clone/engine/extension/manifest.json` | add `"cookies"` to `permissions` + `"host_permissions": ["<all_urls>"]`; replace the dead `spaceworker.yourcompany.com` placeholder in `externally_connectable` |
| `michael/browser-clone/engine/extension/background.js` | add the `capture_cookies` handler: read, map, chunk, forward |
| `michael/browser-clone/engine/extension/popup.js` | add the *"Carry my current session"* action; show **counts only** |
| `michael/browser-clone/engine/extension/popup.html` | the button + status element for it |
| `michael/browser-clone/engine/cmd/native-host/main.go` | add the `capture_cookies` command: accumulate chunks, POST, report count |
| `michael/browser-clone/engine/pkg/types/types.go` | the payload/chunk structs |
| `michael/browser-clone/tests/Test-CookieCapture.ps1` | **new** — the proof harness |

If you find you must touch a file outside this list, **stop and report** — do not expand scope.


---

## The work

**B1 — `manifest.json`.** `"cookies"` in `permissions` **and** `"host_permissions": ["<all_urls>"]`.
`chrome.cookies` requires host permission for the cookie's host; `"cookies"` alone returns
**nothing**, which looks exactly like "the feature is broken". The owner decided **all sites**, so
`<all_urls>` is correct — add a short comment saying why, and that the prompt it produces is broad.
Also fix `externally_connectable`: `https://spaceworker.yourcompany.com/*` is a **placeholder that
is not a real host** (the same dead URL is hard-coded in a `fetch` in `popup.js`); make the app
origin configurable rather than inventing another placeholder.

**B2 — `background.js`.** Handle `{command: "capture_cookies"}` in the existing
`chrome.runtime.onMessage` listener (keep `clone_browser` and `get_clone_status` working exactly as
they do now):

- `chrome.cookies.getAll({})` — all sites, per the owner's decision, **no picker**;
- map each cookie to the contract shape (`sameSite` may come back as `unspecified` /
  `no_restriction` — pass it through, do not invent values);
- chunk so **every** native message stays under 1 MiB (≈500 cookies per chunk is a safe starting
  point, but size by **serialized bytes**, not by count — a handful of large values can blow one
  chunk);
- send chunks **in order**, each via `chrome.runtime.sendNativeMessage('com.spaceworker.clone', …)`;
- `truncated: true` on the last chunk only if you hit your own cap;
- **no `console.log` of values** — counts only;
- handle Chrome's callback error (`chrome.runtime.lastError`) and surface a **named error**
  (e.g. `capture_failed: …`), never an empty success.

**B3 — the popup.** A second action beside the existing Clone button: *"Carry my current session"*.
On click, send `capture_cookies` and render the **count** the host returns ("1,204 cookies from 63
sites") or the named error. Never render a value. Leave the existing Clone button untouched.

**B4 — `cmd/native-host/main.go`.** Add `capture_cookies` to the dispatch:

- decode and **validate** each chunk (contiguous `chunk_index`, sane `chunk_count`, cap the total);
- accumulate; on the final chunk, POST the contract body to `/api/devices/clone-capture` using the
  **existing** transport. **Auth = the per-device token** the one-click setup installed on this
  machine: read it from the host's own config file (`0600`) and send it as
  `Authorization: Bearer <token>`. **Do not** invent a token scheme, do **not** embed the token in
  the payload or the extension, and **never** use a server-side/internal bearer — the route treats
  this device token as the credential (Path A's A5a);
- reply to the browser with counts only:
  `{ "status": "success", "accepted": <n>, "domains": <n>, "truncated": <bool> }`;
- a failed POST is `{ "status": "error", "error": "<named reason>" }` — never a silent success.

**B5 — `pkg/types/types.go`.** The Go structs for the chunk message and the POST body, so the
shapes live in one place and `go vet` checks them.

**B6 — `tests/Test-CookieCapture.ps1`.** Model it on the existing `tests/Test-Roundtrip.ps1` style.
It must:

1. stand up a **disposable login only** — a local test page that sets a session cookie is fine and
   is what the POC used. **Never a real account, never `WilkSF9`, never the owner's Gmail**;
2. assert the capture returns that cookie **by name with a non-empty value**;
3. assert the count / distinct-domain inventory;
4. assert **no value** appears in any log file the harness writes;
5. assert chunking: a synthetic oversized jar splits into multiple messages and is flagged
   `truncated` at the cap;
6. exit non-zero with a clear message on any failure.

**The harness must not require Path A.** Prove capture end-to-end **without** the server route
being deployed — e.g. support an option that writes the assembled payload to a `0600` temp file so
the harness can assert its contents locally. The POST itself is verified later, by the owner, once
Path A is live.


---

## Rules (identical to every other bit in this pipeline — see the tracker's agent contract)

> **COMMIT ONLY. DO NOT DEPLOY.**
> - Branch: **`agent/task-119b-live-capture`**.
> - **Never** edit, create or rsync `.env`; never ssh the VPS; never run `npm run build` or
>   `prisma migrate deploy` on the server. **No migration in this path** — you touch no Prisma code.
> - **Never** write JS/PS/Go through a shell heredoc — use the file editor, then verify
>   (`HOW_WE_MOVE_FAST.md` §6).
> - Stay inside the file list above. If you must go outside it, **stop and ask**.
> - `gofmt -l` clean, `go vet ./...` clean, `go build ./...` green for the Go parts
>   (`cd michael/browser-clone/engine`). `node --check` clean for the extension JS.
> - The extension is loaded **unpacked** for testing; do not produce a store build or a `.crx`.

**Mandatory reads:** `HOW_WE_MOVE_FAST.md` (§6 gotchas) and the **STANDARD AGENT CONTRACT** in
`PIPELINE_CONSOLE_BROWSER_CLONE.md` (the block right under "How this pipeline works"). Also skim
the existing `tests/Test-Roundtrip.ps1` and `engine/extension/*` so your code matches the house
style — this is a small, self-contained addition to working code, not a rewrite.

**Safety guardrails, non-negotiable:**
- A **real customer device (`WilkSF9`) is never a test target** — not for a capture, not for a
  probe, not as a fallback.
- **Never** capture the owner's real signed-in accounts. Only the disposable test login.
- Any temp file holding captured cookies is `0600` and deleted at the end of the run.

---

## Acceptance (owner-runnable, on `Sc`)

> Load the unpacked extension in a Chrome where a **disposable** test site is logged in → open the
> popup → click *"Carry my current session"* → see a **count** ("N cookies from M sites") → run
> `tests/Test-CookieCapture.ps1` → **all assertions pass**, and `grep` of every log the run
> produced finds **no cookie value**.

## Report back with (keep it short)

1. Files changed (must be exactly the list above).
2. `gofmt -l` / `go vet` / `go build` results, and `node --check` for the JS.
3. The harness output — the count, and the assertion lines.
4. Anything you could **not** verify locally, stated plainly.
5. Confirmation that the single POST target and the frozen contract were **not** modified. If you
   changed the contract, stop and flag it instead.

## Known traps (so you don't rediscover them)

- `"cookies"` permission **without** host permissions ⇒ `getAll` returns nothing. Looks like a
  broken feature; it is a missing permission.
- The 1 MiB native-messaging cap is **per message** — an unchunked real profile will exceed it and
  the host will reject the length as invalid.
- MV3 service workers are killed when idle, so **do not** hold capture state in a global; finish
  the chunked send inside the one message handler that started it.
- `chrome.cookies.getAll` is async **and** callback-based; a wrapped `await` that swallows
  `chrome.runtime.lastError` turns a real error into `cookies: []` — surface the error instead.
- `popup.js` currently `fetch`es a placeholder origin that does not exist. If your capture path
  needs the app origin, make it configurable — do not copy the placeholder.

