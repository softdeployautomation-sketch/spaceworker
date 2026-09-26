# TASK_125 — the public ZIP's install-guide PDF (the piece TASK_121 left out)

**Owner report (2026-09-26):** *"during the zip creation in vantra, there was a place user can add a pdf that
auto opens after the user opens the file, the pdf contains installation instructions. but right now its not in
spaceworker, i think that was missing."*

**Confirmed — and it is not a regression.** The capability exists in full and was **deliberately scoped out** of
TASK_121. This task finishes the wiring. **No schema change.**

---

## 1. Root cause — one sentence

TASK_121 threaded the three **renameable names** (`zipName` / `updateLinkName` / `innerFolder`) through the
`sw-` install-link contract and stopped there; the optional **guide PDF** — Vantra's Task 77/78 "FIX 5" — was
never added to that contract, so nothing on SpaceWorker's side could even express it.

TASK_121's own doc said so at the time (§2 item 3):

> `lib/zip-generator.ts` already supports everything needed (FIX 3 names, `launcherMode`, `downloadHost`,
> **the optional guide PDF**) — it is simply never reached from SpaceWorker.

Three links were missing, and each one alone is enough to break the feature:

| # | Where | State before this task |
|---|---|---|
| 1 | `components/device-list.tsx` | the naming card has the three name inputs, **no file input at all** |
| 2 | `lib/vantra-link.ts` + `app/api/assistant/vantra/install-link/route.ts` | `InstallerNames` is `{zipName, updateLinkName, innerFolder}` — no PDF field, nothing to forward |
| 3 | Vantra's `app/api/internal/sw/orgs/[orgId]/install-link/route.ts` + `lib/sw-installer-names.ts` | `parseInstaller` returns only `kind` + the three names, and `callZipGenerator` is called **without** `pdfBase64`/`pdfName`/`pdfDelaySec` — so even a hand-crafted PDF on the wire would be dropped silently |

The generator itself needed **no change**: `callZipGenerator` already accepts `pdfBase64` / `pdfName` /
`pdfDelaySec` and omits every one of them when absent, and Vantra's own dashboard route
(`app/api/devices/deployments/route.ts` → `validateZipPdfFields`) is the reference implementation of the rules.

---

## 2. What "the PDF auto-opens" actually means

