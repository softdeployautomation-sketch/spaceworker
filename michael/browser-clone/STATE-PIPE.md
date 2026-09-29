# The browser state pipe (TASK_135 §6)

How a clone ends up with **history, bookmarks, open tabs, extensions and settings**
from the work PC — the half that is *not* cookies.

Cookies travel separately, from inside the user's own browser, and are pushed into
the running clone over CDP (`browser-server/README.md`). They cannot travel as files
on modern Chrome: since Chrome 127 they are sealed with App-Bound Encryption, so a
copied profile loses them. This pipe carries everything **else**, and it is
deliberately independent — if it cannot run, the clone still opens signed in.

---

## 1. What it carries, and what it refuses

| Carried (the replica's "it's my browser" half) | Refused, by name |
|---|---|
| `History`, `History-journal` | `Network/Cookies*` → `cookies_abe_bound_use_cdp` |
| `Bookmarks` | `Login Data*` → `passwords_abe_bound_unusable_in_clone` |
| `Preferences`, `Secure Preferences` | `Local State`, `app_bound_encrypted_key` → `abe_key_store_never_transferred` |
| `Sessions/*` — **the open tabs** | `SingletonLock`/`Cookie`/`Socket` → `stale_browser_lock` |
| `Extensions/**`, `Web Data` | `*-journal` → `journal_transient` |
| `Favicons`, `Top Sites`, `Shortcuts`, `DIPS`, `Network Action Predictor` | `Affiliation Database` → `unused_by_clone` |

The exclusion list is duplicated on purpose (device and server sit on opposite sides
of a trust boundary). The duplication is checked, not trusted:

```
npm run check:clone-contract
```

It fails if the two lists differ **in either direction**, and — since this task — if
the **sync mode vocabulary** differs. That second check matters more than it looks:
the device decides what to send from the mode alone (`SelectStateFiles`: a delta means
"only what you were asked for", everything else means "send the whole profile"), so a
server that invented a third spelling would silently make every reconnect re-send an
entire profile, forever, with no error anywhere.

---

## 2. The path a state file takes

```
work PC (silent)                     platform                      hosted clone PC
────────────────                     ────────                      ────────────────
sync-state                            GET  ?stage=plan  ──┐
  locate the real profile                                 │  compares against the
  filter + fingerprint (sha256)  ────────────────────────┘  stored manifest, or —
  POST ?stage=file  (raw bytes)      stage into the cache   if there is none — the
  …repeat…                                                  target's CACHE
  POST ?stage=finalize               store what the cache
                                     ACTUALLY holds as the
                                     next baseline
                                                              materialise the whole
                                                              cache into the profile,
                                                              then launch (pinned build)
```

**The cache, not the job, is where bytes survive.** The hosted profile directory is
created per session and deleted when the session ends, so staging per-job would mean
a reconnect's delta landed in an empty tree — a replica with no history and no
bookmarks, which is the exact failure this feature exists to remove. The bytes live in
a cache keyed by **device + browser + profile**, and every session's profile is
materialised from the whole of it. A delta therefore only ever changes bytes **on the
wire**; the materialised tree is always complete.

**Removals are applied last, at finalize.** A device that dies mid-transfer then
leaves a *stale* file (visible) rather than a *missing* one (silent loss).

**The baseline is what the cache HOLDS, not what the device SENT.** A file that
failed to stage can never be recorded as transferred — that is what would make the
next clone skip it and lose it for good.

---

## 3. Why a real profile needs more than one command

A device command is capped at 90 s (`DEVICE_COMMAND_MAX_SECONDS`). A real profile is
bigger than one command's worth of transfer. So:

1. The platform asks the device to spend **less than the cap SENDING**
   (`--budget` = timeout − 15 s) and to **report what it did not get to**
   (`pending` / `done:false`).
2. The device stops at a **file boundary** — never mid-file, so a partial write can
   never enter the replica — and **still finalizes**, recording the bytes that landed.
3. The next round's plan is a delta over exactly those bytes, because the cache is
   now the baseline (`reason: "cache_baseline"`). Up to `STATE_SYNC_MAX_ROUNDS` (3)
   rounds, under a wall-clock deadline of `STATE_SYNC_DEADLINE_MS` (150 s).
4. Whatever is still outstanding is recorded as **`stateSyncPending`** and shown to
   the operator. The next clone — or the console's own button — continues from there
   **without re-sending anything**.

Bounded twice on purpose: this runs inside a clone's advance path, so it must not
hold that open indefinitely. Stopping early is not a failure; claiming completion is
the only unacceptable outcome.

---

## 4. The two hard rules

### It is completely silent on the work PC

No windows, no tray icon, no prompt, no console — nothing for the user to notice, and
nothing for them to click. The design consequences, all of which are load-bearing:

- **The browser may be closed, open, or mid-write.** Every file is opened read-only and
  copied with a shared read. An unreadable or locked file is a **named skip**
  (`state_file_unreadable`), never a retry loop and never a prompt.
- **Nothing is asked of the user.** The pipe is started by the platform, not by a
  browser action. It does not need the browser open, and it does not need a session.
- **Every process it spawns is hidden** (`procattr.Quiet`, `CREATE_NO_WINDOW` +
  `DETACHED_PROCESS`).
- **No subprocess at all in the new code**: the sender is file IO plus one HTTPS POST.

### Every directory it runs from is excluded from Defender/AV

Not a preference — a hard rule, because a scanner that reads these files mid-transfer
either corrupts the replica or blocks the read. `preflight` takes **several**
directories (`--dir`, repeatable, plus `--also-dir` for the staging root), registers
the exclusion for each, **verifies** it took, and **refuses a partial quarantine** —
it will not report success while one directory remains unscanned-blocked.

> `psQuote()` in the installer is not cosmetic: a path containing an apostrophe could
> otherwise break out of the quoted PowerShell string and run **as SYSTEM**.

---

## 5. Where the profile is found (and the trap that was there)

`browser.DefaultProfilePath` answers *"where would a browser put its profile if it were
launched here, right now"*. That is the right question when **mounting** a profile on a
virgin hosted PC, and the wrong one on the work PC: this half runs over the platform's
run-command path, and when the traveller has logged off there is no interactive session
to run inside — so it may execute **as SYSTEM**, where `%LOCALAPPDATA%` is the *service's*
own profile:

```
C:\Windows\system32\config\systemprofile\AppData\Local\Google\Chrome\User Data
```

which is either absent or empty. Rooted there, a sync reports `state_profile_missing`
on a machine whose real profile is full of history — a failure that is true about the
directory and a lie about the machine, and which nothing in the log explains.

`pkg/browser/source.go` therefore **locates** the profile instead:

- every candidate root is inspected (`%LOCALAPPDATA%`, then each `C:\Users\*\AppData\{Local,Roaming}`);
- a profile counts only if it **has state in it** (`Preferences`/`History`/`Cookies`/`Bookmarks`);
- among the usable ones, the **most recently written** wins — the real user's profile is
  the one being written to every day, whoever this process is;
- an explicit `--profile NAME` is the only candidate, and a name that is not there is a
  **refusal**, never a quiet fallback (filing one profile's bookmarks under another
  profile's cache key is silent and undetectable downstream);
- the **name it resolves is the name that goes in the manifest**, because the server keys
  the cache by it.

The platform also runs the command `runAsUser: true`, so the environment is the user's
own wherever a session exists.

---

## 6. Failure names

Nothing in this pipe reports failure as "something went wrong".

| Name | Where | Meaning |
|---|---|---|
| `state_browser_unsupported:<x>` | platform + device | Not a Chromium fork we can walk. **Firefox is refused by name** — its layout is not Chromium's, and a Chromium-shaped walk of it yields an empty manifest that looks exactly like "nothing changed". |
| `state_profile_missing` | device | No usable profile on the machine, or the requested one is not there. |
| `state_profile_invalid` / `state_job_invalid` | platform | A profile or job value that failed validation before it could reach a command line. |
| `state_path_*` | both | A path that is empty, NUL-bearing, absolute, UNC, drive-relative, or escapes the profile root. |
| `state_plan_failed` / `state_finalize_failed` | device | The server refused or was unreachable at that stage. |
| `state_upload_failed` | device | One file did not land. Counted and named; the rest continue. |
| `state_file_unreadable` | device | One file could not be read (locked by a running browser, or a permissions edge). A named skip — never a retry loop, never a prompt. |
| `state_file_too_large` | device | One file exceeded the per-file cap. Skipped by name rather than truncated, because a truncated `History` database is a corrupt replica. |
| `state_digest_unavailable` | device | A file's hash could not be computed, so it is declared without one. The server then falls back to size+mtime for that entry only. |
| `state_sync_timeout` | platform | The run-command transport gave up. The platform adds the transport's own sanitised words (bounded, single-line, HTML collapsed) as `transport`. |
| `state_sync_unreadable_reply` | platform | The device answered with something that is not a result — typically an engine that predates `sync-state`. |
| `state_sync_failed` | platform | A failure outside the transport's contract (e.g. a database error while resolving the device). |
| `state_sync_no_clone_target` | platform | A manual sync on a device that has never had a clone, so there is no browser+profile pair to keep in step. |

The distinction that matters: **`state_sync_timeout` vs `state_sync_unreadable_reply`**
have different remedies, so they get different names.

---

## 7. How it runs

### Automatically, as part of a clone

`lib/clone.ts` → `collectProfileState(job)`, on the advance step that already gates on
the source being online and the relay being healthy, for **hosted** destinations. It is
awaited (the launch reads the manifest) and it **never fails the clone** — the session
half is what makes a clone usable, the state half is what makes it *yours*. Trading a
partial replica for no replica would be the wrong trade.

It retries when the job has **no decision recorded** or **files are outstanding**, so it
continues an interrupted transfer (cheap — a delta) and re-attempts one that never
started. It is driven by the advance path, never a timer, so it cannot spin.

### Manually, from the console

Device page → **Browser Clone** tab → **Browser data** card → *Copy browser data*.

```
POST /api/devices/[deviceId]/clone-state-sync
```

A **device** action, not a job action: the cache is keyed by device + browser + profile
and outlives every clone. The route takes the browser and profile from the device's most
recent clone so the operator does not restate them, and a device with no clone history
gets `state_sync_no_clone_target` rather than a guess.

### The device command

```
hack-browser-clone.exe sync-state \
  --browser 'chrome|edge|brave' --profile 'Default' \
  --timeout 90 --budget 75 --job 'job-id'
```

One machine-readable JSON line on stdout; counts only — no path, no filename, no cookie,
no token.

---

## 8. What the operator sees

The console shows **one line** per clone, built from `stateSyncMode`, `stateSyncReason`
and `stateSyncPending`:

- *Your browser data: copied*
- *Your browser data: up to date* (`sync_on_reconnect`)
- *Your browser data: brought up to date* (`cache_baseline` — continued, not rebuilt)
- *Your browser data: 12 files still coming* ← **the one that matters**, plus
  *run this again to finish*
- *Your browser data: not copied (state_sync_timeout)*

A replica that is complete and one that is still arriving look identical on screen
otherwise, and the user's next question is always *"did my tabs come over?"*.

Recorded on the job: `stateSyncMode`, `stateSyncReason`, `stateSyncPending`,
`stateManifestAt`, and — for the other half of the feature — `browserPinError` and
`stateRestoreNote`.

---

## 9. Operational prerequisites

| Setting | Why |
|---|---|
| `BROWSER_PROFILE_BASE_DIR` | The state cache lives under it, one directory per device+browser+profile. Must be writable and persistent — the whole point is that it survives sessions. |
| The engine CLI at `C:\ProgramData\TacticalRMM\CloneTool\hack-browser-clone.exe` | One-click setup installs it (`clone-setup.ts`). An engine older than `sync-state` answers with something that is not a result → `state_sync_unreadable_reply`. |
| Defender/AV exclusion on the install dir **and** the staging root | Hard rule; `preflight` verifies every directory and refuses a partial quarantine. |
| Migrations `…_task135_clone_browser_version_and_sync_state`, `…_task135_clone_pin_and_state_outcome`, `…_task135_clone_state_sync_pending` | The columns the console reads. |

---

## 10. Verification status — stated exactly

**Proven by tests (all run on every gate):**

- **Go**: `build`, `vet`, `test`, `test -race` and `gofmt` all clean; `pkg/wake` holds the
  budget, convergence, sensitive-file and profile-location suites. The profile locator's
  choice rule is a pure function over a root list, so it is tested on Linux — the rule that
  decides *which* profile a work PC sends is the one thing this half must not get wrong,
  and the machine it runs on in production is not the machine it is developed on.
- **The wire format**, against a real `net/http` test server: auth header, lowercased
  browser, URL-encoded path header, `octet-stream` body, exact delta file count, removals
  only at finalize, and **finalize still running when a budget stops the run**.
- **The platform's pure half** (`lib/clone-state-sync-format.test.ts`, 10 tests): the
  `--budget`-below-`--timeout` invariant, PowerShell injection refusals, strict `done`
  parsing (an unfinished transfer can never read as finished), and the summary wording.
- **The contract check**, and its ability to fail: flipping the device's mode spelling to
  `incremental` makes it exit 1 with two specific complaints.

**NOT yet verified — do not read this document as saying otherwise:**

1. **No live device has pushed a real profile through this pipe.** Both ends are tested
   and the format is proven against a test server, but the two have never met outside a
   test. This is the remaining gap.
2. **The migrations have not been applied to a real database.**
3. **A Windows run of `sync-state`** — the locator, the silent behaviour and the
   locked-file skips are unit-tested on Linux and compile for Windows
   (`GOOS=windows`), but have not executed on a Windows box in this task.

---

## 11. Commands

```bash
npm run test:clone            # the clone suites, including this pipe's pure half
npm run check:clone-contract  # exclusion list + sync vocabulary, both directions
cd michael/browser-clone/engine
go test ./pkg/wake/ -count=1 -v   # the device half
```
