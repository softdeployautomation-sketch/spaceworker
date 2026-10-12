# Which browsers a clone can carry — the whole answer in one place

This is the document to read before answering "can we clone Brave / Edge / Firefox?".
It exists because that question was answered **differently by different layers**: `brave`
was fully implemented in the state pipe and in the device walker while every door into
the feature still refused it, so the capability was real, tested and unreachable — and
nothing reported it. The layers are now compared by `npm run check:clone-contract`, and
this table is the human-readable form of what that check enforces.

## The one distinction everything depends on

A clone **never runs your browser.** It always runs *our* browser — a pinned
Chrome-for-Testing (linux64) build chosen to match the source browser's major version
(`lib/hosted-browser-version.ts`, `lib/clone-browser-pin.ts`). The "browser" you pick is
therefore a statement about **what gets carried**, not about what gets launched.

That splits the work in two, and the two are carried by different routes:

| Half | What it is | How it travels | Needs the source browser to be… |
|---|---|---|---|
| **Session** | signed-in state — cookies | read *inside* the browser over CDP, injected into the clone (`CdpCookies.ps1`) | Chromium |
| **State** | history, bookmarks, open tabs, extensions, settings | the files themselves, walked and posted to the platform (`sync-state`) | Chromium |

Both halves need the same thing (a Chromium profile layout), which is why one list —
`CHROMIUM_BROWSERS` in `lib/clone-browsers.ts` — decides both. Everything else follows
from it.

## The matrix

| Layer | Chrome | Edge | Brave | Firefox |
|---|---|---|---|---|
| Clone can be **requested** (`lib/clone-browsers.ts`: `CLONE_BROWSERS`) | ✅ | ✅ | ✅ | ✅ |
| Console picker (`components/device-console.tsx`) | ✅ | ✅ | ✅ | ✅ offered, honest |
| Profile **state** carry (`engine/pkg/browser/walkable.go`, `STATE_SYNC_BROWSERS`) | ✅ | ✅ | ✅ | ❌ `state_browser_unsupported` |
| Session **cookies** (`CdpCookies.ps1`, `Get-ChromiumUserDataRoot`) | ✅ | ✅ | ✅ | ❌ |
| ↳ the **gate** that decides whether to capture them (`ProfilePaths.ps1`) | ✅ | ✅ | ✅ ⚠️ *was ❌ until 2026-09-30 — see below* | ❌ |
| Destination **build** (`hosted-browser-version.ts`: Chromium family) | ✅ | ✅ | ✅ | ❌ |

⚠️ The row above is the one that lied. Every layer that *could* move Brave's cookies
supported Brave — the CDP module's `ValidateSet`, the `User Data` map, the version
reader — but the branch that decides to *attempt* the capture tested
`@('chrome','edge')`. So a Brave clone walked its profile, carried its history,
bookmarks and tabs, **skipped its session, and reported exit code 0**: a clean-looking
clone with no logins. The matrix said ✅ because the components did support it; the
*composition* did not, and nothing was checking the composition.

### One list, or it will disagree with itself (2026-09-30, the Brave cookie bug)

The same lesson as the `User Data` map above, one layer further in. The cookie branch in
`Invoke-CaptureFromDir` and the import branch in `Invoke-Restore` each wrote the browsers
out **inline**, and they had already drifted apart:

```
capture:  @('chrome', 'edge')            ← Brave excluded, silently
restore:  @('chrome', 'edge', 'brave')   ← Brave included, so it was ready for cookies
                                             that the capture never sent
```

Both branches now read ONE script-scope constant, `$script:CarriableBrowsers`, and
`check:clone-contract` fails if a browser list is ever written inline at a call site
again. The reason that check had to be added rather than a `ValidateSet` scan extended:
a `ValidateSet` is part of a *parameter*, and this bug lived in the *body* of a function,
where no parameter scan can see it.

The verification for this is in the two places that could each catch it independently —
the contract check (static) and `tests/Test-Roundtrip.ps1` §4g (behavioural, on a real
capture) — and both were confirmed by re-introducing the bug and watching each fail.

### Chrome, Edge, Brave — fully carriable

