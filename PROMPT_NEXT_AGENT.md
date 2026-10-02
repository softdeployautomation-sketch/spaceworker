# PROMPT — NEXT SENIOR AGENT (D2 / Task 156 "Cyber Lab, real-world" — **C0 → C1 ONLY**)

> **Self-contained, copy-paste prompt.** Paste the `TASK BLOCK` below into the next senior agent.
> It **supersedes** the D1 instantiated prompt in `PROMPTS_SENIOR_ENGINEERS.md` §"Owner-requested design
> work", which still says "START D1 AT P2" — **stale: D1 / Task 155 P1 + P2 + P3 are built, deployed and
> LIVE** (see VERIFIED STATE + the P3 record at the bottom of this file). Everything the agent needs is
> in this file plus the docs it names.
>
> **D1 is CLOSED** (`bb6ff6c`, build `LjgrTG69r2eiN-w07Hj-i`, run `36966548887`).
> **This run is D2 / Task 156, phases `C0` then `C1` ONLY** — it owns the owner's A13 and picks up exactly
> where the D1 agent stopped, per the owner's standing instruction: *"read this file end to end … and when
> P3 is committed/deployed/reported, continue straight into D2 / Task 156 C0→C1."*
> **C2+ is a SEPARATE assignment** — do **not** scan, spoof, or fire anything.


---

## TASK BLOCK (paste from here)

```
TREE:            /Users/mikeolab/spaceworker           (branch: main)
TASK:            D2 / Task 156 - "Cyber Lab, real-world": offensive + defensive tooling that meets
                 TODAY'S attacks (simulate all kinds of emails / DNS / server attacks, research),
                 built on the Linux box, EASY for users and POWERFUL, with the end-to-end
                 simulation running on the USER'S OWN VM (SpaceWorker authors it).
                 YOU START AT:  C0 (AUP/consent text) then C1 (schema + gate + staff badge +
                 admin limits + LabToolCatalog + the read-only Research admin page) ONLY.
                 C2+ is a separate assignment - do NOT start it.
TASK DOC:        PLAN_TASK_156_CYBERLAB_REAL_WORLD_TOOLS.md   read section 12 FIRST (owner
                                                              addendum 2026-10-02 - BINDS the lab:
                                                              research gate 12.1, email 12.2, DNS
                                                              12.3, server 12.4, on-your-VM 12.5,
                                                              UX 12.6, Linux charter 12.7, phasing
                                                              impact 12.8), then 2 (exists vs lack),
                                                              3 (rails shared with 155), 4 (where the
                                                              machines are), 5 (matrix + the abuse
                                                              sentinel 5.2), 6 (schema draft),
                                                              7 (phasing C0-C6), 8 (how we prove
                                                              "not simulation"), 10 (the 5 open Qs).
                 SENIOR_HANDOFF.md                            section 5 (traps - esp. 3, 7, 15, 16,
                                                              22), section 6 (current state), 8, 9,
                                                              10.
                 PLAN_TASK_155_WORKERS_AND_PAGES.md           section 16.6 + section 14 (the CAP
                                                              MECHANISM you MUST reuse - see
                                                              NON-NEGOTIABLE).
                 PROMPT_NEXT_AGENT.md                         this file (current state + asks).
DEPENDS ON:      D1 / Task 155 P1 + P2 + P3 are DONE, DEPLOYED and LIVE (`bb6ff6c`, build
                 `LjgrTG69r2eiN-w07Hj-i`). The BINDING D2 spec is PLAN_156 section 12. The owner's
                 answers to PLAN_156 section 10 (the 5 open Qs) cover the SHAPE of the lab; anything
                 not answered there that would change C1's schema/gate - ASK THE LEAD BEFORE YOU
                 COMMIT IT. C1 is otherwise UNGATED.
BRANCH:          main
DEPLOY?          C0 = docs + a screen only, NO deploy. C1 = schema + gate + staff badge + admin
                 limits + LabToolCatalog + read-only Research admin page: ADDITIVE + NULLABLE,
                 deployable via deploy.yml in-window exactly as D1's P3 deploy was (follow
                 SENIOR_HANDOFF section 9 verbatim: dispatch, verify BUILD_ID, grep the BUILT
                 chunks under /opt/spaceworker/.next/static - components/ and lib/ are NOT
                 shipped). C2+ (anything that actually attacks a host) = LEAD decision, on a

## OWNER'S ASKS (these BIND; do not re-litigate)

```
A1  "the cyberlab and workers should be added to the menu and dashboard cards"
      ->  DONE in D1-P2 (Hosting + Cyber Lab nav items AND dashboard cards are live). PROVE
          they are still there; do NOT rebuild them.