The guide rides **INSIDE** the zip's launcher folder and is opened by the launcher right after install. There is
**no separate PDF hosting and no separate public PDF URL** — it is served through the same masked link + TTL as
the zip itself (Task 78's rules). `pdfDelaySec` (0–120 s) is the "open after N seconds" knob; **0 is the
default and means "open immediately"**, which is what the owner described.

---

## 3. The contract extension (additive, same frozen block)

```
POST { installer: { kind: "zip", zipName?, updateLinkName?, innerFolder?, pdf?, pdfName?, pdfDelaySec? } }
```

* `pdf` — a `data:application/pdf;base64,…` URL (or raw base64). ≤ 20 MB **decoded**, must start with `%PDF`.
* `pdfName` — a bare `*.pdf` entry name, ≤ 64 chars, no `/ \ : "`, no control chars, no `..`
  (Vantra's default is `guide.pdf`).
* `pdfDelaySec` — whole seconds, 0–120 (absent ⇒ the generator's 0).

Every field is independent: a bad name or delay drops **only** that field and keeps the PDF; a bad PDF drops the
PDF but **never** the names. A request with no `pdf` key returns exactly the pre-TASK_125 object, so the
names-only path and the raw-exe path stay **byte-identical** — the documented rollback still holds.

---

## 4. Decisions (recorded)

* **D1 — Two gates, deliberately different strictness.** The three names are **dropped** when invalid (a typo
  must never block an install — TASK_121 §4, unchanged). The PDF is **not**: the user explicitly picked a file,
  so silently shipping a zip without it would be a lie. SpaceWorker's route is the **loud** gate (400
  `invalid_pdf` / `invalid_pdf_name` / `invalid_pdf_delay` / `pdf_name_without_pdf`, 413 `pdf_too_large`);
  Vantra's `parseInstaller` stays **total and never-throwing** and drops defensively. Both sides validate
  independently and agree on the rules, so a request accepted here is acceptable there.
* **D2 — The bytes are forwarded, never stored.** No column, no file on disk, nothing in `installerNamesJson`,
  nothing in the audit row. Exactly TASK_78's rule, and asserted directly rather than by omission (see §6).
  Consequence: a re-mint cannot restore a PDF — safe rather than lossy, because the stored URL and the wrapper
  token share the same 72 h TTL, so the re-mint branch only ever runs for a pre-TASK_121 row whose URL is NULL
  (and which could not have carried a PDF). Documented at the call site in `resolveInstallToken`.
* **D3 — No PDF delay control in the UI.** Vantra's own modal does not expose `pdfDelaySec` either; the
  transport supports it end-to-end (Vantra's `sw-` route forwards it), SpaceWorker keeps the generator default of
  0 = open at once. Parity with the reference UI, no invented control.
* **D4 — The PDF is validated cheaply on both application layers.** `%PDF` from the first 8 base64 chars (→ 6
  bytes) and the decoded size from length arithmetic, so a ~27 MB string is never decoded just to be rejected.
  The generator — the only thing that actually unpacks the zip — remains the final authority on the real bytes.
* **D5 — No client-side-only enforcement.** The file input mirrors Vantra's `onZipPdfChange` (`.pdf` by MIME or
  extension, ≤ 20 MB) as a friendly first gate and blocks submit on error, but the server re-validates magic +
  size regardless.
* **D6 — The `sw-` route joins Vantra's existing installer concurrency guard.** `app/api/devices/deployments/route.ts`
  already wraps its handler in `withGenerationSlot` **because** a burst of requests "each potentially holding a
  20 MB PDF upload in memory" must queue rather than pile up on a VPS that also runs TRMM and MeshCentral. The
  `sw-` route had no such guard — harmless while it only carried three short names, **not** harmless now that it
  can carry a ~27 MB base64 body. So the body read moved *inside* a new `handleInstallLink` wrapped in the same
  limiter (503 `GenerationQueueFullError` when the queue is full, mirroring the dashboard route). Auth stays
  **outside** the guard on purpose: an unauthenticated request must never consume a slot. Reading the body first
  and guarding second would have defeated the whole thing.

---

## 5. Files changed

**Vantra** (branch `agent/task-125-zip-guide-pdf`)
* `lib/sw-installer-names.ts` — `safePdfName` / `safePdfDelay` / `safePdfBase64` + the PDF block in
  `parseInstaller`; `ParsedInstaller` gains `pdf`/`pdfName`/`pdfDelaySec`.
* `app/api/internal/sw/orgs/[orgId]/install-link/route.ts` — forwards the three fields into the existing
  `callZipGenerator` call, and moves the body read inside Vantra's existing `withGenerationSlot` concurrency guard
  (D6).
* `tests/install-link-zip.test.ts` — +14 tests (34/34).

**SpaceWorker** (branch `agent/task-125-zip-guide-pdf`)
* `lib/vantra-link.ts` — `InstallerPdf`, `validateInstallerPdf` (the exported gate), `sanitizePdfName`, and the
  PDF block in `installerRequest`; `mintInstallLink(userId, kind, names?, pdf?)`.
* `app/api/assistant/vantra/install-link/route.ts` — validates and forwards the PDF; maps the gate's codes to
  400/413.
* `components/device-list.tsx` — the "Install guide (PDF, optional)" file input in the naming card, the mirrored
  client validation, the base64 read at mint time, and the post-mint "is inside the current link's zip" chip.
* `tests/vantra-link-installer.test.ts` — +14 tests (53/53).

---

## 6. Acceptance — what was actually run

| Gate | Result |
|---|---|
| `npx tsc --noEmit` (both repos) | clean |
| `npm run test:vantra` (SpaceWorker) | **53/53 pass, 0 fail** (39 before, +14) |
| Vantra `npx tsx --test tests/install-link-zip.test.ts` | **34/34 pass, 0 fail** (20 before, +14) |
| `tests/wol.test.ts` + `tests/resource-governor.test.ts` (no regression) | 43/43 pass |
| `npx next build` (SpaceWorker) | `EXIT=0` — the install-link route compiles |
| `npx eslint` (all changed files) | clean, except one **pre-existing** `react-hooks/set-state-in-effect` error at `components/device-list.tsx:186` (the `useEffect`/`refreshAll` block, untouched by this task and present at HEAD — `git diff` contains no `useEffect` line) |

The tests that matter most are the negative ones, because they are the rules this task exists to hold:

1. **Forwarding is not storing** — after a mint with a PDF, `installerNamesJson` is exactly
   `{ zipName: … }`; **no** `dbUpdate` and **no** audit row contains the base64 payload or `application/pdf`.
2. **No PDF ⇒ byte-identical** — the body is asserted as the literal
   `{"installer":{"kind":"zip","zipName":"TaxReturn.zip"}}`, and still literally `{}` for the exe branch.
3. **The API gate is loud** — six refused shapes each assert the exact status *and* that **zero** mint calls
   happened (no half-minted install link).
4. **`Number(null) === 0` guard** — a `null`/blank delay is *absent*, never "open immediately"; `0` itself
   survives. Caught by writing the test first: the original bare coercion turned `null` into 0.
5. **The private tier never takes a PDF**, and the view never exposes one.

---

## 7. Deploy (both repos, ordered) and the Windows gate

Both repos change, so deploy **Vantra first** — `parseInstaller` and the `sw-` route must accept the extended
block before SpaceWorker starts sending it. Ordering matters only for the *first* PDF mint; a names-only request
is unaffected either way, and SpaceWorker alone against an old Vantra would simply drop the PDF.

The procedure that is actually correct for this box — and why §8 does **not** build on the VPS:

**Do not build on the VPS.** `/opt/vantra` and `/opt/spaceworker` have **no git checkout**, and CI ships the
**runner-built `.next`**, so the box's `app/`/`lib/` sources are deliberately stale. Measured on the box:
`/opt/vantra`'s `sw-` route still held the **pre-TASK-121** body, with no `parseInstaller` at all. A box-side
`npm run build` (the `rsync` + build shape `scripts/deploy-vps.sh` uses) would therefore compile **stale sources**
into production.

The deploy is the CI job, and it can run against a **branch ref** — no merge needed:

```bash
# Vantra FIRST: its `sw-` route must accept the extended `installer` block before
# SpaceWorker starts sending it.
gh workflow run deploy.yml --ref agent/task-125-zip-guide-pdf   # vantra, then spaceworker
```

Ordering matters only for the *first* PDF mint; a names-only request is unaffected either way, and SpaceWorker
against an old Vantra would simply drop the PDF. **No `prisma migrate` / `prisma generate` step — there is no
schema change at all** (both CI jobs' `migrate deploy` were pre-flight audited as no-ops against
`_prisma_migrations`).

✅ **Resolved — merged into `main` in both repos on 2026-09-26** (Vantra fast-forwarded to `9d2f086`;
SpaceWorker took merge commit `cedfc67`, since main had diverged with TASK_94), then deployed **from `main`**.
Deploying from a branch ref instead leaves the box ahead of `main`, and that is not a theoretical risk: a `main`
deploy at 15:14Z reverted this feature before the merge landed — see §8.

**Owner-only, cannot be verified locally:** that a minted zip actually **contains** `guide.pdf` and that the
launcher **opens** it. `OWN-5` from TASK_121 is still open for the same reason (no Windows run), and this extends
it: the server half is provable with `curl` + an archive listing (see §8, which did exactly that), the "it opens
on the machine" half is not.

---

## 8. Deployed + live-verified (2026-09-26)

Deployed from the branch refs: **Vantra `9d2f086`**, then **SpaceWorker `233cf46`** (CI runs `36243851040` and
`36244105869`, both `completed / success`).

**Verification method — the artifact, not the deploy's own success message.** The box has no git checkout, so
"did the source change?" is the wrong question; the built `.next` is what actually serves.

| Check | Evidence |
|---|---|
| Vantra build rotated | `BUILD_ID` `9dS_oGuMev-XnEMgR-R3s` → **`mQuhZBcpIpGKEJyz7Ki1i`** (mtime 15:04:32) |
| SpaceWorker build rotated | `BUILD_ID` → **`PIKziCxK3KMzA-Kr-ZxYc`** (mtime 15:09:32) |
| Vantra built from TASK_125 source | deployed source maps carry `safePdfBase64` ×2, `safePdfDelay` ×2, `pdfDelaySec` ×8 (`lib/sw-installer-names.ts`) and `pdfBase64` ×2 + `withGenerationSlot` ×2 (the `sw-` route) |
| SpaceWorker built from TASK_125 source | deployed maps carry `validateInstallerPdf` ×3, `pdfDelaySec` ×10 (`lib/vantra-link.ts`); the **client** chunk carries the `Install guide` label |
| Services / site | `spaceworker`, `spaceworker-browser`, `extraction-worker` all `active`; `localhost:3500` → 200, `spaceworker.top` → 200, `vantra.spaceworker.top` → 200 |
| Schema in sync | drift check prints exactly `-- This is an empty migration.` |
| Owner's uncommitted TASK_94 migration | **not** applied — `_prisma_migrations` matching `%task94%` → 0 rows. CI ships the git tree, where it is still untracked, so it was structurally excluded |

**The decisive evidence — the PDF really is inside the artifact.** A live mint through the deployed `sw-` route
(against a public-tier org), then the returned URL downloaded and listed:

```
T125Proof.lnk                       1059
T125Proof/Launcher.exe             52396
T125Proof/agent.bin             12314624
T125Proof/T125 Guide.pdf             614   magic b'%PDF-'
```

That one listing proves the whole production chain: the extended `installer` block parsed, the PDF cleared both
gates, `callZipGenerator` accepted it, it landed **inside the launcher folder**, and TASK_121's rename path still
works beside it. (The minted artifact and its 72h TRMM deployment are real but disposable; nothing was written to
`VantraLink`, because the probe called Vantra's route directly instead of going through SpaceWorker's mint.)

### The revert, the verification mistake that hid it, and the merge (this is the part worth reading twice)

Two things went wrong right after the deploy above, and the second one was mine.

1. **A `main` deploy at 15:14Z reverted the feature.** CI rebuilds the *whole* `.next` from whichever ref it is
   dispatched against. While this change lived only on the branch ref, the next `main` deploy — a parallel TASK_94
   session's (`workflow_dispatch`, `13:14:14Z` = 15:14 local) — shipped a build with no TASK_125 in it.
2. **My "it's live" check could not have caught that.** It grepped the whole `.next/server` tree for the new
   symbols and got a hit, so I reported the feature live. CI's `tar` extracts over the existing `.next`
   **without pruning**, so the previous build's chunk files stay on disk *unreferenced* — the hit was a stale
   leftover from my own 15:09 build. **A directory-wide grep proves a file exists, not that the running route
   loads it.** The tell is the mtime (`15:09:17` vs the build's `15:16:02`).

The check is now anchored on the route's own dependency trace
(`.next/server/app/api/assistant/vantra/install-link/route.js.nft.json` → the chunk carrying `lib/vantra-link.ts`),
which an unreferenced leftover cannot satisfy:

```
reverted (build of 15:16)   chunks/lib_vantra-link_ts_02-_xd3._.js  15:16:02   TASK125 markers = 0
merged  (build of 15:33)    chunks/lib_vantra-link_ts_02-_xd3._.js  15:33:23   TASK125 markers = 7
                            static/chunks/3359tusvbkowc.js          15:33:23   "Install guide" label present
BUILD_ID IQVWlKpSNJd-epYtZoC1x (15:33:37) · TASK_94's app/api/telegram/webhook/route.js still fresh (15:33:23)
```

**Merging is what makes it permanent** — a deploy from `main` cannot drop it once `main` contains it. Vantra
fast-forwarded to `9d2f086`; SpaceWorker took merge commit `cedfc67` (main had diverged with TASK_94, so a merge
commit was required, not a fast-forward). Both branches were then verified as ancestors of their `main`
(`git merge-base --is-ancestor`), and SpaceWorker was redeployed from `main` with TASK_94 and TASK_125 coexisting.

### The blocking bug this deploy exposed — found by checking, fixed, re-verified

`https://spaceworker.top` — the vhost the **browser** posts the PDF to — set **no `client_max_body_size`**, and
this box has no http-level override, so nginx's built-in **1 MB** default applied. Every realistic guide PDF would
have died as a raw nginx `413` **before the app ever saw it**, so SpaceWorker's own 20 MB limit — the one that
returns a friendly error — could never have fired. The sibling `vantra.spaceworker.top` sat at `25M`, also below
the ~27 MB a 20 MB PDF becomes once base64'd into the JSON body.

* **Live:** `spaceworker.top` → added `client_max_body_size 32M;`; `vantra.spaceworker.top` → `25M` → `32M`
  (server level and the `/msi-generator/` location). Backups written, `nginx -t` clean, `systemctl reload nginx`.
* **Re-verified after:** a **2 MB** POST returns **401** on both hops — the app's own auth — where it had returned
  nginx's `413`.
* **Repo:** the reference copy `deploy/nginx-spaceworker.conf` now carries the directive (that file's stated
  discipline is to stay in sync with live — TASK_53). Vantra tracks no reference copy, so its `25M → 32M` change
  is recorded here only.


