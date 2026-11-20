# TASK_225 — Hosting: a Cloudflare site's project name must be unique per site (same name ≠ same site)

**Status:** SCOPED for the task agent — 2026-10-19
**Branch:** `agent/task-225-cf-project-unique`
**Owner ask (verbatim):** "when i generate a site from hosting with a name… and i generate a new site with that exact name, the back generation should handle that as a new site, not generate an exact site which will mean both get the same thing… if 2 users think of the same name, the next person overwrites the other."

---

## 1. The bug, precisely

A Cloudflare-hosted site's identity on Cloudflare's side is its **Pages project name**, and today that name is derived **purely from the human-readable label** — with no uniqueness of any kind:

- `lib/hosting/sites.ts:246` — at creation:
  `const cfProject = engine === "cloudflare" ? slugifyProject(name) : null;`
- `lib/hosting/sites.ts:81-88` — `slugifyProject` is a pure function of the label:
  lowercase → non-alnum → `-` → trim → `slice(0,50)` → fallback `"site"`.
  `"My Portfolio"`, `"my portfolio"`, and `"my-portfolio!!"` all collapse to **`my-portfolio`**.
- `prisma/schema.prisma:3349` — `cfProject String?` — **no `@unique`, not even an index.** Nothing in the DB stops two rows (same user or different users) from storing the same `cfProject`.
- `lib/hosting/cloudflare.ts:287-292` — `ensureProject` does `GET …/pages/projects/<name>` and **returns the existing project on 200**. That is correct behavior for *our own* redeploys, but with a name-derived slug it means the second creator's deploy **attaches to the first creator's Pages project and overwrites its `main` branch** — i.e. user B's publish replaces user A's live site, and A's `liveUrl` (which points at that project's stable subdomain, `sites.ts:745`) keeps serving B's content forever after.

The platform makes this guaranteed, not theoretical: when a premium site names no BYO credential, `credentialId` is NULL and the deploy resolves **the shared platform Cloudflare account** (`lib/hosting/sites.ts:24`, schema comment `3335-3337`, and the §19.2 note at `sites.ts:222`). Every such premium user deploys into **one CF account**, so the second user to pick any already-used name silently hijacks the first user's project. The same-name case also bites a **single user** (two of their own sites collide) and even one user typing three spellings that slugify identically.

**What is NOT broken (pin these):**
- The **local engine** is collision-free by construction — storage is `sites/<userId>/<siteId>` (`sites.ts:90-92`, siteId is a cuid) and preview/live lookups are by unique token (`schema.prisma:3340,3343,3394`). `cfProject` is NULL for local sites. Do not touch this path.
- `HostingSite.name` staying duplicate is **correct and intended** — it is an informational label (schema `3331-3332`). Two users may both label a site "Portfolio"; only the *engine identity* must differ. **The user-visible name does not change; only `cfProject` does.**

## 2. Design decision (owner-aligned)

**Make `cfProject` unique-by-construction at mint time: the slugified label + a per-site random suffix.**

- New helper in `lib/hosting/sites.ts`, e.g. `uniqueCfProject(name: string): string`:
  `slugifyProject(name).slice(0, 40)` + `"-"` + 7 lowercase-hex chars from `crypto.randomUUID()` (same `globalThis.crypto.getRandomValues` idiom as `newHostingToken`, `lib/hosting/rules.ts:337-341` — but hex, because Pages project names must be lowercase `[a-z0-9-]`; base64url contains uppercase and `_` and is **not** valid here).
- Length: 40 + 1 + 7 = **48 chars**, under Cloudflare's project-name limit (slugify's existing `slice(0, 50)` shows the limit is tight; keep the head shorter so head+suffix fits — verify the 58-char limit assumption when implementing).
- Use it at `sites.ts:246` (the only creation site — confirmed: `hostingSite.create` appears exactly once in the codebase).
- **Fix the deploy fallback too** — `sites.ts:705` `site.cfProject ?? slugifyProject(site.name)` re-derives a *colliding* slug for any legacy row with NULL `cfProject`. Replace with lazy healing: mint a unique name, **persist it to the row**, and deploy under it. (See §5 owner decision — this moves those sites' live URLs once.)
- **Do NOT add a `@unique` index.** The random suffix makes a DB index unnecessary for correctness, and adding one would require a migration + drift check for zero gain — plus a unique index on a column that may *already contain duplicates in prod* would fail to apply. Out of scope; see traps.

Why random-suffix over check-then-create: a "does this slug already exist in our DB?" loop is racy (two concurrent creates pass the check together) and still can't see names that exist **only in Cloudflare** (a BYO user's own pre-existing project). A random suffix is atomic, race-free, and collision-free by construction. The residual hazard — a BYO user happening to own an external project named exactly `my-portfolio-1a2b3c4` — is vanishingly unlikely and pre-existing in kind; note it in the code comment, don't engineer around it.