A2  "go ahead with deploy ... flip it when we deploy and we test to see how it works"
      ->  DONE in D1-P2 (hostingEnabled=true, live). Keep it live. Cyber Lab stays dark until C1
          flips cyberlabEnabled at the END of this run (behind the AUP gate).
A3  "go ahead with the ssh to get the nginx you need"
      ->  AUTHORISED. Use SSH (`ssh -i ~/.ssh/tacticalrmm_vps root@164.68.105.96`) for any infra
          this run needs (env vars; a preview/lab `location`). D1-P2 added `location /hf/` on
          dl.instaweb.top and D1-P3 added the /pv/ + /hs/ app routes - do not disturb them.
A4  "we need both options available and an option for users to add their own cf tokens and id"
      ->  DONE in D1-P2/P3 (PLATFORM + BYO credential store, section 16.4 chooser, fail-closed
          verify). NOT this run.
A5  "if users add multiple like 3, we should be able to switch between them ... lets start with one"
      ->  DONE in D1-P2 (multi-credential store). NOT this run.
A6  "use the throwaway cf acct for p3"
      ->  DONE in D1-P3 (throwaway account is the platform default). NOT this run.
A7  "you can add the cyberlabs cap to admin"
      ->  D1-P2 added the first Cyber Lab RAM dials (admin route + panel). THIS run adds the Lab*
          cap family for C1 (the sentinel dials) using the SAME mechanism - do not re-do the
          existing dials.
A8  "if its going to take a lot of ram ... we need every hard load monitored and queued
      properly, so the governor can also adjust ... lets build first, and when we are done, we
      will update the governor"
      ->  STILL TRUE. Do NOT edit lib/resource-governor.ts. Every heavy-load dial is an
          AdminSetting field (155 section 14 rule 1), and you RECORD metrics/dials only.
A9  "for now we dont need converters, just the rename of file upload is enough for file store"
      ->  CONVERTERS ARE OFF (155 section 16.5). Do NOT install sharp / ffmpeg / libreoffice /
          ImageMagick. Still true.
A10 "no option to upload folder and we extract and push to preview first and then live"
      ->  DONE in D1-P3 (folder/zip -> 7z extract -> /pv/<token>/ preview -> Publish -> /hs/<token>/).
          NOT this run.
A11 "option to switch between the server and the premium"
      ->  DONE in D1-P3 (per-site engine picker; explicit migration, never a silent fallback).
          NOT this run.
A12 "nothing that using premium is capped"
      ->  DONE in D1-P3 (premium has its OWN cap family, admin-editable, enforced server-side).
          NOT this run.
A13 (NEW 2026-10-02) Cyber Lab must meet today's hacker world (simulate all kinds of email / DNS /
    server attacks, research, Linux tooling, run the simulation on the USER's own VM, created from
    SpaceWorker)
      ->  THIS RUN. It is D2 / Task 156. Build spec = PLAN_TASK_156 section 12 (BINDING). Phases
          C0-C6; YOU DO C0 then C1 ONLY.
```

                 NON-production host, NEVER the prod VPS.
```

