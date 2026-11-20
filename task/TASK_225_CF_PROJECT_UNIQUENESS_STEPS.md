# TASK_225 STEPS — CF project name uniqueness (Task Agent working record)

Task doc: `TASK_225_CF_PROJECT_UNIQUENESS.md` (SCOPED 2026-10-19).
Branch: `agent/task-225-cf-project-unique`.

## BEFORE record (2026-10-19 session start)

### Git state
- Prior task: TASK_224 on `agent/task-224-install-link-delete` @ `816bea7` (complete, awaiting senior lane).
- New branch: `agent/task-225-cf-project-unique` @ `982a42c` (= `origin/main`; fetched clean).
  Used `git checkout -B ... origin/main` — local `main` stays locked to the sibling
  worktree `/Users/mikeolab/sw-vbsfix` (TASK_224 lesson: never `git checkout main` here).
- Tracked working tree: CLEAN before branch switch and after.

### §3.1 CLOBBER CHECK (in-scope files: `lib/hosting/sites.ts`, `tests/hosting-pages.test.ts`)
Ran `git diff --name-only origin/main...<branch>` for EVERY local + remote branch
(`git for-each-ref` + explicit `origin/mailer-exe`, `origin/sw-lab`):
**zero branches touch either file.** No clobber risk; no depends-on; no merge-order note.

### Owner decisions (from task doc top)
- Same label must mint a NEW Cloudflare project — never attach to / overwrite an existing one.
- `HostingSite.name` stays duplicate-allowed (label only); only `cfProject` becomes unique.
- No schema change; no `@unique` index (out of scope, task doc §2).
- Deploy: NOT this agent (senior lane after 🚦 GO). §6 MUST NOT TOUCH: schema.prisma,
  cloudflare.ts, local-engine serve/token paths, any deploy/merge/CI action.

## Verification log

### CF Pages project-name bound (task doc §2 asked to verify the 58-char assumption)
- Cloudflare API docs page: fetchable but nav-dominated; the `name` constraint text was not
  in the returned slice — NOT confirmed at source today.