All three are Chromium: the same `User Data`/`Default` layout the device walks, the same
cookie story, the same `Last Version` version convention the destination pin reads. They
differ only by root directory, and that root comes from ONE map
(`$script:ChromiumUserDataSubdirs` in `lib/ProfilePaths.ps1`) rather than from `if/else`
chains — a third browser resolving silently to Edge's directory would have carried
another browser's history with every exit code still 0.

### Firefox — never "carried", still cloneable as a FRESH session

Firefox is a different browser, not a missing flag: no `User Data`/`Default`, no
`Preferences`, no sqlite `History` at the path the walker asks for, and cookies in a
different store entirely.

A Chromium-shaped walk of a Firefox profile yields **nothing**, and nothing is
indistinguishable from "your profile has not changed" — so every layer refuses it **by
name** rather than reporting an empty profile:

- the device walker refuses it as a set-membership test, not `== "firefox"`, so a typo
  or a future browser gets the same honest answer (`state_browser_unsupported`);
- the wire vocabulary (`STATE_SYNC_BROWSERS`) does not contain it, so the platform never
  asks a device for something that cannot answer;
- the orchestrator refuses `live` + Firefox before a job row exists
  (`lib/clone.ts`, `browser_not_supported`), and the console says so **before** the click.

What you get instead is a legitimate product: a **fresh** clone that signs in for itself.
The console disables "Carry my session" for Firefox, and picking Firefox moves the form
back to `fresh` rather than leaving an impossible pair selected.

## What "clone a browser" cannot mean, and why (the boundary)

Cookies are **not** carried as files for Chrome/Edge/Brave on Chrome 127+. App-Bound
Encryption ties the cookie key to the browser that wrote it, so a copied profile gets its
cookies dropped — deliberately, and silently, by the browser. That is the entire reason
the session half is captured *inside* the browser over CDP instead. Version pinning does
not change this; it exists for the **file** half (so Chrome accepts the profile and the
extensions load) and to make the clone *look* like the same browser.

## How this stays true

`npm run check:clone-contract` parses the real sources and fails on drift:

- `lib/clone-browsers.ts` `CHROMIUM_BROWSERS` ↔ `lib/clone-state-sync-format.ts`
  `STATE_SYNC_BROWSERS` ↔ `engine/pkg/browser/walkable.go` — **must be equal**, because a
  browser the platform asks for but the device cannot walk produces a lie, not a crash;
- `CdpCookies.ps1` and `Get-ChromiumUserDataRoot` — **must be Chromium-only** (the cookie
  read and the `User Data` root have no Firefox branch);
- `Get-BrowserProfileDir` and `Invoke-BrowserClone.ps1` — **must accept every requestable
  browser**, because refusing a profile path for a browser the picker offers is a door
  that opens onto a wall;
- `CLONE_BROWSERS` must be built from both halves, or a browser would be pickable in the
  console and refused by everything behind it;
- `$script:CarriableBrowsers` in `lib/ProfilePaths.ps1` and the `$script:ChromiumUserDataSubdirs`
  map's **keys** — **must be the carriable set**, because these are the lists the
  capture/restore branches and the `User Data` lookup actually read;
- **no browser list may be written inline at a call site again** — the exact shape of the
  2026-09-30 bug, and invisible to a `ValidateSet` scan because it lived in a function
  *body*. Comments are stripped first, because that file's comments quote the buggy
  literals on purpose to record why the constant exists.

The check reports drift by file **and function** (a per-file rule cannot be right about
both `Get-ChromiumUserDataRoot` and `Get-BrowserProfileDir`), and each of the six cases
above is verified by sabotage runs — see `STATE-PIPE.md` §10 for the evidence list.

The two PowerShell cases get a **second, behavioural** guard, because a static scan proves
the list is *written* right and not that it is *used* right:
`npm run test:ps` runs `tests/Test-Roundtrip.ps1` (whose §4g captures from a synthetic
profile as Brave and asserts the cookie branch was reached), plus the silent-trigger and
cookie-capture harnesses. That runner is now a CI step; before 2026-09-30 these suites
were hand-run on Windows only, because without a job key they seal with DPAPI, which
cannot run off Windows — so CI could not execute them and quietly did not. `test:ps`
supplies a random key per run to take the platform-independent AES-256-GCM path, and
**fails the step if a suite passes while asserting too little**.