## VERIFIED STATE AT HANDOFF (read this before you touch anything)

**D1 / Task 155 — CLOSED. P1 + P2 + P3 are built, proven, pushed, DEPLOYED and LIVE.**
`main` @ **`bb6ff6c`**, deployed build **`LjgrTG69r2eiN-w07Hj-i`** (`BUILD_ID` mtime
`2026-10-02 06:56:12 CEST`), deploy run **`36966548887`**. All three hosting migrations are applied to
production. `AdminSetting.hostingEnabled = true`; `cyberlabEnabled = false` (dark — C1 flips it at the end).

- **P1 — `a131835`** — FILES engine on our own metal: `/hf/<token>` upload/list/rename/delete behind the
  new `hosting` entitlement; rename rewrites only `dispositionFilename`+`mime` so **sha256 is provably
  unchanged**.
- **P2 — `435d419`** — user-owned redirects (`/r/<slug|token>`), the BYO credential store
  (`HostingCredential`, AES-256-GCM via `lib/mailbox-crypto.ts`, 4-char hint only), and the Cyber Lab
  nav/card/panel + the first admin RAM dials. `HOSTING_PUBLIC_BASE_URL=https://dl.instaweb.top` with the
  `dl.*` nginx `location /hf/` proxy, proven live.
- **P3 — `bb6ff6c`** — the **Pages engine**: `cloudflare` implemented (raw REST Direct Upload), and the
  **folder/zip → `7z` extract → PREVIEW (`/pv/<token>/`) → PUBLISH (`/hs/<token>/`)** flow; the per-site
  engine picker ("Our server (free)" vs "Premium (Cloudflare)"); the **section 16.4 account chooser**
  (platform + BYO, verify-on-save); the `hostingPremium*`/`hostingMaxZip*` cap family; a per-user job lock
  + recorded metrics. **Additive** migration `20261029000000_task155_p3_pages_sites`. `test:hosting`
  **39/39** incl. the new `tests/hosting-pages.test.ts` (drives a **real `7z`** binary). New **trap 22**:
  `7z l` prints an archive header block that is not an entry — the real-archive test caught the bug a
  hand-typed fixture had hidden.

**Live right now (proved this session on `spaceworker.top`):** `/` → **200**; `/dashboard/hosting` →
**307** (auth); `/api/hosting/sites` → **401** (auth-gated route exists); `/pv/<bad>` and `/hs/<bad>` →
**404** (the new public handlers exist, no 500). On the VPS: `prisma migrate status` → *"Database schema
is up to date!"*; `_prisma_migrations` shows the P3 migration; `pg_tables` shows `HostingSite`/
`HostingRevision`/`HostingJob`/`HostingCredential`/`HostingUsageMonthly`; `systemctl --failed` → **empty**;
`spaceworker`/`spaceworker-browser`/`extraction-worker` all **active**.

**What is NOT done (YOUR JOB — this is D2 C0 → C1):**
1. **The Cyber Lab does not exist as a product.** No AUP/consent screen, no consent record, no gate.
2. **No `Lab*` schema** — `PLAN_156` section 6 (the draft) has never been applied; no migration exists.
3. **No `LabToolCatalog`** — there is no catalogue of capabilities (ATT&CK id, last-reviewed, upstream
   version, CVE history, licence, `staleAfter`).
4. **No Research admin page** (read-only feeds only — it does NOT run an attack).
5. **No staff badge** and no `Lab*` admin limits beyond D1-P2's RAM dials.
6. **`cyberlabEnabled=false`** — the nav item + card + panel are dark on purpose. C1 flips it at the END,
   **behind the AUP gate**, never before.
7. The governor knows **nothing** about lab RAM (A8 — deliberately deferred). **Record dials only.**

