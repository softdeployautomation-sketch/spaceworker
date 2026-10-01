# PROMPT — NEXT SENIOR AGENT (Task 155: deploy, then P3)

> **Self-contained, copy-paste prompt.** Paste the entire `TASK BLOCK` below into the next senior
> agent. It supersedes the D1 instantiated prompt in `PROMPTS_SENIOR_ENGINEERS.md`
> §"Owner-requested design work" — that block still says "START D1 AT P2", which is now **stale**:
> **P2 is built** (see VERIFIED STATE). Everything the agent needs is in this file plus the three
> docs it names.

---

## TASK BLOCK (paste from here)

```
TREE:            /Users/mikeolab/spaceworker           (branch: main)
TASK:            D1 / Task 155 - "Workers & Pages" (the Hosting tab).
                 YOU START AT:  (a) DEPLOY what is already built, (b) P3 - the Pages engine
                 (BYO token), (c) close the owner's follow-ups: Cyber Lab caps wired into admin,
                 and the RAM dials recorded for the later resource-governor task.
TASK DOCS:       PLAN_TASK_155_WORKERS_AND_PAGES.md       read section 13 FIRST (it BINDS the
                                                          build), then 9 (phases), 14 (caps),
                                                          15 (public host), 3/5/11.
                 PLAN_TASK_156_CYBERLAB_REAL_WORLD_TOOLS.md  only sections 6/10 (the caps you wire).
                 SENIOR_HANDOFF.md                        sections 3, 4, 5 (traps), 8, 9, 10.
                 PROMPT_NEXT_AGENT.md                     this file (current state + asks).
DEPENDS ON:      Nothing external. P1 (`a131835`) and P2 (see VERIFIED STATE) are built, proven
                 and pushed. The throwaway Cloudflare account/token from PLAN 13.2 is in the
                 gitignored `.env` (CLOUDFLARE_API_TOKEN_DEV / CLOUDFLARE_ACCOUNT_ID_DEV) and is
                 for P3 dev. START NOW.
BRANCH:          main
DEPLOY?          **yes - and flipping hostingEnabled=true is the point of this run.**
                 Owner (2026-10-01): "go ahead with deploy ... flip it when you deploy and we test
                 to see how it works". ORDER: deploy code + migration FIRST, add the nginx
                 `location /hf/` proxy on the `dl.instaweb.top` vhost, THEN flip the switch, then
                 verify a user-visible URL 200s from the public internet.
```

## OWNER'S ASKS FROM 2026-10-01 (these BIND; do not re-litigate)

```
A1  "whats the plan for the ui, the cyberlab and workers should be added to the menu and dashboard
     cards"  ->  ALREADY DONE in P2 (see VERIFIED STATE). Prove it; do not rebuild it.
A2  "go ahead with deploy" + "flip it when we deploy and we test to see how it works"  ->  deploy,
     then set AdminSetting.hostingEnabled = true.
A3  "go ahead with the ssh to get the nginx you need"  ->  authorised to SSH to the VPS and add
     the location /hf/ proxy.
A4  "P2 scope is right ... we need both options available and an option for users to add their own
     cf tokens and id"  ->  TWO credential sources: PLATFORM (ours) and BYO (the user's own
     Cloudflare account id + token).
A5  "if users add multiple like 3, we should be able to switch between them ... lets start with one
     first"  ->  the multi-credential STORE + SWITCHER is P2 (done). P3 USES one; switching between
     accounts DURING a deploy is P5.
A6  "use the throwaway cf acct for p3"  ->  P3 dev/deploy against the throwaway account.
A7  "yeah you can add the cyberlabs cap to admin"  ->  Cyber Lab caps in the admin panel (P2 built
     the route + panel; wire it into the admin UI properly and prove a save persists).
A8  "if its going to take a lot of ram ... we need every hard load monitored and queued properly,
     so the governor can also adjust"  ->  BUILD FIRST. Do NOT touch lib/resource-governor.ts in
     this run; that is a SEPARATE, LATER task. Just leave the RAM dials recorded (they already are).
A9  "for now we dont need converters, just the rename of file upload is enough for file store"  ->
     do NOT build converters. P4 is OFF. Rename-with-unchanged-bytes IS the whole file feature.
```

## VERIFIED STATE AT HANDOFF (read this before you touch anything)

**P1 — `a131835` — FILES on our own metal.** Built, proven (26 tests + live E2E), pushed. **NOT
deployed.** Files: `lib/hosting/{providers,rules,files}.ts`, `app/api/hosting/{status,files}`,
`app/hf/[token]/route.ts`, `app/dashboard/hosting/page.tsx`, `components/hosting-panel.tsx`,
`app/api/admin/hosting/route.ts`, migration `20261028000000_task155_p1_hosting_files`. Ships
**dark** (`AdminSetting.hostingEnabled = false`).

