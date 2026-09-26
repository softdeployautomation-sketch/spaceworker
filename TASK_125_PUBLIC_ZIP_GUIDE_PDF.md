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

```bash
# 1. Vantra FIRST (its own service user!): lib/sw-installer-names.ts + the sw- install-link route, then
#    cd /opt/vantra && sudo -u vantra npm run build && systemctl restart vantra.service
# 2. SpaceWorker: lib/vantra-link.ts, app/api/assistant/vantra/install-link/route.ts, components/device-list.tsx
#    then (from /opt/spaceworker, as trmm): npm run build && systemctl restart spaceworker.service
```

`rsync --exclude='.env'` is mandatory on both (§2). **No `prisma migrate` / `prisma generate` step — no schema
change at all.**

**Owner-only, cannot be verified locally:** that a minted zip actually **contains** `guide.pdf` and that the
launcher **opens** it. `OWN-5` from TASK_121 is still open for the same reason (no Windows run), and this extends
it: the server half is provable with `curl` + an archive listing, the "it opens on the machine" half is not.