**D1's remaining honest gaps (NOT yours to close, do not re-claim them as done):** the production *write*
path for hosting (create site → zip → preview 200 → publish → live 200) has **not** been run by hand on
prod; the **premium/Cloudflare** leg ran against the **throwaway** account only; `external` storage engine is still registered-not-implemented. See `SENIOR_HANDOFF.md` section 6.4.
## DO IT IN THIS ORDER — do not skip a step

1. **REPRODUCE FIRST.** Before changing a line, prove the **absence** with raw output:
   - `GET /api/cyberlab/status` (authenticated) → the lab reports dark (`cyberlabEnabled:false`), no
     `LabToolCatalog`, no consent gate.
   - `grep -rn 'LabToolCatalog\|LabConsent' prisma/schema.prisma` → **no matches** (no `Lab*` schema).
   - the nav item + card + panel exist (A1) but there is **no AUP screen and nothing is gated**.
   Paste the raw output.
2. **READ PLAN_156 section 12 FIRST** (it binds the lab), then sections 2/3/4/5/6/7/8/10. If you disagree
   with any of it, say so with evidence — do not silently work around it.
3. **C0 — write the AUP + LabConsent text** as a repo doc **and** a screen that gates the lab; record the
   acceptance. Nothing runs before it exists.
4. **C1 — build the gate + schema + badge + limits + catalogue + Research page.** Reuse the 155 §14 cap
   mechanism (named `AdminSetting` fields, server-enforced, admin-editable, shipped with defaults) and the
   existing `cyberlab` entitlement key. One **additive** migration. Smallest correct diff per file; match
   the neighbours' conventions (read `lib/entitlements.ts`, `lib/admin-settings.ts`, `lib/hosting/rules.ts`
   and an existing `app/api/admin/*` route first).
5. **PROVE IT PASSES — same command, raw output, before AND after:**
   - `npx tsc --noEmit` → exit 0
   - `CI=1 npx next build` → success
   - every `test:*` suite that touches what you changed (CI does NOT run `test:*` — you must). Add a
     `tests/cyberlab-*.test.ts` for the gate + the `staleAfter` hiding. A check that cannot fail is not
     evidence.
6. **PROVE IT VISIBLY.** With a real browser (Playwright is installed) show: the AUP screen blocks the lab
   until accepted; after accepting, the panel opens; the staff badge shows; and a live admin PATCH flips a
   `Lab*` limit **without a redeploy** (same proof pattern as the hosting caps). A green build that changed
   nothing the user can see is the exact failure that produced TASK_153.
7. **BROKEN-NOTHING CHECK.** BEFORE and AFTER, `curl` the live `/e/...`, `/downloads/...`, an existing
   campaign `/r/<token>` redirect, and the D1 `/hf/<token>` + `/pv/<token>/` + `/hs/<token>/` paths —
   identical behaviour. Run every `test:*` suite that touches what you changed.
8. **COMMIT** — explicit paths only, never `-A`, never `.`:
   `git add <path1> <path2> ...` → `git commit -m "feat(cyberlab): Task 156 C0+C1 - AUP consent gate, Lab* schema, staff badge, LabToolCatalog, read-only Research admin"` → `git push origin main:main`.
9. **DEPLOY** — **C1 only** (C0 is docs + a screen; deploy after C1 is green). Follow handoff section 9
   verbatim; run the additive migration in-window; verify the BUILD_ID + a **BUILT chunk** grep (a
   source-tree grep proves nothing — `components/` and `lib/` are NOT shipped). **Beware trap 15**: a
   5-minute oneshot may show `failed` right after a deploy — re-check after the next tick.
10. **UPDATE THE HANDOFF (section 10 — same session):** section 6 last-verified date/HEAD/deployed
    BUILD_ID/sync, section 7 strike your item + promote what's next, section 5 any NEW trap with the
    evidence that proved it, section 12 one log entry (Did / Verified / NOT verified / State left behind /
    Next), and mark the item done in `PLAN_TASK_156_CYBERLAB_REAL_WORLD_TOOLS.md`. Commit + push those
    docs (explicit paths).