**P2 — `<P2 SHA>` — REDIRECTS (user-owned) + BYO credential store + Cyber Lab scaffolding.** Built
and green at handoff: `npx tsc --noEmit` -> 0, `npm run test:hosting` -> **39/39**. New:
- `lib/hosting/links.ts` — user-owned `/r/<slug|token>` links: create/list/update/delete,
  `resolveLink`, `recordLinkClick`. Reuses the Task 30 `LinkRedirect` row (new NULLABLE
  `userId`/`slug` columns), so **existing anonymous campaign links are untouched**.
- `lib/hosting/credentials.ts` — `HostingCredential` rows; the token is **AES-256-GCM encrypted**
  via `lib/mailbox-crypto.ts`; the list returns only a 4-char hint; `getDefaultHostingCredential()`
  decrypts for the engine. Multi-account ready (`isDefault`, exactly one default per provider).
- `app/api/hosting/links`, `app/api/hosting/links/[id]`, `app/api/hosting/credentials`,
  `app/api/hosting/credentials/[id]`, `app/api/hosting/credentials/[id]/default`.
- `app/r/[token]/route.ts` — now resolves a **user-owned slug OR a campaign token**.
- `app/api/cyberlab/status`, `app/api/admin/cyberlab`, `components/cyberlab-panel.tsx`,
  `app/dashboard/cyberlab/page.tsx` — Cyber Lab nav/card/panel + admin RAM dials (dark).
- `components/dashboard-nav.tsx` — **"Hosting" AND "Cyber Lab" nav items** (A1 done).
- `app/dashboard/page.tsx` — **overview cards for both** (A1 done).
- `prisma/migrations/20261028000001_task155_p2_links_credentials_caps` — additive: 9 `AdminSetting`
  columns (`hostingFreeMaxLinks` + 8 `cyberlab*`), `LinkRedirect.userId`/`slug` (nullable +
  indexed), new empty `HostingCredential` table. **Rewrites no row.**
- `tests/hosting-links-credentials.test.ts` — 13 tests.

**What is NOT verified / NOT done (your job):**
1. **Neither P1 nor P2 is deployed.** The migration is unrun on production.
2. **`dl.instaweb.top` has no `location /hf/`** -> a minted file URL 404s in the real world.
3. **P3 does not exist** (the Pages engine, BYO token).
4. **The Cloudflare engine for FILES is registered but `not_ready`** (`lib/hosting/providers.ts`) —
   the registry lists it; the upload path refuses it with a typed error. A4's "use both options"
   for *files* is P4/P5 (R2/Pages), **not** this run.
5. The governor does **not** know about hosting or lab RAM (A8 — deliberately deferred).


## DO IT IN THIS ORDER — do not skip a step

1. **REPRODUCE FIRST.** Before changing a line, produce the failing raw output for each thing you
   fix. For the deploy: `curl -sS -o /dev/null -w '%{http_code}\n' https://dl.instaweb.top/hf/deadbeef`
   must be **404/502 today** (proves the nginx gap, not a code gap). For the UI: today
   `/dashboard/hosting` and `/dashboard/cyberlab` do not exist in production. For a P2 link: mint
   one, click it, show the click counter move. Paste it all.
2. **READ PLAN section 13 of PLAN_TASK_155.** It binds the build. If you disagree, say so with
   evidence — do not silently work around it.
3. **DEPLOY (code + migration), then wire nginx, then flip the switch.**
   - `gh workflow run deploy.yml --ref main` -> `gh run list --workflow=deploy.yml --limit 3` ->
     `gh run view <run_id> --json status,conclusion,headSha`.
   - **Run the migration** (HOW_WE_MOVE_FAST rule 2; both are purely additive):
     `ssh -i ~/.ssh/tacticalrmm_vps -o StrictHostKeyChecking=no root@164.68.105.96 \
        'cd /opt/spaceworker && npx prisma migrate deploy'`.
   - Verify the deploy is real (green != works):
     `ssh ... 'cat /opt/spaceworker/.next/BUILD_ID; stat -c %y /opt/spaceworker/.next/BUILD_ID; systemctl --failed'`
     and **grep the BUILT chunks** under `/opt/spaceworker/.next/static` for a string you changed
     (`components/` and `lib/` are NOT shipped, so a source-tree grep proves nothing).
   - **nginx:** find the `dl.instaweb.top` server block
     (`ssh ... 'grep -rn "dl.instaweb" /etc/nginx/sites-enabled /etc/nginx/conf.d'`), add a
     `location /hf/ { proxy_pass http://127.0.0.1:<app port>; ... }` beside the existing
     `/e/` + `/downloads/` locations, `nginx -t && systemctl reload nginx`. **Do not touch the
     `/e/` or `/downloads/` locations** — they serve live customer files.
   - **Flip:** `PATCH /api/admin/hosting` `{ "enabled": true }` with an admin cookie (or the admin
     UI). This is the A2 moment.