## 3. Files in scope (MAY TOUCH)

| File | Change |
|---|---|
| `lib/hosting/sites.ts` | Add `uniqueCfProject()`; use it at creation (L246); replace the L705 re-derivation fallback with mint+persist lazy healing; update the stale "slugified from `name`" comment. |
| `tests/hosting-pages.test.ts` | Extend the existing block (slugify test at L765) with the tests in §4. |

**No UI change.** `components/hosting-panel.tsx` needs nothing — it posts the label to `/api/hosting/sites` (L509) and displays `name`/`liveUrl`; both stay correct. `liveUrl` follows the granted subdomain automatically (the TASK_158 W1 fix at `sites.ts:745` already reads the *granted* subdomain), so once projects are unique each site's URL is naturally its own.

## 4. Required tests (node:test, run via `npm test` → `tsx --test tests/*.test.ts`)

1. **Same label, different sites** — two `uniqueCfProject("Portfolio")` calls (or two `createSite` calls with the fake prisma) return **different** values. This is the headline owner requirement; make the failure message say what it protects (user B overwriting user A).
2. **Charset + shape** — every minted value matches `/^[a-z0-9][a-z0-9-]*[a-z0-9]$/`, length ≤ 58, no double/trailing hyphen.
3. **Edge labels** — `"   "` and `"!!!"` (slug → `"site"`) still mint a valid unique name; a 200-char label is clamped by head-slice + suffix, never over the limit.
4. **Determinism pin on the deploy path** — a row with `cfProject` already set deploys under **exactly that stored value** (never re-slugifies) — pins the `site.cfProject ??` precedence so nobody regresses it.
5. **Lazy heal** — a cloudflare row with `cfProject: null` gets a fresh unique name **persisted to the row** before deploy is invoked with it (assert the fake prisma's update was called, not just the deploy).
6. **Local engine untouched** — a `local` site still stores `cfProject: null` and its serve paths are unchanged (regression pin).
7. **Cross-user isolation via platform account** — two different `userId`s creating the same label resolve to two different project names (the exact 2-user scenario from the owner's report).

Follow the house rule for fake prisma delegates: the fake must genuinely implement every method the new code calls (`update` for the lazy-heal persist) — **a test that passes because it bails early is green for the wrong reason.**

## 5. Owner decisions to FLAG, not resolve

1. **Existing colliding rows (live now).** The fix heals *new* sites. Rows already sharing a `cfProject` keep sharing until acted on. Before merging, the senior verification agent should run on the box:
   - `SELECT "cfProject", COUNT(*) FROM "HostingSite" WHERE "cfProject" IS NOT NULL GROUP BY 1 HAVING COUNT(*) > 1;`
   - `SELECT COUNT(*) FROM "HostingSite" WHERE engine = 'cloudflare' AND "cfProject" IS NULL;`
   Report the counts to the owner. Possible remediation (owner's call, separate task): (a) leave as-is, (b) a backfill that re-mints `cfProject` for duplicate groups — note this **moves those sites' live URLs to a new Pages project once**, which is disruptive and must not ship without explicit approval.
2. **Lazy-heal URL move.** The L705 fix means legacy NULL-`cfProject` rows deploy to a new unique project and their `liveUrl` changes on next publish. Correct behavior (today they'd collide), but user-visible — call it out in the deploy-ready report.
3. **Deleting the legacy shared projects on Cloudflare** (freeing names) — explicitly NOT in scope; deleting CF resources needs its own approval per the playbook.

## 6. MUST NOT TOUCH

- `prisma/schema.prisma` — **no migration, no schema change** this task.
- `lib/hosting/cloudflare.ts` — `ensureProject`'s reuse-by-name semantics are **correct** (it is how redeploys avoid recreating the project every publish) and was hardened once already for the `subdomains`-vs-`subdomain` response shape (L278-285). The fix is on our side of the name, not Cloudflare's side of the lookup.
- The local engine serve/preview/live-token paths (`resolveSiteServe`, tokens, `siteDir`).
- Any deploy/merge/CI action — build + test only, report back. Shipping is the senior verification agent's job after the owner's 🚦 GO.

## 7. Report format (per PROMPT_NEXT_AGENT.md §7)

Report exactly: task number · files touched with line refs · `npx tsc --noEmit -p .` output (must be 0 errors) · `npm test` counts (paste the tail; the floor is recorded in the prompt docs) · the 7 test names added · whether anything about the local engine changed (expected: **nothing**) · any surprise. Then write `TASK_225_STEPS.md` with every step checked and evidence.