## D2 — what C0 and C1 actually are (the only green-light work)

```
C0  AUP + LabConsent text. NOTHING runs before it exists. (Legal, not code - but the text is
    a repo artefact AND a UI screen.) Deliverable: the AUP/consent copy as (a) a repo doc
    (e.g. docs/ or a markdown under the task doc) AND (b) a screen that gates the lab -
    reaching the lab requires accepting it, and the acceptance is recorded.
C1  schema (PLAN_156 section 6, one ADDITIVE migration) + the entitlement/gate (key "cyberlab"
    ALREADY in ENTITLEMENT_KEYS) + the staff badge + the admin limits (Lab*) + the section 12.1
    LabToolCatalog (a row per capability: ATT&CK id, last-reviewed, upstream version, CVE
    history, licence, staleAfter) + the read-only Research admin page (feeds only - it does NOT
    run an attack).
    STOP HERE.
```

## D2 — non-negotiable (these BIND; from PLAN_156 §12/§5.2 + 155 §14 rule 1)

- **One cap mechanism, never a second.** All lab limits are named `AdminSetting` fields, enforced
  **server-side**, editable in the **admin UI**, shipped with defaults — **exactly** the 155 §14
  pattern. Do **not** invent a parallel config. (`hosting` proved this works live without a redeploy.)
- **The abuse sentinel (§5.2) is the price of the power and is not optional:** every run is
  pre-flight **attested-target** checked; the **egress/DNS sentinel** watches volume+entropy; intent
  classification refuses third-party / product research. The §8.2 refusal demo must fire.
- **Never the production VPS.** Attack tooling lives on the **lab host** (second VPS / LAN box) and
  the **user's own VM** (§12.5). Prod keeps only `tcpdump` + purely defensive tools.
- **`requestSlot()` stays the single admission authority** (TASK_105 rule). Do **not** duplicate the
  governor and do **not** edit `lib/resource-governor.ts` — the governor task comes later (owner A8);
  you only *record* the load metrics/dials.
- **Reuse the safety plumbing that already exists** — the panic switch
  (`app/api/devices/panic/route.ts`), `AgentActionAudit`, `UserEntitlement`, the admin routes. Do
  **not** rebuild them.
- **Nothing customer-facing offensive before C0 + the L4 fences + lawyer sign-off.** Every tool row
  carries a **legal-basis note**; email/DNS rows additionally carry the **allow-list check**.
- **Reuse `lib/mailbox-crypto.ts` for any secret at rest — do not fork it.**

## D2 — FILES YOU MAY TOUCH / MUST NOT TOUCH

```
MAY TOUCH:   new lib/lab/** , app/api/lab/** , app/dashboard/cyberlab/** , components/cyberlab* ,
             app/admin/**/lab* , prisma/schema.prisma (ADDITIVE models only) + exactly ONE additive
             migration, tests/*.test.ts, and minimally lib/entitlements.ts / lib/products.ts /
             components/dashboard-nav.tsx (the Cyber Lab item already exists - extend, don't fork).
             The AUP/consent copy as a repo doc + a screen.
MUST NOT:    lib/resource-governor.ts, lib/agent.ts, lib/clone*.ts, any already-applied migration,
             the D1 hosting behaviour (/e/ + /downloads/ + /r/ + /hf/ + /pv/ + /hs/), and anything
             on self-hosted-build. Do not rebuild the Cyber Lab nav/card/panel (A1 is done).
```

## D2 ACCEPTANCE (the exit criterion for C0/C1)