- `cloudflare-typescript` SDK (Stainless-generated from CF's OpenAPI spec): `name` JSDoc
  says "Must contain only lowercase letters, numbers, and dashes" — charset confirmed,
  numeric limit not in the fetched slice.
- alchemy SDK docs: "only lowercase letters, numbers, and dashes" + "unique across all of
  Cloudflare Pages" — charset + uniqueness confirmed again.
- **DECISION (safe under every bound):** our own code has a PROVEN-safe length: `slugifyProject`
  slices to 50 and TASK_155's real CF deploys succeeded with those names. The mint is
  `head ≤ 40 + "-" + 7 hex = ≤ 48 chars` — under BOTH the claimed 58 AND the proven 50.
  Charset: slug head is lowercase `[a-z0-9-]`, suffix is lowercase hex — valid by construction.
- Extra shape trap found during design: `head.slice(0, 40)` can END on a hyphen (slug
  `"aaa…-b"`), which would mint `head--suffix` (double hyphen, invalid shape). Fix: trim
  trailing `-` after the slice. Head can never be empty/leading-hyphen (slugify already
  trims and falls back to `"site"`).

## Design (implementation plan, grounded in the code read below)

### `uniqueCfProject(name)` — new export in `lib/hosting/sites.ts`
```ts
export function uniqueCfProject(name: string): string {
  const head = slugifyProject(name).slice(0, 40).replace(/-+$/, "");
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);           // same idiom as newHostingToken (rules.ts:337)
  const suffix = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 7);
  return `${head}-${suffix}`;                          // ≤ 48 chars, [a-z0-9-], single hyphens
}
```
- Why random-suffix over check-then-create: race-free, cannot see CF-only names (BYO), atomic.
  Residual BYO hazard documented, not engineered around (task doc §2 rationale).

### Call sites
1. `sites.ts:246` — `const cfProject = engine === "cloudflare" ? uniqueCfProject(name) : null;`
2. `sites.ts:705` — replace `site.cfProject ?? slugifyProject(site.name)` with lazy healing:
   mint a unique name when the row's `cfProject` is NULL and PERSIST it to the row
   (prisma.hostingSite.update) BEFORE `ensureProject`/`deployTree` ever see it.
   Persist-before-deploy ordering is asserted by test 5. (§5 owner flag: this moves a
   legacy row's liveUrl once — reported, not resolved here.)
3. Stale comment: the "slugified from `name`" text lives in `prisma/schema.prisma:3347`
   which is §6 MUST NOT TOUCH — so the doc-comment correction goes on `slugifyProject`
   itself in sites.ts (mark it label-derivation only, never mint identity).

### NOT touched
- `slugifyProject` stays exported + byte-identical in behaviour (existing test L765 pins it;
  `uniqueCfProject` builds ON it).
- Local engine: `cfProject` stays NULL at create; no serve/token path touched.


## Codebase facts gathered (surface reads)

### `lib/hosting/sites.ts`
- `slugifyProject` L81-88: lowercase → non-alnum→`-` → trim hyphens → slice(0,50) → fallback `"site"`.
- `createSite` L192-261: caps+premium gate (`resolveCapsForUser`), engine coercion,
  premium gate for cloudflare, `healthyPlatformAccountCount` when credentialId NULL,
  `prisma.hostingSite.count` quota, mint previewToken + cfProject at L245-246,
  `prisma.hostingSite.create` (EXACTLY ONE createSite in codebase — grep-confirmed).
- `deployRevision` L654-769 (NOT exported; reached via `publishRevision` L810):
  `resolveCapsForUser` → (publish: `deploysInLastDay` quota, L377) → local branch L677
  (must not change) → CF branch L702: `resolveDeployCredential` → **L705 project derivation
  (the bug)** → `ensureProject` → `deployTree` (branch `main` if publish) → revision/site
  updates → `warmUpUrl(pagesProjectUrl(granted subdomain))` → `prunePublishedRevisions` L776.
- `resolveDeployCredential` L571-652: premium re-check; credentialId NULL → PLATFORM roster
  only via `resolvePlatformCredential` (pinAccountId from admin settings) — fail CLOSED.
- `publishRevision` L810-856: site+revision lookup, state must be `previewed`,
  `acquireHeavyJob` lock (hostingJob count/create), re-scan tree from `revision.storagePath`
  (real fs; refuses empty), `deployRevision(site, revision, files, "publish")`,
  `finishHeavyJob` (hostingJob.update, BigInt metrics).

### `tests/hosting-pages.test.ts` (harness to extend — house pattern)
- Env pre-set (NODE_ENV=test, APP_BASE, MAILBOX key, HOSTING_STORAGE_DIR tmp) L33-43.
- `installRequireHook()` L631-653: `Module._load` patch — `server-only`→`{}`; for parents
  in `/lib/hosting/`: `../prisma`→`fakePrisma`, `../admin-settings`→`{hostingEnabled}` fake,
  `../premium`→`isPremiumWithReversion` fake. Test file's OWN `require` calls bypass the
  hook (parent = tests dir), so the real cloudflare module stays real for existing tests.
- `fakePrisma` currently implements ONLY `hostingSite.findFirst` + `hostingRevision.findFirst`
  (in-memory `sites`/`revisions` arrays, `beforeEach` resets them).
- `seedLocalSite` L664+: pushes a full `SiteRow` (id/userId/name/engine/cfProject/previewToken/
  liveToken/status/previewUrl/liveUrl/createdAt) + `RevisionRow`.
- Existing regression pins read SOURCE TEXT deliberately (L789-822: publish tree rebuild,
  granted-subdomain liveUrl) — kept untouched; slugify test L765-768 kept byte-identical.
- `sitesMod = require("../lib/hosting/sites")`; currently destructures `resolveSiteServe, slugifyProject`.
- `toRevisionView` L353-366 needs: id/state/fileCount/bytes/previewToken/cfUrl/rejection/createdAt(Date).

### Fake-prisma/interception extensions planned (must genuinely implement every call — task doc §4 house rule)
- `hostingSite`: add `count`, `create` (build full row: id/createdAt/liveToken:null/liveUrl:null + data,
  push, return), `update` (apply data onto row, RECORD every call in `siteUpdates` for assertions).
- `hostingRevision`: add `findMany` (prune path; published rows desc) + `update` (apply + record).
- `hostingJob`: `count`→0, `create`→`{id:"job_n"}`, `update`→record (finishHeavyJob, BigInt ok).
- `user.findUnique`→`{tier: 9, premiumExpiresAt: null}` (resolveCapsForUser premium path).
- Require-hook additions for `/lib/hosting/` parents ONLY (test file's own requires unaffected):
  - `./platform-accounts` → `healthyPlatformAccountCount: () => 1`,
    `resolvePlatformCredential: () => ({ok:true, value:{accountId:"acct_test",token:"tok_test",platformAccountId:"plat_test"}})`.
  - `./cloudflare` → `ensureProject` (record name; ok, `{subdomain: name+"-c3t"}`),
    `deployTree` (record name+branch; ok, `{url, deploymentId}`),
    `pagesProjectUrl: (s)=>"https://"+s+".pages.dev"`,
    `verifyCredential: () => ({ok:true})`, `warmUpUrl: () => {}`.
    Order proof for test 5: the ensureProject stub snapshots the count of
    cfProject-bearing `siteUpdates` at call time → persist-before-deploy.

## Steps

- [x] 0. Session ritual: task doc (all 80 lines incl. the truncated §2–§4 middle via sed) + playbook read; git BEFORE captured; clobber check run.
- [x] 1. Surfaces read: sites.ts (createSite/deployRevision/publishRevision/resolveDeployCredential/prune/lock), schema sites block, test harness (hook + fakePrisma + seed + regression pins), rules.ts token idiom, API route callers.
- [x] 2. CF name bound verified for the record (charset confirmed; 48-char mint under both the 58-claimed and 50-proven bounds; trailing-hyphen trap found + guarded).
- [x] 3. `lib/hosting/sites.ts` — `uniqueCfProject()` added (L120-125, doc L100-119); create mint at L289 (was `slugifyProject(name)`); CF deploy fallback at L748-759 replaced with mint+persist lazy heal (`let project = site.cfProject; if (!project) { mint; prisma.hostingSite.update }` — persisted BEFORE ensureProject/deployTree); `slugifyProject` doc comment corrected to "label-only derivation, NOT a mint" (schema.prisma comment untouchable per §6 — noted in-code instead).
- [x] 4. `tests/hosting-pages.test.ts` — fakePrisma extended (`user.findUnique`, `hostingSite.count/create/update`, `hostingRevision.findMany/update`, `hostingJob.count/create/update`; updates RECORDED in `siteUpdates`), hook extended (`./platform-accounts`, `./cloudflare` fakes with `cfSeen`/`deploySeen` recorders; only for `/lib/hosting/` parents — the test file's own direct `require("../lib/hosting/cloudflare")` still gets the REAL client), `RevisionRow` + seed gained the view fields `toRevisionView` reads, beforeEach resets the recorders, destructure now `{resolveSiteServe, slugifyProject, uniqueCfProject, createSite, publishRevision}`. All 7 tests of task-doc §4 added after the slugify test; pre-existing tests byte-untouched.
- [x] 5. `npx tsx --test tests/hosting-pages.test.ts` → **54/54 pass** (47 pre-existing + 7 new), 0 fail.
- [x] 6. Gates all green — see evidence below.
- [x] 7. ONE commit `6a9e914`; local-engine-changed check: **NOTHING** (diff hunks = slugify doc block, uniqueCfProject, create mint, CF deploy branch only; zero lines touched in the `engine !== "cloudflare"` serve/publish branch, tokens, or resolveSiteServe).

## Gate evidence

### tsc
```
npx tsc --noEmit -p . → TSC_EXIT=0, 0 lines of output
```
First run surfaced ONE error — `.next/types/validator.ts(1052): Cannot find module '.../api/assistant/vantra/install-link/[id]/route.js'` — a STALE build artifact: `.next` is gitignored, that route exists only on `agent/task-224-install-link-delete`, and the validator was generated by TASK_224's build before this branch existed. Proven artifact-only (git check-ignore → ignored; file absent on this branch; never tracked), `rm -rf .next` (safe local cache), re-ran clean. NOT a code error.

### eslint
```
npx eslint lib/hosting/sites.ts tests/hosting-pages.test.ts → exit 0, no output
```

### Full suite (`npm test`, nohup + poll, ~34s)
```
# tests 1670
# suites 25
# pass 1669
# fail 0
# skipped 1        (pre-existing)
# duration_ms 34091
```
All 7 new tests present and green in the merged stream (ok 463-469). Count arithmetic: origin/main baseline = 1663 tests; TASK_225 adds 7 → 1670. (The TASK_224 log also totals 1670 because THAT run included TASK_224's own +7 vantra tests — this branch does not carry TASK_224; both branches are +7 over the same 1663 base.)

### Build
`CI=true npm run build` → `✓ Compiled successfully in 31.7s`, 136 static pages generated, route table emitted; 0 lines matching `Failed to compile|Failed to collect|Type error`. (Plain `npm run build` still fails pre-existing on this box — `.env` RESEND placeholder vs the env.ts boot guard, baseline-proven in TASK_224; CI path is the house-valid one here.)

### Local engine (§7 explicit check)
`git diff lib/hosting/sites.ts | grep '^@@'` → 4 hunks: L77 doc, L97 new helper, L281 create mint, L745 CF deploy branch. Grep of added/removed lines for `engine !== "cloudflare" | liveToken | /pv/ | /hs/ | resolveSiteServe` → **NO matches — nothing about the local engine changed.**

## HANDOFF → VERIFICATION AGENT

**Repo/branch/commit:** spaceworker · `agent/task-225-cf-project-unique` @ **`6a9e914`** (based on `origin/main` @ `982a42c`; NOT stacked on TASK_224 — no dependency, merge-order free).

**Deploy file list (exact, import-closure checked per §3.1):**
- `lib/hosting/sites.ts`
- `tests/hosting-pages.test.ts` (test-only; needs no deploy but rides the same commit)

No new routes, no client components, **no migration, no schema change** (task doc §2/§6 honoured — the stale `schema.prisma:3347` comment stays; the corrected doc-comment now lives on `slugifyProject` in sites.ts).

**Migration/DB steps:** NONE. (Deliberately no `@unique` index — task doc §2: the random suffix makes it unnecessary, and a unique index would fail to apply over prod rows that already contain duplicates.)

**Post-deploy verification (on-box, after deploy):**
1. Owner's exact case: create two cloudflare sites labelled the same → both succeed; `SELECT name, "cfProject" FROM "HostingSite" ORDER BY "createdAt" DESC LIMIT 2;` → two DIFFERENT `cfProject` values, both matching `^[a-z0-9]+(-[a-z0-9]+)*$`.
2. A legacy NULL-`cfProject` row's next publish mints+persists a unique `cfProject` and its `liveUrl` moves to the new project's granted subdomain **once** (expected — flag 2 below).
3. Existing non-null rows: redeploy keeps the exact stored `cfProject` (reuse pinned by test; `ensureProject` semantics unchanged).

**⚠️ Owner flags (task doc §5 — FLAG, not resolve):**
1. **Existing colliding rows (live now)** — run on the box BEFORE merge, report counts to the owner:
   - `SELECT "cfProject", COUNT(*) FROM "HostingSite" WHERE "cfProject" IS NOT NULL GROUP BY 1 HAVING COUNT(*) > 1;`
   - `SELECT COUNT(*) FROM "HostingSite" WHERE engine = 'cloudflare' AND "cfProject" IS NULL;`
   Remediation for duplicates (re-mint backfill → moves those sites' live URLs once) is the owner's call, separate task, explicit approval required.
2. **Lazy-heal URL move** — a legacy NULL-`cfProject` row's `liveUrl` changes on its next publish (it gets its own unique project). Correct (today it would collide) but user-visible.
3. **Deleting the legacy shared Cloudflare projects** (freeing names) — explicitly out of scope; deleting CF resources needs its own approval.

**Risks/rollback:** self-contained in 2 files; rollback = revert commit `6a9e914`. Worst-case residual hazard (a BYO user's external project colliding with a minted name) is documented in the `uniqueCfProject` doc-comment as accepted, pre-existing in kind.

## DEPLOYED & VERIFIED — Senior Verification Agent (2026-10-18)

Shipped to production in CI run **39118093287** (Build & Deploy, dispatch after owner GO).
Merged to main as `c9aa516` (merge commit; TASK_225 rides `6a9e914`).

Owner flag #1 RUN PRE-MERGE on the box (read-only psql):
- Duplicate cfProject groups: `new-test` — 2 rows, BOTH owned by user cmtl47mcc0000kpr1ds5s2xic
  ("new test" created 2026-10-04 + 2026-10-06). Live collision, same owner — no cross-user loss.
- CF rows with NULL cfProject: **0** → lazy-heal / flag #2 URL-move will not fire today.
- Cloudflare sites total: 7. Backfill of the new-test pair + deleting the shared CF project:
  owner's call, separate task, explicit approval required.

On-box post-deploy evidence:
- BUILD_ID: `KKKGK3ukBt1_W_w793yJj` → `FzRmVYbdp4To16F2NjDaT`
- `uniqueCfProject` present in compiled server chunk sourcesContent (.js.map; the .js itself
  is minified so the identifier is stripped — expected)
- Post-deploy DB: 7 CF rows / 6 distinct cfProject — identical to pre-deploy (no migration,
  no data drift; zero migration files in the diff)
- Journal clean, public 200, services active (see TASK_224 stamp for full battery)

Merged-tree gates run by verification agent: tsc exit 0 · eslint exit 0 ·
full suite 1677 / 1676 pass / 0 fail / 1 skip. CI push-run 39117651765 success.