4. **PROVE IT PASSES — same command, raw output, before AND after:**
   - `npx tsc --noEmit` -> exit 0
   - `CI=1 npx next build` -> success
   - `npm run test:hosting` (CI does NOT run `test:*` — you must) and **every** other `test:*` suite
     you could have touched.
   - **User-visible proof (A1 + A2):** with a real browser (Playwright is installed), log in, see
     the **Hosting** and **Cyber Lab** cards on `/dashboard`, open `/dashboard/hosting`, upload a
     file, rename it, copy the `/hf/<token>` link, `curl` it from a shell **on the public internet**
     and assert `200` + matching sha256. Screenshot the tab. A green build that changed nothing the
     user can see is the exact failure that produced TASK_153.
5. **BROKEN-NOTHING CHECK.** `curl` the live `/e/...` and `/downloads/...` endpoints and a campaign
   `/r/<token>` redirect before and after the nginx edit — byte-identical behaviour.
6. **COMMIT** — explicit paths only, never `-A`, never `.`:
   `git add <path1> <path2> ...` -> `git commit -m "feat(hosting): Task 155 P3 - Pages engine (BYO token)"`
   -> `git push origin main:main`.
7. **UPDATE THE HANDOFF (section 10 — same session):** section 6 last-verified date/HEAD/deployed
   BUILD_ID/sync, section 7 strike your item + promote what's next, section 5 any NEW trap with the
   evidence that proved it, section 12 one log entry (Did / Verified / NOT verified / State left
   behind / Next), and mark the item done in `PLAN_TASK_155_WORKERS_AND_PAGES.md`. Commit + push
   those docs (explicit paths).


## FILES YOU MAY TOUCH / MUST NOT TOUCH

**MAY TOUCH:** `lib/hosting/*.ts` (new files you add), `app/api/hosting/**`,
`app/dashboard/hosting/**`, `components/hosting*.tsx`, `app/api/cyberlab/**`,
`app/api/admin/cyberlab/route.ts`, `app/dashboard/cyberlab/**`, `components/cyberlab-panel.tsx`,
`app/admin/(protected)/admin-panel.tsx` (only the hosting/cyberlab panels), `prisma/schema.prisma`
(ADDITIVE only) + exactly ONE additive migration, `tests/*.test.ts`, `.env.example`, `deploy/*`
(nginx), and the docs. Reuse `lib/mailbox-crypto.ts` — **do not fork it**.

**MUST NOT TOUCH:** `lib/resource-governor.ts` (A8 — a separate, later task), `lib/agent.ts`,
`lib/clone*.ts`, the current behaviour of `/e/`, `/downloads/`, or a campaign `/r/<token>`, any
already-applied migration, and anything on the `self-hosted-build` branch.

## NON-NEGOTIABLE (from PLAN 13/14/15 + 11)

- The Cloudflare token is **SERVER-ONLY** — never in a client bundle, a log line, an AI prompt, or
  an error message. BYO tokens are **encrypted at rest** and never echoed back (P2 does this; keep it).
- **No cap is a hard-coded literal.** Every limit is a named `AdminSetting` field, read server-side,
  editable in admin, enforced with a clear message (never a 500).
- **Never serve user bytes from the main `spaceworker.top` app host.** Files come from the instaweb
  family (`dl.instaweb.top`, section 15); short links from the app host.
- An invalid/revoked BYO token **fails closed** with plain language — never a raw Cloudflare JSON dump.
- Cloudflare per-asset ceiling is **25 MiB** (`hostingPagesMaxAssetMb` must stay below it); pre-validate.
- Scan uploads (11.1); custom domains are **premium only**; never market links as "anonymous" (11.5).

## P3 ACCEPTANCE (the exit criterion)

> Owner's words: *"build me a landing page for X" -> a real public URL, produced end-to-end.*
>
> Concretely: in the Hosting tab the user opens **Connection**, pastes their own Cloudflare account
> id + a scoped token (or picks the platform/throwaway one); the app **verifies on save** and shows
> a green health row; then a template is deployed and a live `*.pages.dev` URL is returned; and the
> **agent** can do the whole thing as a **gated** proposal (`AgentPendingAction` kind `"hosting"`),
> never a silent write. Capture: the HTTP status + the live URL fetched from the public internet +
> a screenshot of the Connection pane.

## LAST — what you must NOT start

- **Converters** (A9 — off; P4).
- **Switching accounts during a deploy** (A5 "start with one" — the *store* is P2; the *switch
  during a job* is P5).
- **Resource-governor changes** (A8: *"lets build first, and when we are done, we will update the
  governor"*). Do not edit `lib/resource-governor.ts`. The Cyber Lab RAM dials (`rangeRamMb`,
  `hostRamBudgetMb`) are recorded in `AdminSetting` so the governor task has them — that is all you
  do about the governor in this run.
- **Task 156 C2+** (anything that attacks a host). Cyber Lab here is **caps + nav/card only**.
- **Anything on `self-hosted-build`.**

REPORT BACK WITH EXACTLY: files + line ranges changed; the raw BEFORE output; the raw AFTER output;
the exact commands you ran; what you could NOT verify (expected, not a weakness); the commit SHA(s);
and confirmation the handoff is updated. LABEL ANYTHING SIMULATED AS "SIMULATION".
STOP WHEN YOUR TASK IS DONE. Do not start the next item. Do not deploy someone else's work.

