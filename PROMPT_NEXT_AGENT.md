# PROMPT — NEXT SENIOR AGENT (Task 155 hosting P5 / P6 / P6d **and** Task 156 C2+ — the WHOLE pending queue)

> **Self-contained, copy-paste prompt.** Paste the `TASK BLOCK` below into the next senior agent.
> It **supersedes** the previous `PROMPT_NEXT_AGENT.md`, which scoped D2 / Task 156 **C0 → C1 ONLY**
> — that work is **DONE, DEPLOYED and LIVE** (commit `5485fdc`, deploy run `36995895931`). It also
> supersedes the stale note in `PROMPTS_SENIOR_ENGINEERS.md` §"Owner-requested design work" that still
> says "START D1 AT P2" — **D1 / Task 155 P1 + P2 + P3 + P4 are all built, deployed and LIVE.**
>
> **Nothing in this file is work you must finish in one run.** It is the *full pending queue*, with
> the grounding each item needs and the exact gate that must clear before it binds. Take them **one at
> a time**, in the order in §5. **One live human check is now CLOSED:** TASK_157's OCR/summary was
> **verified by the owner on production** (11 frames OCR'd + summarised, ~0.1s sweep). Still
> awaiting a live human check: the hosting write path (§1.2 / queue item 6) and the BYO "Yours"
> credential UX (§2b).

---

## TASK BLOCK (paste from here)

```
TREE:            /Users/mikeolab/spaceworker        (branch: main; synced with origin/main @ 0452397)
WHAT IS PENDING: the hosting workstream (Task 155 P6c = LINKS on Workers, P5a, P6d) AND the Cyber Lab
                 follow-on (Task 156 C2+). Take them ONE AT A TIME, in the order in section 5 below.
                 THE FILES/FILES-ON-R2 QUESTION IS CLOSED: files stay LOCAL, only sites+links get the
                 three engines (section 2b is the binding answer; P6b is CANCELLED). Do not build R2.
                 P6a (three-option engine) + the Pages deployTree fix are DONE + LIVE — see section 8.
                 Platform roster ALREADY HAS row #1 ("Primary cf", verifyError NULL — healthy); the owner
                 adds the rest. Two items await LIVE human checks: TASK_157 OCR/summary when a device comes
                 online; hosting upload → preview → publish on production (section 1.2 + queue item 6).
                 Do NOT batch items silently: each has its own "open questions" section that MUST
                 be answered by the owner/lead BEFORE its schema/behaviour is committed.
TASK DOCS:       PLAN_TASK_155_WORKERS_AND_PAGES.md
                   section 19  -> P6a: the THREE-option engine model (Free/Premium/BYO). BINDING.
                   section 20  -> P6d: site upload inputs (file / folder / zip). BINDING.
                   section 18  -> P5:  the Domains tab (grounded; section 18.9 Q2 ANSWERED).
                   section 17  -> P4:  DONE (tabbed UI, premium link cap, Settings accounts).
                   section 16  -> P3:  DONE (Pages engine, folder->preview->publish).
                   section 14  -> the CAP MECHANISM you MUST reuse (do not invent a second one).
                 PLAN_TASK_156_CYBERLAB_REAL_WORLD_TOOLS.md
                   section 12  -> BINDS the lab (12.1 research gate ... 12.9 premium gate).
                   section 7   -> C0-C6 phasing. C0+C1 are DONE; C2+ is a SEPARATE assignment.
                 SENIOR_HANDOFF.md
                   section 6 (current state) · 7 (queue) · 8 (verify) · 9 (deploy)
                   section 5 (traps - especially 3, 7, 13, 14, 15, 16, 22, 23)
                 PROMPT_NEXT_AGENT.md -> this file.
DEPLOY?          Task 155 P6a + Pages fix: DONE + LIVE (migration 20261031200000 recorded ok on the box;
                 build 2c8IJxhMyyYVVEgJh0wlt — see section 8). Next deployable item:
                 Task 155 P5a: additive (one new table) -> deploy via deploy.yml, SENIOR_HANDOFF §9 VERBATIM.
                 Task 155 P6d: NO migration - a UI + lib change only.
                 Task 156 C2+: NEVER the production VPS. Non-production host, owner + lawyer gated.
                 NEVER deploy without reading your own diff for pending migrations first.
```

---

## 1. VERIFIED STATE AT HANDOFF (2026-10-03, updated after the Pages root-404 fix)

**`main` @ `0452397`, synced with `origin/main`, working tree clean.** Live build
**`2c8IJxhMyyYVVEgJh0wlt`** (`/opt/spaceworker/.next/BUILD_ID`), deploy run **`37051772321`**
(`workflow_dispatch`, **success**); the `0452397` Pages-404 fix deployed in run **`37084380902`**.

| Item | Commit | State |
|---|---|---|
| Task 155 **P1** files engine (`/hf/<token>`) | `a131835` | ✅ deployed + live |
| Task 155 **P2** links + BYO credential store + Cyber Lab scaffolding | `435d419` | ✅ deployed + live (`hostingEnabled=true`) |
| Task 155 **P3** Pages engine (zip → preview → publish, per-site engine) | `bb6ff6c` | ✅ deployed + live |
| Task 155 **P4** tabbed Hosting UI + premium link cap + Settings accounts + §19.10 copy pass | `d79eee6` | ✅ deployed + live |
| Task 156 **C0 + C1** AUP/consent + premium-gated lab schema + Research admin | `5485fdc` | ✅ deployed + live |
| Screens fix: offline-device false `device_offline` on capture | `278c7d0` | ✅ deployed + live |
| Task **157** OCR text layer + Summary/Extraction toggle + frame delete | `503c8be` | ✅ deployed + live — **owner still must eyeball it when a device comes online** |
| Task 155 **P6a** three-option engine (Free/Premium/Yours) + platform roster | `0cd23f5` | ✅ deployed + live (build `3KsVSvBvE284eXpdv5dkn`) |
| **Pages `deployTree` fix** (upload-token + `/pages/assets/*` + multipart; fixes live 405/8000013) | `7e380da` | ✅ deployed + live (build **`2c8IJxhMyyYVVEgJh0wlt`**, run **`37051772321`**, success) |
| **Pages root-404 fix** (unwrap a zipped FOLDER + deployment-readiness gate) | `0452397` | ✅ tests green, **live-verified end-to-end** against the real account; deployed in run `37084380902` |
| **OCR/summary fix** — `tesseract.js` added to `serverExternalPackages` so Turbopack stops baking a nonexistent `/ROOT/...` worker path | `f63a335` | ✅ **LIVE + OWNER-VERIFIED** — 11 frames gained OCR text + summaries, sweep ~0.1s (was a 300s hang). Run `36996482708` ok; `.next` removal before extraction landed in the same deploy |

**Platform roster row #1 ALREADY EXISTS — the owner pasted their Cloudflare details into the
admin panel before this commit, so nothing for the next agent to insert:** one row, label
`"Primary cf"`, `priority 1`, `status "active"`, `verifyError NULL` (healthy, verified 2026-10-02).
The owner adds the remaining rows themselves via the same panel (Add and verify → promote).
NEVER paste tokens into chat/docs — credentials go in the admin/account forms only.

**Migration `20261031200000_task155_p6a_platform_accounts` recorded live** (`ok=true clean=true`):
new table `HostingPlatformAccount` + `AdminSetting.hostingPlatformCfEnabled` (default `true`).
**The roster is EMPTY (0 rows) on prod** — until the admin pastes a real platform Cloudflare account,
the Premium option honestly says *"being set up"* (`platform_empty`). That paste + a live Premium
deploy is the top P6a follow-up (queue item 1).

**Migrations recorded live, latest deploy:** `20261031200000_task155_p6a_platform_accounts`
(`ok=true clean=true`). Earlier: `20261030200000_task157_screenshot_ocr_text`,
`20261030120000_task155_p4_premium_links`, `20261030000000_task156_c1_lab_schema` — all **additive
/ NULLABLE — no row rewritten**.

**Green at the P6a commit:** `npx prisma validate` OK · `npx tsc --noEmit` → **0** · `CI=1 npx next build` →
**exit 0** · `npm run test:hosting` → **81/81** (incl. both new platform suites) · `test:pages` → **19/19** ·
`test:lab` → **10/10** · `test:summaries` → **15/15** · `test:timeline` → **14/14** · `test:capturefail` → **5/5** ·
`test:screenshots` → **36/36** · **eslint at HEAD parity on every touched file** (the only errors are the pre-existing
`react-hooks/set-state-in-effect` warnings in `admin-panel.tsx` / `hosting-panel.tsx`, which also exist
at HEAD — do not "fix" them by suppressing; they are a separate, pre-existing class).

**⚠ NOT verified — do not claim these work:**
1. The P3/P4 hosting **write** path on production — **nobody has clicked *upload → preview → publish*
   on the live site yet.** The pipeline is proven on a scratch DB + a real `7z` + `next start`, and the
   **premium/Cloudflare** leg only against a **throwaway** account. **This is the first thing to prove
   by hand** (queue item 6), and §20.8 makes it an acceptance item for whichever hosting item ships next.
   **2026-10-03 update:** the Cloudflare leg itself is now proven *outside* the app — a zipped folder was
   unwrapped, Direct-Uploaded and readiness-polled with the real account, and the deployment root returned
   **200** with the marker content (`/assets/a.css` → **200 text/css**). Only the in-app click remains.
2. **P6a on prod needs one human step:** the admin must paste a real platform Cloudflare account into
   Admin → Hosting → Platform accounts (the roster is empty; the Premium picker says *"coming online
   shortly"* until then), then deploy one real Premium site end-to-end (this doubles as proof of #1).
3. **TASK_157 live:** the owner said *"will test when a device comes online"* — OCR extraction,
   the Summary/Extraction toggle, and frame delete are deployed but not yet eyeballed on live frames.
4. Production **email/password login** was not re-confirmed this session.
5. **Fresh-DB migration replay is broken** (≥5 out-of-order migrations — **trap 23**). The live DB and
   deploys are unaffected; only brand-new DBs (scratch/CI/local) hit it. Filed as its own hygiene task.

---

## 2. YOUR ACCESS PACK — everything you need is available; use it

### 2.1 The production box (read-only unless deploying)

```bash
ssh -i ~/.ssh/tacticalrmm_vps root@164.68.105.96
```

- **App root:** `/opt/spaceworker` · **service:** `spaceworker.service` (`User=trmm`,
  `ExecStart` = `next start -p 3500`) · siblings `spaceworker-browser`, `extraction-worker`.
- **nginx 1.30.4** — 13 vhosts in `/etc/nginx/sites-enabled/` (incl. `spaceworker.top`,
  `instaweb.top`, `dl.instaweb.top`, plus the OTHER products: `vantra`, `rmm`, `mesh`, `agent`, `dl`).
  **There is NO `default_server` vhost** — an unknown `Host` falls through to the first-listed block.
- **certbot 1.21.0** installed; 8 lineages in `/etc/letsencrypt/live/`.
- **sudoers:** `/etc/sudoers.d/trmm` grants **`trmm ALL=(ALL) NOPASSWD:ALL`** — so certbot / nginx
  reload are runnable passwordless from app code today (this is what makes §18 Path B cheap).
- **Postgres:** DB `spaceworker`, reachable as `sudo -u postgres psql -d spaceworker`.
- **⚠ DO NOT touch the other products' vhosts** (vantra/rmm/mesh share this box).

### 2.2 Verify what is actually live (never assume)

```bash
cat /opt/spaceworker/.next/BUILD_ID ; stat -c %y /opt/spaceworker/.next/BUILD_ID
systemctl --failed                      # empty, except a known 5-min oneshot false alarm (trap 15)
sudo -u postgres psql -d spaceworker -c 'SELECT migration_name, finished_at FROM "_prisma_migrations" ORDER BY finished_at DESC LIMIT 5;'
```

**⚠ `components/` and `lib/` are NOT shipped to the box.** To prove a source change is live, grep the
**built chunks** under `/opt/spaceworker/.next/static/`, never the source tree (which is stale by
design). A grep *miss* in `/opt/spaceworker/components/` proves **nothing**.

### 2.3 Deploy (manual only — pushing does NOT deploy)

```bash
cd /Users/mikeolab/spaceworker
gh workflow run deploy.yml --ref main
gh run list --workflow=deploy.yml --limit 3
gh run view <run_id> --json status,conclusion,headSha
```

Follow **`SENIOR_HANDOFF.md` §9 verbatim.** In short: build job on every push; the **deploy** job is
gated to `workflow_dispatch`; it tars `.next node_modules package.json package-lock.json prisma
browser-server worker deploy browser-capture` (NOT `components/`/`lib/`), scp's it, stops the three
services, extracts, runs `sudo -u trmm npx prisma migrate deploy` **under `set -e`** (a failing
migration aborts and can leave services stopped — **if that happens, stop and report; do not improvise
a repair against production**), restarts, asserts `is-active`, installs every unit in `deploy/`.
**Afterwards verify the owner-visible behaviour actually changed** — a green deploy that changed
nothing the user can see is the failure that produced TASK_153.

### 2.4 Local verification (this workstation)

```bash
cd /Users/mikeolab/spaceworker
grep '^DATABASE_URL' .env                    # confirm the target BEFORE any DB write
createdb sw_mycheck
DATABASE_URL='postgresql://mikeolab@127.0.0.1:5432/sw_mycheck' npx prisma db push --skip-generate
#   ...or apply migrations dir-by-dir if you need the real history (see trap 23 below)
CI=1 npx next build
npx tsc --noEmit
npm run test:hosting        # + test:pages / test:lab / test:summaries, whichever you touched
dropdb sw_mycheck
```

`package.json` test scripts that matter here: **`test:hosting`**, **`test:pages`**, **`test:lab`**,
`test:summaries`. **CI does not run them** (trap 3) — run them yourself.

**⚠ Trap 23 — a FRESH DB cannot replay migration history.** ≥5 migrations are out-of-order (e.g.
`20260914150000_add_license_claim_token` references `ExeLicense`, created by a *later* migration). Fix
on scratch: apply up to the break, `npx prisma migrate resolve --applied <name>`, continue. **Never
edit another task's migration.** Live is unaffected (its history is already recorded).

---

## 3. THE PENDING QUEUE — every open item, grounded

Order below is the recommended run order. Each item names its binding doc section and its **gate**.

### ✅ 0 — Task 155 **P6a**: the THREE-option engine model — **DONE + LIVE** (record only)

Commit `0cd23f5`, deploy run `37038272028`, build `3KsVSvBvE284eXpdv5dkn`. Built per §19: additive
`HostingPlatformAccount` (AES-256-GCM tokens, `priority` rotation, health columns) + the
`hostingPlatformCfEnabled` kill-switch (default true); the platform branch in `resolveDeployCredential`
(`credentialId NULL` → the roster, **premium only**, named credential → only that BYO row, **fail
CLOSED**); premium gates at **createSite AND deploy** (403 `premium_required` — §19.11: BYO is
premium-only too); three-option picker **Free / Premium / Yours** with §19.10 copy (no "Cloudflare" on
the Hosting screen); admin roster route + panel; `test:hosting` **81/81**. **Follow-ups are live items
now — see §1 items 4–5** (paste a real platform account; prove write-path on prod).

### ★ 1 — Task 155 **P5a**: the Domains tab  *(top build item; its P6a dependency is now MET)*

**Doc:** `PLAN_TASK_155_WORKERS_AND_PAGES.md` **§18** (grounded spec; §18.9 Q2 **answered on the box**).

**The ask:** users add a domain and **choose that domain instead of the link**; we do the automation.
**The honest core (§18.3):** **one DNS record from the user is unavoidable**; everything else is ours.
**Two delivery paths:** **A** = Cloudflare edge on a platform/BYO token (no VPS change); **B** = our
metal (catch-all nginx vhost + per-domain certbot + a `Host` resolver). **§18.9 Q2 is ANSWERED:** certbot
1.21.0, nginx 1.30.4, `trmm NOPASSWD:ALL`, **no default vhost** → Path B is "write one vhost + wire the
resolver", not a week of provisioning. **Recommended phasing:** **P5a** = tab + `HostingDomain` model
(additive, `hostname @unique`) + verification + binding, **Path A**, `provider = platform` **default**
per §19.10 rule 5, BYO as the escape hatch; **P5b** = our-metal serving. **Gate:** §18.9 **Q1** (phased
recommendation vs our-metal-first), **Q3** (BYO token's Pages custom-domain scope), **Q6** (abuse guardrails).

### 2 — Task 155 **P6d**: site upload inputs — file / folder / zip  *(independent)*

**Doc:** `PLAN_TASK_155_WORKERS_AND_PAGES.md` **§20 (BINDING)**.

**The ask:** *"not only zip option should be available for site upload … we should be able to collect
file or folder."* **Today only a `.zip` works**; a single `.html` or a folder does not. **The BINDING
recommendation (§20.2):** **normalize every input to the ONE existing zip pipeline, in the browser** —
so all of `analyseArchive`'s guards (zip-slip, symlink, nested zip, entry + per-file ceilings, the 25 MiB
Pages ceiling) stay in **one tested place**; a second server path would re-derive all of them for
client-named multipart parts — a larger attack surface for no user-visible gain. Cost: one tiny pure-JS
zip lib (**recommend `fflate`**), running in the **browser** (never server RSS). Optional §20.4
loose-file server path (~30 lines, no traversal surface). **§20.5: NO migration.** **Gate:** §20.9
**Q1** (fflate vs a store-only writer we own), **Q2** (folder is desktop-only — OK?), **Q3** (build
§20.4?). Sequence against P6a — **they touch the same panel.**

### 2b — OWNER'S ASK, NOW ANSWERED (2026-10-03): **SITES + LINKS get the THREE engines. FILES STAY LOCAL.**

**This item is CLOSED as a design question. Do not re-open it. The owner answered it:**

> "files should stay local instaweb … only sites and links get the cloudflare option … links
> should be workers on custom hosts … a link can just point at our own `/hf/<token>` url, so no
> bucket is needed."

**The final engine matrix — this is BINDING:**

| Surface | Free | Premium (platform) | Yours (BYO) |
|---|---|---|---|
| **Sites** | `local` | Cloudflare **Pages** | Cloudflare **Pages** — ✅ ALREADY SHIPPED (P6a) |
| **Links** | `local` `/r/<token>` | Cloudflare **Worker** redirect on a custom host | Cloudflare **Worker** redirect on your own host |
| **Files** | `local` / instaweb — **the only engine** | — | — |

**What this means, concretely:**

* **Files get NO engine dial at all.** One engine, one code path, no schema column. `HostedAsset`
  does **not** gain `credentialId`; `HostingCredential`/`HostingPlatformAccount` gain **no**
  `storage*` columns. There is **no R2, no bucket, no S3 keys, no presigned URLs, no R2
  subscription** anywhere in this plan. The Files UI gets no Free/Premium/Yours switcher.
* **Links are the only remaining build item** — call it **P6c**, spec in `PLAN_TASK_155` **§19.12.3**.
  A `cloudflare`-engine link gets a Worker that 302s on the user's custom host. Its target may be
  any URL — **including our own `/hf/<token>`**, which is precisely why no object storage is needed.
* **The local fallback must survive**: a `cloudflare` link stays resolvable on `/r/<token>` forever,
  including while it is deploying. The edge is an accelerator, never the single point of failure.
* Spec + schema (the ONLY schema change: seven `LinkRedirect` columns + one index) is written and
  binding in **§19.12.1–§19.12.3**. Acceptance bar: **§19.12.5**.

**⚠️ A cancelled R2 implementation existed in the working tree and has been REVERTED.** Do not
re-create it, and do **NOT** apply migration `20261032000000_task155_p6bc_r2_workers` (it is
deleted from disk). `lib/hosting/r2.ts` and `lib/hosting/storage-credentials.ts` are **gone**. If
you find any of these referenced anywhere, that is stale — fix the reference, do not resurrect the
code.

**Before P6c can be verified live (blocking, needs the owner):**

1. An **active Cloudflare DNS zone** on the platform account, so a custom hostname can be tested
   (`GET /zones?name=<host>` + `status === "active"` must pass before any route is created).
2. The platform token confirmed to hold **Workers Scripts:Edit + Workers Routes:Edit** (it has
   Pages; Workers is a separate scope).
3. `HostingCredential` currently has **zero rows** and `/api/hosting/credentials` logged no
   requests — the **"Yours" (BYO) credential UX is unverified in a browser**. Test it.

---

### 3 — Task 156 **C2 → C6**: the lab actually *does* something  *(SEPARATE assignment)*

**Doc:** `PLAN_TASK_156_CYBERLAB_REAL_WORLD_TOOLS.md` **§12 (binds)** + **§7 (C0–C6 phasing)**.
**C0 + C1 are DONE + LIVE.** Everything from C2 up (anything that scans, spoofs, sends or fires) is
**gated on the owner + a lawyer**, runs on a **NON-production host**, and is **NEVER** pointed at the
prod VPS. Reuse 155 §14's cap mechanism, the existing panic switch / `AgentActionAudit` /
`UserEntitlement`; **do not edit `lib/resource-governor.ts`.** Do not start it without those gates.

### 4 — Hygiene: fresh-DB migration replay (trap 23)

**No task doc yet — write one.** ≥5 out-of-order migrations break a brand-new DB (§2.4). Live + deploys
are unaffected. Fix = reorder/repair **or** a documented `migrate resolve` cheat-sheet. **Do NOT silently
edit another task's migration.**

---

## 4. NON-NEGOTIABLES (carried forward — these have all bitten before)

1. **Reuse the CAP MECHANISM** (`PLAN_155` §14): every new limit is an **admin-editable `AdminSetting`**
   that changes **live without a redeploy**; free-vs-premium is a swap inside `resolveHostingCaps`. Do
   **not** invent a second cap system or hard-code a number.
2. **Migrations are ADDITIVE + NULLABLE.** No row rewritten, no column dropped, no type narrowed. Read
   your own diff for pending migrations **before** you trigger a deploy.
3. **Fail CLOSED.** A dead credential → refusal with plain language, never a silent fallback, never a raw
   provider error. (Same rule for P6a's platform tokens.)
4. **The owner's A14 rule stands:** the Cyber Lab (and anything lab-adjacent) is gated by the **PREMIUM
   entitlement** — **there is NO staff badge and NO staff gate in SpaceWorker.** Do not build one.
5. **The Hosting screen never says "Cloudflare"** (§19.10). It says **Free / Premium / Yours**. Brand
   talk lives in Settings → Hosting accounts.
6. **`7z` only, never into RSS.** Archives are listed and extracted by shelling out to `7z`; the parse +
   tree→manifest mapping stays PURE and unit-testable. A rejected archive leaves **zero** partial state.
7. **Never improvise against production.** No repair, no manual SQL, no "quick fix" on the VPS beyond the
   documented read-only checks and the `deploy.yml` path.
8. **Verify owner-visible behaviour, not just green CI.** A deploy that changed nothing the user can see
   is the exact failure TASK_153 was written about.

---

## 5. WHAT TO DO **FIRST** (do not skip this)

1. **Read, in this order:** `SENIOR_HANDOFF.md` §6 → §7 → §8 → §9 → §5 (traps). Then your item's
   binding section (`PLAN_TASK_155` §19 for P6a).
2. **Answer that item's "open questions"** with the owner/lead **before** you commit its schema or
   behaviour. If an answer would change the schema or the gate, **ask — do not guess.**
3. **Prove the current state yourself** (§2.2). Never trust this file's numbers over what you see.
4. **Reproduce, then change, then show it passing** with raw output (§8 of the handoff).
5. **Commit, and only then deploy** — and only with the owner's go-ahead. Update
   `SENIOR_HANDOFF.md` **§6 + §7 + §12** (and §5 if you hit a new trap) **in the same session** — a
   code-complete but doc-stale handoff is a failure (trap 14).

## 6. MAY TOUCH / MUST NOT TOUCH

**MAY TOUCH (hosting items):** `lib/hosting/**`, `app/api/hosting/**`, `app/api/admin/hosting/route.ts`,
`components/hosting-panel.tsx`, `components/hosting-credentials-settings.tsx`,
`app/dashboard/hosting/page.tsx`, `app/dashboard/settings/page.tsx`,
`app/admin/(protected)/admin-panel.tsx` (hosting/lab panels only), `prisma/schema.prisma` (**additive
only**), `prisma/migrations/<new>/`, `tests/hosting-*.ts`, `package.json` (test scripts).

**MUST NOT TOUCH (this workstream):** `lib/resource-governor.ts`; the **other products' nginx vhosts**
on the box (vantra / rmm / mesh / agent); **another task's migrations** (trap 23); `components/`/`lib/`
shipping assumptions in `deploy.yml`; the converters (still **OFF**, §16.5 — do not install
`sharp`/`ffmpeg`/`libreoffice`); anything that scans/spoofs/sends (that is Task 156 **C2+**, a separate
assignment).

## 7. REPORT BACK WITH EXACTLY

- **Files + line ranges** changed, and **what you did NOT change** (and why).
- **The raw BEFORE output** and **the raw AFTER output** for the thing you fixed.
- **The exact commands** you ran, and their raw results.
- **What you could NOT verify** — this list is expected, not a weakness.
- The **commit SHA(s)** and, if deployed, the **`BUILD_ID`** + **run id**.
- **Confirmation the handoff (§6/§7/§12) is updated.**
- **LABEL ANYTHING SIMULATED AS "SIMULATION".**

**STOP WHEN YOUR ITEM IS DONE. Do not start the next one. Do not deploy someone else's work.**

---

## 8. APPENDIX — as-built record (for the record; already closed)

- **Task 155 P4** — commit `d79eee6`, deployed in run `36995895931`. Tabs (Sites \| Links \| Files) with
  count badges; `AdminSetting.hostingPremiumMaxLinks` (500) via `resolveHostingCaps`; *Hosting accounts*
  card on `dashboard/settings`; links open/edit/delete + files visibility toggle; migration
  `20261030120000_task155_p4_premium_links`. `test:hosting` **40/40**.
- **Task 156 C0 + C1** — commit `5485fdc`, deployed in the same run. `TASK_156_CYBER_LAB_AUP.md` +
  `components/cyberlab-aup.tsx`; ten additive `Lab*` models + `AdminSetting.cyberlab*` dials (migration
  `20261030000000_task156_c1_lab_schema`); `lib/lab/{aup,consent,gate,tools,catalog-seed,research}.ts`;
  the **PREMIUM** `cyberlab` gate (owner **A14**, no staff gate); `LabToolCatalog` seeded **16 rows**
  with `staleAfter` hiding; read-only Research admin page. `test:lab` **10/10**.
- **Scope docs written this session (no code):** `PLAN_TASK_155` **§18 (P5 Domains)**, **§19 (P6
  three-option engine)**, **§20 (P6d upload inputs)**; handoff **§6 + §7 + §12** and **trap 23**.
- **Box facts confirmed this session:** certbot **1.21.0**, nginx **1.30.4**, app `User=trmm`,
  `/etc/sudoers.d/trmm` = `NOPASSWD:ALL`, **no default vhost**, 13 vhosts / 8 certbot lineages.
- **Pages deployTree fix** — commit `7e380da`, deploy run `37051772321` (**success**, build
  **`2c8IJxhMyyYVVEgJh0wlt`**): `upload-token` + `/pages/assets/*` + multipart form (the account-token
  calls hit live 405/8000013). Verified server-side on the box (lib is server-only, not in client
  chunks) + `hosting_status=401`/`spaceworker active`.
- **Pages root-404 fix** — commit `0452397`, deploy run `37084380902`. The live preview
  `https://c01095fa.testsite-735.pages.dev/` 404'd at the ROOT while its deployment said
  `deploy:success`; the deployed manifest was `{"/inn/index.html", …}`, i.e. the *zipped folder*
  wrapper became the root's only child (the real page answered at `/inn/` with **200**). Fixes:
  `singleRootPrefix` + `flattenSingleRootDir` collapse ONE unambiguous wrapper before the tree is
  scanned (a genuine multi-root site is untouched; `.DS_Store` can no longer reach a manifest or the
  extracted tree — it is also passed to `7z -x!`), and `waitForDeployment` polls a deployment to a
  **terminal** stage so `deployTree` never returns a URL it has not seen succeed (failure → 502,
  timeout → 504, plain language). `tests/hosting-pages.test.ts` **26/26**, all five hosting suites
  **107/107**, `tsc` + `eslint` clean. Live-verified end-to-end against the real account.
- **Still open after this session:** the P3/P4 prod **write** path (§1.2), prod login re-check, and the
  fresh-DB migration replay (trap 23).
- **2026-10-03 — R2 REVERTED, docs corrected (no code shipped).** The owner's revised decision
  ("files stay local instaweb; only sites and links get Cloudflare; links are workers on custom
  hosts; a link can point at our own `/hf/<token>`") cancelled the uncommitted R2 work. Reverted
  `lib/hosting/{r2,storage-credentials}.ts`, the `20261032000000_task155_p6bc_r2_workers` migration,
  and every R2 hunk in `schema.prisma`, `providers.ts`, `files.ts`, `rules.ts`, `hf/[token]/route.ts`,
  `api/hosting/files/route.ts`, `tests/hosting-files.test.ts`. **Nothing was deployed** — the revert
  returns the tree to committed `0452397` + the already-live `f63a335`. Verified after the revert:
  `tsc --noEmit` 0, hosting suites **40/40**. Rewrote PLAN §19.12 (link-only schema, files-local,
  acceptance bar) and §19.7/§19.11 P6b → **CANCELLED**, P6c → **CONFIRMED**.
- **`WilkSF9` monitoring was re-enabled** during the OCR diagnosis. The owner must confirm whether
  that is the desired FINAL state.