> C0: the AUP/consent text exists as a screen + a repo doc and gates the lab (nothing runs without
> accepting it). C1: the schema is applied (additive, no data loss), the `cyberlab` entitlement gates
> the panel, the staff badge shows, every lab limit is an admin-editable `AdminSetting` **live without
> a redeploy**, and `LabToolCatalog` rows render with a **`staleAfter`** date that hides a stale row.
> Capture: the raw `prisma migrate` output, the live admin PATCH (status+body), the panel DOM text,
> and `npx tsc --noEmit` → 0 + `CI=1 npx next build` → 0 + `npm run test:<relevant>` green.
> **C2+ is NOT in this run** — do not scan, spoof, or fire anything.

## LAST — what you must NOT start

- **C2+** — anything that scans, spoofs, sends, or fires at a host. That is a separate assignment on a
  NON-production host, gated on the owner + a lawyer.
- **Resource-governor changes** (A8). Record dials/metrics only.
- **Converters** (A9 — still OFF).
- **Anything on `self-hosted-build`.**

REPORT BACK WITH EXACTLY: files + line ranges changed; the raw BEFORE output; the raw AFTER output;
the exact commands you ran; what you could NOT verify (expected, not a weakness); the commit SHA(s);
and confirmation the handoff is updated. LABEL ANYTHING SIMULATED AS "SIMULATION".
STOP WHEN YOUR TASK IS DONE. Do not start the next item. Do not deploy someone else's work.

---

## APPENDIX — D1 / Task 155 P3 as-built (for the record; D1 is CLOSED)

- **Commit `bb6ff6c`** (25 files, +3448/−13), pushed `282ee9a..bb6ff6c`; deploy run **`36966548887`** →
  build **`LjgrTG69r2eiN-w07Hj-i`**.
- **New/changed:** `lib/hosting/{cloudflare,extract,serve,sites}.ts`, `lib/hosting/rules.ts`,
  `lib/hosting/credentials.ts`, `lib/hosting/providers.ts`, `app/api/hosting/sites/**` (create/list/get +
  revisions + publish), `app/api/hosting/credentials/[id]/verify/route.ts`, `app/api/hosting/status/route.ts`,
  `app/pv/[token]/[[...path]]/route.ts` (**preview**, `noindex`, TTL), `app/hs/[token]/[[...path]]/route.ts`
  (**live**, immutable), `components/hosting-panel.tsx`, `app/api/admin/hosting/route.ts`,
  `app/admin/(protected)/admin-panel.tsx`, `prisma/schema.prisma` (9 `AdminSetting` cols + 2 NULLABLE
  `HostingCredential` cols + `HostingSite`/`HostingRevision`/`HostingJob`), migration
  `20261029000000_task155_p3_pages_sites`, `tests/hosting-pages.test.ts`, `package.json` (`test:pages`).
- **Evidence:** `npx prisma validate` OK · `prisma generate` OK · `npx tsc --noEmit` → **0** ·
  `CI=1 npx next build` → **exit 0** · `npm run test:hosting` → **39/39** + `test:pages` green. VPS:
  `BUILD_ID` = `LjgrTG69r2eiN-w07Hj-i` (mtime `2026-10-02 06:56:12 CEST`); `prisma migrate status` →
  *"Database schema is up to date!"*; P3 migration in `_prisma_migrations`; new tables in `pg_tables`;
  `systemctl --failed` empty; three services active. Live: `/` 200, `/dashboard/hosting` 307,
  `/api/hosting/sites` 401, `/pv/<bad>` + `/hs/<bad>` 404.
- **New trap 22** (see `SENIOR_HANDOFF.md` §5): `7z l -slt` prints an **archive header** block before the
  first `----------`; a naive parser records the archive itself as entry #1 and the "no nested archives"
  guard then refuses **every** real archive. The fix (skip to the first `----------`) was forced by driving
  a **real `7z`** in `tests/hosting-pages.test.ts`; a hand-typed listing had hidden it.
- **Still open (NOT this run):** the production hosting *write* path has not been run by hand; the
  premium/Cloudflare leg ran against the throwaway account only; `external` engine unimplemented; the
  governor does not yet know about hosting/lab RAM (§16.6 defers it).