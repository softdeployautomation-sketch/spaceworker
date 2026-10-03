# PLAN — Task 155: Workers & Pages (hosting, redirects, files, converters)

**Status: P1 + P2 BUILT, PROVEN, DEPLOYED and LIVE (2026-10-02) — the Hosting tab is public and
`hostingEnabled = true`. Next: **P3 (the Pages engine + folder/zip → preview → publish + the
server/premium engine switch)** — §16 BINDS that build.**
**v1 = BOTH engines, side by side** — our own metal (free) **and** Cloudflare/Pages (premium,
platform token). The user picks per item; the picker is in the tab, never a config file.
**All caps are admin-editable (§14) — decided by the engineer, changed by the owner in admin —
and they apply to the PREMIUM engine too (§16.3): our Cloudflare account is a shared, finite
resource, so "premium" is capped as well.**
**User files are served from the instaweb public family, never the main `spaceworker` host (§15).**
**Folders go up as a ZIP, we extract them, and they land on a PREVIEW URL first — the user then
presses Publish and only then does production change (§16.1).**
**Converters are OFF (§16.5 — decided 2026-10-02): rename-with-unchanged-bytes is the whole file
feature until the box gets more RAM.**
**Companion doc: `PLAN_TASK_156_CYBERLAB_REAL_WORLD_TOOLS.md` — these two ship hand in hand.**

**Owner's one-line version:** give every SpaceWorker user **one place to put something on
the internet and get a link** — a web page, a redirect/short link, a file (including a
*renameable* EXE) — with **Cloudflare Workers/Pages** as the engine, our
own **`dl.*` host** as the free tier, and **the agent doing the work**, so a user with zero
hosting experience never sees a dashboard, a CLI, or a token. *(File conversion is deferred —
§16.5.)*

---

## 1. Why this is a real product (not a "Cloudflare clone")

Cloudflare is a developer platform: to publish anything you must create an account, make a
token, install `wrangler`, learn a build step, and understand projects vs scripts vs buckets
vs lists. That is exactly the wall our users hit. Three things make our version *better* for
them, and none of them is "we re-implement Cloudflare":

1. **The agent is the interface.** The user types/says what they want ("put this PDF online
   as `quote.pdf`", "make `/go` redirect to my landing page", "convert these 40 images to
   webp and host them"); the agent assembles the artifact, deploys it, and returns **one
   link**. No dashboard, no token UI unless the user *wants* to bring their own.
2. **It is already half-built, for free, on our own metal.** `/opt/spaceworker/downloads/` is
   served by the **existing `dl.broks.beauty` / `dl.instaweb.top`** vhosts as **origin-masked
   streaming** (`/d/<jobId>`, `/e/<name>`, `/spaceworker/`, `/vantra/`) with immutable caching —
   and the VPS has **119 GB free** (`/dev/sda1 146G, 27G used, 19%`, read 2026-10-01). Our free
   tier does not need Cloudflare at all; Cloudflare is the *scale + custom-domain + global-edge*
   tier.
3. **Cloudflare's free tier is genuinely free and its API is genuinely automatable** (§2):
   unlimited static requests/bandwidth on Pages, Direct Upload requires **no build step**, and
   the whole thing is a handful of REST calls. So "free first" is not a compromise — it is the
   correct starting architecture.

**The second half of the product is the part Cloudflare will *never* do:** we can also host
the artifacts the **Cyber Lab** needs (payload hosts, phishing-simulation landing pages,
redirect infra) on the *same* rails, which is why Task 155 and Task 156 are a pair
(see `PLAN_TASK_156...md` §3).

---

## 2. Research anchors — read from live Cloudflare docs on 2026-10-01

> Everything in this table was fetched from `developers.cloudflare.com` **in this session**.
> Where a number could not be confirmed from the page I read, it says so explicitly.

| # | Fact | Value / shape | Source |
|---|---|---|---|
| R1 | Pages **projects per account** (Free) | **100** (not routinely raised; use Workers-for-Platforms beyond) | `/pages/platform/limits/` |
| R2 | Pages **files per deployment** | **20,000** (Wrangler/Direct Upload) · **1,000** (drag-and-drop) | `/pages/get-started/direct-upload/` |
| R3 | Pages **max single file size** | **25 MiB** (both upload methods) | `/pages/get-started/direct-upload/` |
| R4 | Pages **builds/month** (Free) | **500** — documented as *"each time you push new code to your Git repository"* → Direct Upload is not a build (**confirm at build time — NOT re-verified here**) | `/pages/platform/limits/` |
| R5 | Pages **custom domains per project** | **100** (Free) | `/pages/platform/limits/` |
| R6 | Pages **static serving cost** | Static assets served from the edge; no per-request charge documented on Free | `/pages/platform/limits/` |
| R7 | `_redirects` file limits | **2,000 static + 100 dynamic = 2,100**; 1,000 chars/rule; 100 header rules, 2,000 chars/header | `/pages/configuration/redirects/` |
| R8 | Direct Upload is a **one-way door** | *"If you choose Direct Upload, you cannot switch to Git integration later."* | `/pages/get-started/direct-upload/` |
| R9 | Pages **REST API** | `GET/POST /accounts/{acct}/pages/projects`; `GET/POST /accounts/{acct}/pages/projects/{project}/deployments`; project object carries `subdomain`, `domains`, `canonical_deployment.url`. Token perms **Pages Read / Pages Write** | `/pages/configuration/api/` |
| R10 | Direct Upload via CLI | `CLOUDFLARE_ACCOUNT_ID=<id> npx wrangler pages deploy <dir> --project-name=<p>`; token template = **Account → Cloudflare Pages → Edit** | `/pages/how-to/use-direct-upload-with-continuous-integration/` |
| R11 | **Bulk Redirects** API | create list (`Account > Bulk URL Redirects > Edit`), add items, then attach via an account **ruleset** phase **`http_request_redirect`**, `action: redirect`, `action_parameters.from_list`. Also needs **`Account > Account Filter Lists > Edit`** | `/rules/url-forwarding/bulk-redirects/create-api/` |
| R12 | **R2 free tier** | **10 GB-month** storage, **1M Class A**, **10M Class B** ops/month, **egress free**. $0.015/GB-mo beyond | `/r2/platform/pricing/` |
| R13 | **R2 requires billing** | *"Complete the checkout flow to add an R2 subscription to your account. R2 is free to get started with included free monthly usage."* → **R2 is not card-free** | `/r2/get-started/` |
| R14 | Token model | **Account API tokens** (service tokens, preferred) vs **user tokens**; permission groups named per product (**Pages**, **Workers Scripts**, **Workers Routes**, **Bulk URL Redirects**, **Account Filter Lists**, **DNS** …) each Read/Edit; tokens can be created **via API** (`POST /accounts/{acct}/tokens`) and verified via `GET /user/tokens/verify` | `/fundamentals/api/...` |
| R15 | Workers **free plan** | Documented as **100,000 requests/day** + **10 ms CPU**/invocation. **NOT re-verified in this pass** — the pricing page's free-plan table cell was truncated on fetch. Confirm before sizing quotas | (to confirm) |
| R16 | `wrangler` is CI-safe | Non-interactive when `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` are set; supports versions + rollback | `/workers/wrangler/commands/` |
| R17 | Pages **preview vs production** (Direct Upload) | Chosen **per deployment**. A **non-production branch** ⇒ preview at **`<hash>.<project>.pages.dev`** plus a **branch alias** **`<branch>.<project>.pages.dev`** (branch lowercased, `/`→`-`). **Every preview carries `X-Robots-Tag: noindex` by default.** | `/pages/configuration/preview-deployments/` — fetched **2026-10-02**, page updated 2026-06-03 |
| R18 | Promoting a preview → **there is no promote API** | *"Rollbacks allow you to instantly revert your project to a previous **production** deployment… **preview deployments are not valid rollback targets**."* ⇒ **"Publish" = create a NEW production deployment with the same asset hashes**, not a promotion. | `/pages/configuration/rollbacks/` — fetched **2026-10-02**, page updated 2026-04-21 |
| R19 | **Zip / folder upload** | Wrangler takes **a single folder — "Zip files are not supported"**. Drag-and-drop takes **a zip OR a folder**. Limits: Wrangler **20,000 files**, drag-and-drop **1,000 files**, both **25 MiB/file**. | `/pages/get-started/direct-upload/` — fetched **2026-10-02**, page updated 2026-04-21 |
| R20 | **Production branch** on a **Direct Upload** project | Not settable in the dashboard — *"you will need to manually call the Update Project endpoint"*: `PATCH /accounts/{acct}/pages/projects/{project}` `{"production_branch":"main"}` | same page, *Troubleshoot → Production branch configuration* |

**R17–R20 are what make the owner's "folder → extract → preview → then live" flow (§16.1) mechanical:**
we cannot hand Cloudflare a zip (R19), so **we extract it ourselves** (`7z` is already on the box) and
push the file set with the raw REST flow proven in T0; we get a **preview** by deploying on a
non-production branch (R17); and "Publish" is **a second, production deployment of the same bytes**
(R18) — never a promotion call that does not exist.

**What I could NOT verify from the docs in this pass (do not treat as settled):** R4
(Direct-Upload/build-quota interaction), R15 (Workers free daily/CPU numbers), the exact
**attach-a-custom-domain-to-a-Pages-project** endpoint (`POST .../pages/projects/{p}/domains`),
and whether a Free-plan account can create tokens via API without extra scopes. Each is a
**T0 spike** in §9 before anything depends on it. *(2026-10-01: the throwaway account now exists
— §13.2 — so T0 is runnable; the token is `active` but its **Account ID** must be supplied first.)*

---

## 3. Hard constraints that decide the design

These are not opinions; each one changes what we can build. **They are the reason the
architecture in §4 has *three* engines instead of one.**

| Constraint | Consequence for us |
|---|---|
| **Pages rejects any file > 25 MiB** (R3) | **No EXE, no video, no big dataset can live on Pages.** Our SpaceWorker installer is far past 25 MiB. Big-file hosting must be **R2 (needs billing, R13)** or **our own `dl.*` host** (free, already exists). This single fact is why "host an exe" is *not* a Pages feature. |
| **R2 needs a card on file** (R13) | For the **platform-token free tier we cannot use R2**. Free tier = `dl.*` (our metal). R2 is the **premium / BYO-token / user's-own-account** path. |
| **100 Pages projects per account** (R1) | If *all* users shared **one** platform account, 100 projects is the entire ceiling across the whole customer base. → platform-token mode must be **quota'd and short-lived** (a "try it" tier), and the real product must be **BYO token** (user's own account → their own 100-project budget). |
| **Direct Upload is a one-way door** (R8) | We commit to the **API/Direct-Upload** model and must never plan to "add Git integration later" for the same project. |
| **2,100 `_redirects` max** (R7) | Mass redirects beyond that must use **Bulk Redirects** (account-level, R11) — which requires a **zone in the user's account**, so it is a BYO-token / custom-domain feature, not a `pages.dev` feature. |
| **Bulk Redirects need a zone** (R11) | Cheap tier = our `/r/<token>` redirect route **already live** (`app/r/[token]/route.ts` + `LinkRedirect`) → unlimited, free, no Cloudflare. Cloudflare redirects only when the user brings a **domain**. |
| **`wrangler` needs `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`** (R10/R16) | Server-side deployment is a **process spawn with env**, or (better) **raw REST multipart** — no interactive login ever. Prefer raw REST: fewer moving parts, no `node_modules` in the deploy path. |
| **The platform token is a live credential to real infrastructure** | It must be **server-only**, **never** in a client bundle, **never** in logs, and every write must produce an **audit row** (we already have `AgentActionAudit` / `ToolUsageLog`). Getting this wrong is the single worst failure mode in this plan. |

---

## 4. Architecture — three engines behind ONE tab

```
                    ┌───────────────────────────────────────────────┐
   user / agent ───▶│  Task 155 "Hosting" tab  (+ agent tools)       │
                    └──────────────┬────────────────────────────────┘
                                   │ one internal interface
        ┌──────────────────────────┼───────────────────────────────────┐
        ▼                          ▼                                   ▼
  ENGINE A: REDIRECT        ENGINE B: PAGES                     ENGINE C: FILES
  (links & short URLs)      (web pages / static sites)          (any file, EXE, big)
  ─────────────────         ──────────────────────────          ────────────────────
  FREE: our /r/<token>      FREE: BYO token + Direct Upload     FREE: our dl.* host
        (LIVE today)              (no build step)                    (/e/<name>, immutable)
  EDGE: Bulk Redirects      EDGE: custom domain on the user's    EDGE: R2 public bucket
        (BYO token + zone)        Pages project                       (BYO token + billing)
```

**Engine A — Redirects (cheapest, already live).** `LinkRedirect` + `/r/[token]` exist
(`lib/link-cloak.ts`, `app/r/[token]/route.ts`) and already power campaign cloaking. Extend,
do not replace: add **user-owned** redirects (not just campaign-owned), hit counting, an
expiry, and an optional **custom slug/host**. Cloudflare Bulk Redirects (R11) are the
*mass + custom domain* upgrade and attach to the user's own zone.

**Engine B — Pages (static sites).** A **project per hosted site**, created and deployed
over REST with **Direct Upload** (R9/R10): build the file tree in memory → `manifest` +
multipart POST → return `canonical_deployment.url`. No `wrangler`, no Git, no build.
Redirect-only sites get a generated `_redirects`. The **template library** (§6) supplies the
starting HTML so the agent edits an already-beautiful page instead of inventing one.

**Engine C — Files (anything, any size).**
- **Free (our metal, today):** upload to `/opt/spaceworker/downloads/hosting/<owner>/<id>/`,
  serve through the existing `dl.*` vhost with **origin-masked streaming** (`/e/<id>` pattern)
  and immutable caching. **119 GB free**, no card, no third party.
- **Premium (user's R2, R13):** for global edge delivery + free egress at scale; same API
  shape behind one interface.

**The naming/renaming insight (the owner's EXE question).** Renaming must **never touch the
bytes**. Store `sha256` + a stable storage path; "rename" writes **only** a DB row
(`displayName`, slug, `Content-Disposition` filename). The served filename is a *header*
(`attachment; filename="Whatever You Want.exe"`), so the artifact hash and any code signature
are **provably unchanged** — we can assert `sha256(before) == sha256(after)` as an acceptance
test. This is already the shape of the live `/e/<name>` route; we are productizing it, not
inventing it.

---

## 5. The token model — the owner's exact question, answered

The owner asked: *"can we add a backend token from Cloudflare free so users can test it out…
also allow users to add their own API token… and I can pay for my own Cloudflare for premium
users. or add multiple Cloudflare accounts and switch."* **All four are buildable. Here is
the recommended shape.**

**Mode 1 — PLATFORM token (free "try it" tier).** One Cloudflare account owned by us, token
in `.env` (server-only, same discipline as `SESSION_SECRET`). Users who have **not** connected
their own token can create **1 site + N redirects + M MB of files**, hard-capped per user.
Because **100 projects is the whole account** (R1), this mode must be **quota'd, rate-limited
and reclaimable** (idle projects deleted after X days; the cap is an `AdminSetting`
per CROSS-TRACK RULE 7, surfaced with live counts in the admin panel).
*This is the "test it out" tier the owner asked for, and it is safe because it is capped.*

**Mode 2 — BYO token (the real product).** The user pastes a **scoped** Cloudflare token; we
store it **encrypted at rest** (reuse `MAILBOX_ENCRYPTION_KEY` + the `lib/mailbox-crypto.ts`
pattern — do **not** invent a second crypto path), never return it to the client, and verify
it on save with `GET /user/tokens/verify` (R14). Required scopes are shown as a **copy-paste
checklist** in the UI: **Account → Cloudflare Pages → Edit**, **Account → Workers Scripts →
Edit**, **Account → Bulk URL Redirects → Edit** + **Account → Account Filter Lists → Edit**
(only if they want mass redirects), **Zone → DNS → Edit** (only if they want a custom domain).
Their account, their quota, their bill — no platform ceiling.

**Mode 3 — MANAGED / PREMIUM pool (owner pays).** Owner's paid Cloudflare, with **N accounts
in a pool** and a **switcher**: each account gets a label + its project count; the allocator
picks the pool account with the most headroom (R1 says why: 100 projects/account). The pool is
**admin-only config** (add/disable/label/default), never client-visible.

**Token-creation via API (`POST /accounts/{acct}/tokens`, R14) — deliberately NOT the default.**
Auto-provisioning a token for a user by *we* creating it in *their* account is an unusual,
high-privilege flow. **Phase 1 = the user creates the token themselves** (guided copy-paste,
exactly the Cloudflare UI wording). Revisit auto-creation only if real users fail the manual
step.

**Non-negotiable rules for all three modes:**
1. Tokens are **server-only**; they never enter a client bundle, an AI prompt, a log line, or
   an error message. (Mirrors the existing "secrets classes" rule for browser credentials.)
2. **Every** Cloudflare mutation → an audit row (who, which account/token mode, action,
   target, result). Agent-initiated hosting is a **gated proposal** like every other mutating
   action (CROSS-TRACK RULE 1).
3. A **revoked/invalid token** must fail **closed** with a plain-language, actionable error —
   never a raw Cloudflare JSON dump to the user.

---

## 6. Feature surface

| Feature | What the user gets | Engine | Free? |
|---|---|---|---|
| **Host a page** | "Make me a landing page for X" → agent edits a template → live URL | B (Pages) → C (our host) fallback | BYO token free; platform token = 1 site |
| **Template library** | A set of already-beautiful, responsive HTML templates (landing, link-in-bio, product, docs, 404, coming-soon, email-capture) the agent **reads and redesigns** rather than inventing from scratch | B | ✅ |
| **Redirect links** | `/go` → any URL; custom slug; optional custom domain; click counts | A | ✅ (ours) / BYO (CF) |
| **Bulk redirects** | Upload/import a CSV of thousands of redirects | A + CF Bulk Redirects (R11) | BYO + zone |
| **File hosting** | Upload any file, get a link; set expiry; make public/private | C | ✅ (our `dl.*`) |
| **Rename without rebuild** | Serve the same bytes under a new filename (`Content-Disposition`), hash unchanged (§4) | C | ✅ |
| **Folder → site** | Drop a **`.zip`** → we **extract** it → a **preview** URL → **Publish** to a live URL (§16.1); last 3 revisions undoable | B or C | ✅ (our host) / premium (Pages) |
| **Engine switch, per item** | "Our server (free)" or "Premium (Cloudflare)" — a **migration**, never a silent fallback (§16.2) | B ↔ C | both available |
| **Bring your own Cloudflare** | Add your own account id + scoped token; stored encrypted; **several accounts**, one default (§16.4) | B | ✅ |
| ~~**File type converter**~~ | **OFF (§16.5)** — images/docs/video conversion is deferred until the box is upgraded; rename-with-unchanged-bytes is the whole file story for now | — | — |
| **Agent does it all** | "host this, rename it, give me the link" as one gated action | all | ✅ |

**Template library is a real deliverable, not a folder of HTML.** It ships in-repo
(`public/hosting-templates/<slug>/index.html` + `meta.json`), is rendered in the UI as
thumbnails, and the agent receives the template's markup as its starting point. The owner's
requirement — *"nice ones already made, so the agent can just read that and redesign for the
user"* — is satisfied by this being **curated, branded, and versioned**, not generated.

---

## 7. Schema (draft — hand-written SQL per HOW_WE_MOVE_FAST / MICHAEL_BRIEF rule 2)

- `HostedAsset` — the one row per hosted thing: `userId`, `kind` (`page`|`redirect`|`file`),
  `name`, `slug`, `storagePath`, `sha256`, `bytes`, `mime`, `dispositionFilename`, `visibility`,
  `expiresAt`, `provider` (`platform`|`byo`|`managed`|`local`), `externalId` (Pages project /
  R2 key / CF list item id), `url`, `status`, timestamps.
- `HostingProject` — a Pages project we own/mirror: `userId`, `provider`, `accountLabel`,
  `projectName`, `subdomain`, `customDomain`, `lastDeployId`, `lastDeployedAt`.
- `HostingRedirect` — extends/parallels `LinkRedirect` for **user-owned** redirects:
  `userId`, `sourcePath`, `target`, `statusCode`, `host`, `provider`, `externalId`, `hits`.
- `HostingCredential` — BYO token: `userId`, `label`, `accountId`, `tokenEnc` (AES-GCM via the
  existing crypto helper — **never plaintext**), `scopesJson`, `verifiedAt`, `lastError`.
- `HostingAccount` — the managed pool (Mode 3): `label`, `accountId`, `tokenEnc`, `enabled`,
  `projectCount`, `isDefault` (admin-only).
- `HostingJob` — long-running deploy/convert work (reuses `JobQueueEntry`/governor patterns if
  it should be queued under RAM pressure).

**Reuse, don't duplicate:** audit rides `AgentActionAudit`; approval rides
`AgentPendingAction` (add kind `"hosting"`); limits ride `AdminSetting` (CROSS-TRACK RULE 7).

---

## 8. UI

- **Nav item "Hosting"** — one entry in `NAV_ITEMS` (`components/dashboard-nav.tsx`) + a matching
  **dashboard card**; the dock/mobile nav are generated from that single array, so this is a
  one-line change that cannot drift. **Shipped in P1/P2** (with **Cyber Lab** alongside it).
- **Sections (P3 final shape):**
  - ***Sites*** — cards with thumbnail + engine badge (**"Our server"** / **"Premium"**) + URL + open/copy.
  - ***Folder*** — the §16.1 flow: drop a **`.zip`** → **Extract + analyse** (file tree, total bytes,
    *"3 files skipped, 1 over the limit"*) → **Preview** (badged *"not live"*) → **Publish**; the last
    **3 published revisions** are listed with a one-click **undo**.
  - ***Links*** — list + create (P2: user-owned `/r/<slug|token>`, hit counts).
  - ***Files*** — upload, **rename** (bytes provably unchanged), **delete**, expiry. **No convert** (§16.5).
  - ***Connection*** — the §16.4 **account chooser**: one row per credential (platform + each BYO),
    label · account id · **4-char token hint only** · last-verified stamp · project count · **"Use for
    new deploys"** radio. Health is green/red from a verify-on-save; a dead token fails **closed**.
  - ***Templates*** — the P4 gallery (seeded with a few; a template deploys in two clicks).
- **Zero-experience path first:** the top of the tab is **not** a dashboard — it is a
  one-sentence box ("What do you want to put online?") that hands off to the agent.
- **One picker per item, never a global toggle** (§16.2): *Our server (free)* vs *Premium (Cloudflare)*.
  Switching engines is an explicit **migration** (preview on the new engine → publish → retire the old),
  never a silent fallback, and is **locked for the duration of a running job**.
- **EXE build target:** hosting is web-only → these hrefs are added to the EXE exclusion logic the
  same way `BUILD_ALLOWED_HREFS` (`components/dashboard-nav.tsx`) already narrows the extractor build.

---

## 9. Phased delivery — free first

### T0 — Spikes (DONE 2026-10-01 — raw evidence below; no user-facing code)
- **S0-a — facts confirmed.** Read from live Cloudflare docs (2026-10-01) **and** probed with the
  throwaway account:
  - **R1** Pages projects/account = **100** (Free). (Account currently holds **6**.)
  - **R3** max single asset = **25 MiB** (`MAX_ASSET_SIZE = 25 * 1024 * 1024` in wrangler).
  - **R4 RESOLVED** — **500 builds/month** (Free), and the docs tie a *build* to
    *"each time you push new code to your Git repository"* ⇒ **Direct Upload is NOT a build**; it
    does not consume the 500. (Direct Upload still shares the 100-project / 20 000-file / 25 MiB
    limits.)
  - **R5** custom domains **per project** = **100** (Free).
  - **R7** `_redirects`: **2 100** rules (2 000 static + 100 dynamic) — Bulk Redirects needed beyond.
  - **R15 (Workers Free)** — Workers has its **own** limit (100 Workers on Free, separate from the
    100 Pages projects); the Workers-free *requests/day* number was **not cleanly captured** in the
    truncated doc fetch — **still to confirm** before P5.
  - **Custom-domain endpoint** = `POST /accounts/{account_id}/pages/projects/{project_name}/domains`
    (permission: Pages **Edit**). Not yet *executed* (premium-only, §13).
- **S0-b — Direct Upload over raw REST: PROVEN LIVE.** The full protocol, executed against the
  throwaway account (`sw-t0-spike`, since deleted):
  1. `hashFile = blake3(base64(fileBytes) + extension)` → hex, **truncated to 32 chars**
     (`blake3-wasm` semantics; validated here with `@noble/hashes` against the `abc`
     test-vector `6437b3ac…9d85`).
  2. `GET  /accounts/{id}/pages/projects/{p}/upload-token` → `{jwt}` (short-lived, ~300 s).
  3. `POST /pages/assets/check-missing` `{hashes:[…]}` (Bearer **jwt**) → which hashes are absent.
  4. `POST /pages/assets/upload` → **JSON array** of
     `{key:hash, value:base64, metadata:{contentType}, base64:true}` (Bearer **jwt**) →
     `{"successful_key_count":3,"unsuccessful_keys":[]}`.
  5. `POST /pages/assets/upsert-hashes` `{hashes:[…]}` (Bearer **jwt**).
  6. `POST /accounts/{id}/pages/projects/{p}/deployments` — **multipart** with fields
     `manifest` (`{"/index.html":hash, …}`) + `branch` (Bearer **API token**, *not* the jwt).
     → deployment `id`, `url`, `latest_stage.status:"success"`.
  - **Verified live:** the production URL `https://sw-t0-spike.pages.dev/` returned **200
    `text/html`** with the exact uploaded HTML, and `/hello.txt` returned **200 `text/plain`** with
    the exact uploaded text (fetched via Node — the system `curl` is LibreSSL 3.3.6 and fails the
    TLS handshake; a **local-tooling gotcha**, not a Cloudflare problem).
  - **25 MiB rejection WITNESSED (bracketed):** `24 MiB → HTTP 200`, `25 MiB (26 214 400 B) →
    HTTP 200`, **`26 MiB → HTTP 500`** with an HTML error page titled
    *"Worker threw exception | api.pages.cloudflare.com"*. So the cap holds at 25 MiB, and
    **oversize is a 500, not a clean 4xx** ⇒ **our own cap must be `< 25 MiB`** and we must never
    forward an oversize body to Cloudflare (pre-validate).
- **Deliverable:** this note. **Nothing user-facing was built.** The throwaway project was
  **deleted** (account back to 6 projects).

### P1 — Files engine on our own metal (free, no Cloudflare at all) — ✅ **DONE + PROVEN 2026-10-01 (`a131835`) + DEPLOYED 2026-10-02 (live in `435d419`)**
- Upload/list/rename/delete; `Content-Disposition` rename with `sha256` unchanged;
  expiry; per-user quota (AdminSetting). Ships behind the `hosting` entitlement, **dark**.
- **Exit:** a user uploads an EXE, renames it, downloads it, and the hash matches.
- **Shipped:** `lib/hosting/{providers,rules,files}.ts`; `app/api/hosting/{status,files,files/[id]}`;
  `app/api/admin/hosting`; `app/hf/[token]` (the public serve route); `app/dashboard/hosting` +
  `components/hosting-panel.tsx` (customer tab); the admin **Infrastructure → “Hosting limits
  (Workers & Pages)”** panel (caps + live counters + engine picker); one **additive** migration
  `20261028000000_task155_p1_hosting_files` (10 defaulted `AdminSetting` columns + `HostedAsset` +
  `HostingUsageMonthly`); `tests/hosting-files.test.ts` + `npm run test:hosting`.
- **Proven (raw, local — NOT production):** `npx tsc --noEmit` → 0; `CI=1 npx next build` → exit 0
  with all 6 routes in the manifest; `npm run test:hosting` **26/26**; a live **E2E** on a scratch
  Postgres + real `next start` **36/36** (EXE upload → **201** with real sha256; `/hf/<token>` →
  200 byte-identical; **rename changes only `Content-Disposition`, sha256 identical**; `.php` → 400
  `blocked_extension`; EXE w/o ack → 400 `gated_ack_required`; cross-tenant → 404; admin PATCH w/o
  cookie → 403; **cap change live with no restart** (`freeMaxFileSizeMb=7` → `status` says 7);
  `pagesMaxAssetMb=999` → 400 hard ceiling; 2 MB under a 1 MB cap → **400 `quota_file_size`**, never
  500); a **headed-browser** proof **23/23** (upload → rename in UI keeps the sha256 → real browser
  GET of `/hf` byte-identical with the new filename → admin login → set cap 9 → read back live from
  the customer session **and** `AdminSetting.hostingFreeMaxFileSizeMb=9`); every `test:*` suite re-run
  → **0 failures**.
- **NOT done by P1 (the lead's call):** the **deploy** (the D1 prompt says P1 must not disturb the
  live `/e/` + `/downloads/` services) and the **`dl.*`/instaweb vhost `location /hf/`** — that nginx
  config is on the VPS, not in this repo, so a minted URL 404s until it is added. `cloudflare` /
  `external` engines are **registered, not implemented**. `prisma migrate deploy` on production is
  unrun. **Next: P2.**

### P2 — Redirects, user-owned + BYO credential store + Cyber Lab scaffolding — ✅ **DONE + DEPLOYED + LIVE (2026-10-02, `435d419`)**
- Shipped: user-owned `/r/<slug|token>` on the Task 30 `LinkRedirect` row (two NULLABLE columns —
  campaign links untouched); `HostingCredential` (AES-256-GCM, 4-char hint only, one default per
  provider); the Cyber Lab nav item + dashboard card + dark panel; `hosting` entitlement live.
- **Proven:** `test:hosting` **39/39**, all **26** `test:*` suites green, `tsc` **0**, `next build`
  **0**, and a **live authenticated** production `GET /api/hosting/status` → **200 `enabled:true`**.
  Deploy run **`36933764632`**; nginx **`location /hf/`** added; `HOSTING_PUBLIC_BASE_URL=https://dl.instaweb.top`.

### P3 — Pages engine + folder→preview→publish + the engine switch — ✅ **DONE + DEPLOYED + LIVE 2026-10-02 (`bb6ff6c`, run `36966548887`, build `LjgrTG69r2eiN-w07Hj-i`)**
- **One tab, two engines.** An **Engine** picker on every deployable item: **Our server (free)** or
  **Premium (Cloudflare)**, premium defaulting to the platform account and accepting a BYO credential
  (§16.2/16.4). The picker is **data**, not a build flag — flipping it needs no redeploy.
- **Folder/zip upload → extract → PREVIEW → PUBLISH** (§16.1). The preview is a real, `noindex` URL;
  Publish is a separate, deliberate act; the last **3 published revisions** are kept for one-click undo.
- Connection pane + scoped-token **verify on save**; a template deploys in two clicks; the **agent**
  can do the whole thing as a **gated** `AgentPendingAction` kind `"hosting"`.
- **Premium is capped too** (§16.3) — platform-account caps are separate, admin-editable, enforced
  server-side.
- **Exit:** (a) a user zips a folder, opens the **preview** URL, presses **Publish**, and the
  production URL serves the same bytes; (b) the same folder on the **premium** engine returns a
  `*.pages.dev` URL; (c) the agent does it end-to-end from one sentence.
- **Deliverables (the map — where the code goes):**
  - `lib/hosting/providers.ts` — **implement the `cloudflare` engine** behind the existing
    `HostingProvider` interface (the `external` slot may stay a typed `NotReady`): `listProjects`,
    `createProject` (R20 `production_branch`), `deployFiles` (the raw REST Direct-Upload flow proven
    in T0), `deployFromTree`, `getDeployment`.
  - `lib/hosting/extract.ts` (new) — run the §16.1 pipeline: `7z` list → cap check (`hostingMaxZipMb`,
    `hostingMaxZipEntries`) → `7z` extract into a **staging dir outside the deploy dir** → the §11.1
    scan → a file tree. Streams; never loads the archive into RSS.
  - `lib/hosting/sites.ts` (new) — a `HostingSite`/`HostingRevision` state machine:
    `uploaded → extracted → previewed → published | rejected | expired`, with the single-slot job lock
    (`hostingMaxHeavyJobsPerUser`) and the `bytesProcessed/entries/durationMs/peakRssMb` metrics (§16.6).
  - `app/api/hosting/sites/**` (new) — list/upload/analyse/preview/publish/rollback/delete.
  - `app/api/hosting/credentials/**` — P2 shipped the store; P3 adds the **verify-on-save** wiring
    used by the chooser (re-verify, stamp `lastVerifiedAt`, mark red on failure).
  - `app/pv/<token>/route.ts` (new) — the **preview** serve route (our engine), `X-Robots-Tag: noindex`.
  - `components/hosting-panel.tsx` — add the **Sites**, **Folder**, **Connection (chooser)** and
    **Engine picker** sections (§8).
  - `app/api/admin/hosting/route.ts` + the admin **Hosting limits** panel — the new `hostingPremium*`
    /`hostingMaxZip*`/`hostingPreviewTtlHours`/… caps (§14 P3 table).
  - **One additive migration** for `HostingSite`/`HostingRevision` (+ any new `AdminSetting` columns),
    hand-written SQL per HOW_WE_MOVE_FAST rule 2. **Never edit an applied migration.**
  - `tests/hosting-pages.test.ts` (new) + extend `tests/hosting-files.test.ts`. The `7z` extract and
    the tree→manifest mapping are **pure** and unit-testable without Cloudflare; mock the REST client.

### P4 — Templates gallery + bulk redirects (**converters are OFF — §16.5**)
- Template gallery (curated, versioned, agent-readable); CSV → Bulk Redirects (R11) on a custom zone.
- Image/doc/video conversion is **deferred until the box is upgraded** (owner, 2026-10-02): the
  rename-with-unchanged-bytes feature (P1) is the entire file story until then.

### P5 — Platform-token "try it" tier + managed pool + multi-account switcher
- Cap, quota, reclaim idle platform projects; the multi-account pool; **switching accounts *during* a
  job** (§16.2) — *"lets start with one first"* (P2's store is already multi-account capable).

**Ordering rationale:** P1/P2 need **no third party**, so they are fully shippable and
testable this week; P3 unlocks the "real hosting" story with the user's own free account; P4/P5
are breadth and scale.

---

## 10. Entitlements & pricing

- New entitlement key **`hosting`** added to `ENTITLEMENT_KEYS` (`lib/entitlements.ts:12`).
  Server is the real gate (existing `hasEntitlement` pattern); UI hides too.
- New store product **`hosting_module`** in `lib/products.ts` (`ProductId` union + a
  `hostingModulePriceUsd` `AdminSetting` field) following the existing module pattern.
- **Free tier** = platform token, capped (P5) + our `dl.*` files + our `/r/` links.
- **Premium** = BYO/managed token, custom domains, R2, bulk redirects. Pricing is
  **configuration**, never code (COMMERCIAL C3).
- **"Premium is not capped" is a product rule, not a licence** (§16.3): premium has its **own**
  cap family (`hostingPremium*`), separate from free, admin-editable, enforced server-side — the
  platform Cloudflare account is a shared asset we own and pay the blast radius for.

---

## 11. Safety, abuse and compliance — non-negotiable

This feature can host **executables** and **redirects**, which is also the shape of phishing
and malware distribution. That is not a reason to weaken it; it is a reason to build the
safety net **with** it.

1. **Scan on upload.** Every uploaded file: MIME + size + extension allow/deny list, antivirus
   (ClamAV) where feasible, and **hash checks against a known-bad list**. EXE uploads are a
   distinct, gated class.
2. **Everything logged, per owner.** `HostedAsset` + audit rows make every artifact traceable
   to a user, with the upload IP and time. The admin panel surfaces the newest artifacts
   (mirrors the existing admin monitoring surfaces).
3. **Abuse workflow.** A published abuse contact + a takedown path; a one-click admin "kill
   asset/user" (reuse the existing panic-switch pattern, CROSS-TRACK RULE 6).
4. **Respect the upstream ToS.** Cloudflare's own acceptable-use/abuse policy governs anything
   on the user's/owner's Cloudflare account; **our** rules must be at least as strict, and the
   hosting AUP must be accepted at first use.
5. **Never claim "anonymous".** Links are opaque, not untraceable; do not market this as
   hiding who published.
6. **Heavy loads are queued and measured, not fired at the box** (§16.6). A zip extract, a Pages
   deploy and a multi-hundred-file upload run one at a time per user, shell out (`7z`) with a hard
   timeout + output cap, and record `bytesProcessed`/`entries`/`durationMs`/`peakRssMb` on the job
   row so the later **resource-governor** task can see and shape them. The **dial** for each is an
   `AdminSetting` field (§14 rule 1), so the governor task needs no schema change. The governor
   itself is **out of scope here** — `lib/resource-governor.ts` is not touched in the P3 run.

---

## 12. Dependencies and what we lack (measured, not guessed)

| Need | Status today | Gap |
|---|---|---|
| File host + TLS + caching | ✅ **live** (`dl.*` vhosts, origin-masked, 119 GB free) | need a `hosting/` namespace + auth'd upload API |
| Redirect route | ✅ **live** (`/r/[token]`, `LinkRedirect`) | needs user ownership + slugs + hits |
| Encrypted secret storage | ✅ pattern exists (`lib/mailbox-crypto.ts`, `MAILBOX_ENCRYPTION_KEY`) | reuse; do not fork |
| Entitlements + store | ✅ core live (`cyberlab` key already present; `products.ts`) | add `hosting` key + product |
| Nav/tab plumbing | ✅ single array (`dashboard-nav.tsx`) | one entry |
| Agent tool calling | ✅ live (`lib/agent.ts`, `AgentPendingAction`) | add `hosting` action kinds |
| **Image conversion** | ❌ **no `sharp`** in deps; **no ImageMagick** on VPS | **OFF (§16.5)** — not added |
| **Doc conversion** | ❌ **no LibreOffice/pandoc** on VPS | **OFF (§16.5)** — not added |
| **Archive** | ⚠️ `7z` **present**, `zip`/`unzip` **absent** | ✅ use the installed **`7z`** for the §16.1 zip extract (never `unzip`) |
| **Video** | ❌ `ffmpeg` **absent** | **OFF (§16.5)** — deferred until the RAM upgrade |
| **Folder / zip upload + preview** | ❌ no upload-folder path exists; Cloudflare Direct Upload **refuses zips** (R19) | P3: accept a zip, **extract with `7z`** into a staging dir, preview, then publish (R17/R18) |
| **R2** | ❌ not configured; needs billing (R13) | premium/BYO path only |
| **Cloudflare account + token** | ✅ **throwaway account/token supplied 2026-10-01** (§13.2); Account ID `4c822d…0492` | The token verifies `active` and — with the Account ID — `/pages/projects` and `/workers/scripts` return **200** (R2 → **403**, no scope). The **T0 spikes** (25 MiB rejection, Direct-Upload REST, R4/R15) are **DONE + PASSED 2026-10-01** (§9); the custom-domain endpoint was identified but **not** executed (premium-only). The real **platform** token is a production decision. |

**VPS facts as measured 2026-10-01:** node `v24.20.0`, npm `12.0.2`, `7z` present,
`ffmpeg`/`libreoffice`/`pandoc`/`convert`/`qpdf`/`zip`/`unzip` **missing**, 23 GiB RAM
(16 GiB free), disk **119 GB free**.

---

## 13. Owner decisions (answered 2026-10-01) — these now BIND the build

**"Wedge" in plain words = *what ships first*.** The owner's answer: **v1 = free-first on our
own metal.** Do not start with Cloudflare/Pages; build P1 → P2 → P3 (streaming §9).

| # | Question | Owner's decision (2026-10-01, verbatim where quoted) | Effect on the build |
|---|---|---|---|
| 1 | Wedge for v1 | **"v1"** — i.e. the recommended order **P1 (files) → P2 (redirects) → P3 (Pages)**, our own metal first. | First deliveries need **zero third-party**. P1/P2 ship+test immediately. |
| 2 | Platform token — **free** users | *"not even sure free users should use [it], but if that's right maybe 1 day."* → **do NOT offer it by default; if offered, 1 day max** before reclaim. | P5 stays last; the free "try-it" tier is **1 day, capped, reclaimable**. |
| 2b | Platform token — **premium** users | **User-selectable duration** — *"maybe 3 or 5 days"*, or **indefinite**. Picking **indefinite MUST show a warning** that it can add to the user's hosting/usage billing. | Duration is a **user field**; `indefinite` ⇒ explicit billing warning in the UI. |
| 2c | Caps | *"we are still going to build a cap to what users can do even if they add their own token, and also with our own added token."* → **a HARD cap applies in every mode.** | Per-user quota is **independent of token mode** (own token / our token). Enforce **server-side** (`AdminSetting`); never trust the client. |
| 3 | Custom domains | **Premium only** (`"custom domains should be premium only"`). Zone specifics flexible — *"we can always change during testing."* | Custom-domain UI **and** `POST .../pages/projects/{p}/domains` are premium-gated. |
| 4 | Converters | **NOT ANSWERED — still open.** Recommendation stands: start **dependency-free**. | P4 only. Do **not** install `libreoffice`/`ffmpeg` without asking (see §13.3). |
| 5 | AUP lawyer | **Covered** — *"we have got a lawyer in the uk, an old friend, he is working on that."* | Do not block §11 / Task 156 C0 on this; the text is inbound. |

### 13.1 v1 scope — what "shipped v1" means (do exactly this, nothing more)

1. **T0 spikes** (§9) against the throwaway account — witness R4/R15 + the custom-domain
   endpoint and the 25 MiB rejection. **If a spike fails, stop and report.**
2. **P1 — Files on our own metal** (no Cloudflare): upload / list / rename / delete;
   `Content-Disposition` rename with **`sha256` provably unchanged**; expiry; per-user quota,
   behind the new `hosting` entitlement, **dark**.
3. **P2 — Redirects, user-owned**: promote the live `/r/<token>` + `LinkRedirect` to
   user-owned links + custom slugs + hit counts.
4. **P3 — Pages (BYO token)** after T0 passes: connection pane, scoped-token checklist,
   verify-on-save, deploy-from-template, live `*.pages.dev` URL, agent-does-it gated proposal.

P4 (templates/converters/bulk) and P5 (platform tier/pool) are **NOT v1**.

### 13.2 Credentials now available (throwaway Cloudflare account, 2026-10-01)

- The owner supplied a **throwaway Cloudflare account API token** for the T0 spikes.
- It lives **only** in the local, **gitignored** `spaceworker/.env` as
  **`CLOUDFLARE_API_TOKEN_DEV`** and **`CLOUDFLARE_ACCOUNT_ID_DEV`** — the tracked `.env.example`
  lists the **production** names `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` **blank**
  (never put a real token there).
- **Account facts supplied by the owner 2026-10-01 (not secrets):**
  **Account ID = `4c822d3b5378019cef1e1b79a3bf0492`**, account subdomain
  **`channelchannel4747.workers.dev`** (→ Pages projects surface as `*.pages.dev`).
- **What was proven LIVE 2026-10-01 (raw output, not assumed):**

  | Call | Result | Meaning |
  |---|---|---|
  | `GET /user/tokens/verify` | `{"id":"dbe2bd7375e2fdfd03b478a440ae0aae","status":"active"}`, `success:true` | The token is **valid and active**. |
  | `GET /user` | `9109 Unauthorized` | It is **NOT a user token** → **account-scoped** (R14's preferred type). |
  | `GET /memberships` | `10000 Authentication error` | Same conclusion. |
  | `GET /accounts` | `result: []`, `total_count: 0` | An account-scoped token **does not enumerate its own account** (hence the manual Account ID). |
  | `GET /accounts/{id}/pages/projects` | `200`, `success:true`, **`total_count: 6`** | ✅ **Pages scope works and the account is live.** 6 pre-existing projects from the owner's earlier testing: `fileshare` (`fileshare-8vs.pages.dev`), `filesharing` (`filesharing-7lp.pages.dev`), `securefilesharing` (`securefilesharing.pages.dev`), `new` (`new-4kn.pages.dev`), `cfdirect` (`cfdirect.pages.dev`), `cfredirect` (`cfredirect-e6m.pages.dev`). |
  | `GET /accounts/{id}/workers/scripts` | `200`, `result: []` | ✅ **Workers Scripts scope works** (no scripts yet). |
  | `GET /accounts/{id}/r2/buckets` | `403` (`10000 Authentication error`) | ❌ **No R2 scope** — and R2 needs billing anyway (R13). R2 stays the premium/BYO path. |

- **API gotcha found live:** `?per_page=50` on `/pages/projects` fails with
  `8000024 Invalid list options` — the **max is lower**; `per_page=10` works. Paginate; do not
  request 50.
- **Consequence for T0 — the prerequisites are met, so T0 can run now.** Pages + Workers scopes
  are confirmed working against a real account, and there is a non-empty Pages project list to
  read. Still to *witness* (S0-a/S0-b, §9): the 500-builds/month quota under Direct Upload, the
  Workers free-plan numbers, the exact custom-domain endpoint, **a real Direct-Upload deploy over
  raw REST**, and **the 25 MiB rejection** (upload 26 MiB → watch it fail). Re-run against the
  account above:

  ```bash
  cd /Users/mikeolab/spaceworker
  export CLOUDFLARE_API_TOKEN_DEV=$(grep '^CLOUDFLARE_API_TOKEN_DEV=' .env | cut -d= -f2-)
  export CLOUDFLARE_ACCOUNT_ID_DEV=$(grep '^CLOUDFLARE_ACCOUNT_ID_DEV=' .env | cut -d= -f2-)
  curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN_DEV" \
    "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID_DEV/pages/projects?per_page=10"; echo
  ```
- **Rules (non-negotiable):** server-only; never in a client bundle, a log line, an AI prompt,
  or an error message; **every** Cloudflare mutation writes an audit row. **Revoke the throwaway
  token once T0 is done** — it exists to answer §2's open facts, not to ship.
- **Do not reuse this throwaway token as the platform-tier credential.** The real platform
  token is a separate, owner-created, production decision (§5 Mode 1).

### 13.3 Still open after 2026-10-01 (do NOT invent answers)

- ~~**Q4 — converters**~~ → **ANSWERED 2026-10-02: OFF.** Owner: *"for now we dont need converters,
  just the rename of file upload is enough for file store, we will add converstion later when we
  upgrade the ram."* So `sharp`/ImageMagick/`libreoffice`/`ffmpeg` are **not** added; the §12
  conversion rows below are retained only as a record of what a future (post-RAM) phase would need.
- **R15 (Workers free requests/day)** — not cleanly captured; confirm before P5. *(R4, R5, R1, R3,
  R7 and the custom-domain endpoint are now RESOLVED — see §9 T0; R17–R20 are the 2026-10-02
  preview/publish/webhook anchors — see §2.)*
- **NEW (2026-10-02) — the platform Cloudflare account is a *throwaway*.** §16.4 lets a user choose
  the platform account or their own; the **real production platform token + account** is still an
  owner decision. Until it is made, premium deploys are **throwaway-account only** and must be
  labelled as such to the admin (never to the customer).

*Historical (pre-answer) questions retained for provenance:*
1. Wedge for v1: files+redirects on our own metal (P1/P2), or Pages (P3)? *Rec: P1→P2→P3.*
2. Platform token tier: days before reclaim?
3. Custom domains: premium only?
4. Converters: heavy binaries or dependency-free? *Rec: dependency-free.*
5. AUP: which lawyer?

---

## 14. Admin-editable caps (owner decision 2026-10-01) — BINDING

Owner: *"You can decide the limit. And we can add to the admin where those limits can be easily
changed — and also all caps for the workers and cyberlab to be available for edit in admin."*

**Three rules follow from this, and they apply to BOTH D1 (Task 155, "workers"/hosting) and
D2 (Task 156, Cyber Lab):**

1. **No cap is a hard-coded literal.** Every limit lives in a named field on the existing
   `AdminSetting` record (the same single-row pattern the app already uses), read **server-side**
   on every request. A cap the client can bypass is not a cap.
2. **Every cap is editable in the admin UI** with a sane default, a unit label, and a one-line
   explanation — so the owner changes behaviour without a deploy.
3. **Sane defaults ship on**: the numbers below are **my** chosen defaults (the owner delegated
   them). They are starting points, tunable in admin, and must be enforced with a clear,
   user-facing message when hit.

**D1 (hosting) defaults** — new `hosting*` `AdminSetting` fields (schema lands in P1):

| Field | Default | Unit | Why this number |
|---|---|---|---|
| `hostingFreeStorageQuotaMb` | **1024** (1 GB) | MB / user | Generous for the "share a file / an EXE" use-case; the free tier is our own metal. |
| `hostingFreeMaxFileSizeMb` | **512** | MB / file | Above the EXE use-case, below anything that makes the VPS disk dangerous in one write. |
| `hostingFreeMaxFiles` | **500** | files / user | Bounds inode + listing cost. |
| `hostingFreeMaxBandwidthGbPerMonth` | **50** | GB / month | Downloads are the real cost; 50 GB ≈ a few thousand EXE pulls. |
| `hostingPremiumStorageQuotaMb` | **10240** (10 GB) | MB / user | Premium (BYO token / R2) can be far larger. |
| `hostingPagesMaxAssetMb` | **20** | MB / file | **Must stay `< 25`** — Cloudflare 500s above 25 MiB (§9). Pre-validate; never forward oversize. |
| `hostingPlatformTokenTtlHours` | **24** | hours | Owner: free platform-token tier ≤ 1 day before reclaim (§13 Q2). |

**P3 (premium/folder) defaults** — added 2026-10-02, same mechanism, same rules (§16.3/§16.6):

| Field | Default | Unit | Why this number |
|---|---|---|---|
| `hostingPremiumMaxProjects` | **25** | projects / user | The account holds only **100** (R1); 25 keeps four heavy users from consuming it. |
| `hostingPremiumMaxFilesPerProject` | **2000** | files / project | One fifth of the **20 000** Direct-Upload ceiling (R19); bounds upload time + manifest size. |
| `hostingPremiumMaxBandwidthGbPerMonth` | **200** | GB / month | Soft alert threshold — Pages static egress is free, so this exists to catch abuse, not to bill. |
| `hostingPremiumDeploymentsPerDay` | **50** | deploys / user / day | Preview + publish are 2 deploys; 50 is generous for a builder, hostile to a script. |
| `hostingPreviewTtlHours` | **72** | hours | A preview the user never publishes is swept (§16.1); long enough for a weekend review. |
| `hostingMaxZipMb` | **2048** (2 GB) | MB / archive | Above any realistic site; the extract is streamed via `7z` with a hard timeout + output cap. |
| `hostingMaxZipEntries` | **20000** | entries / archive | **Exactly the Direct-Upload ceiling** (R19) — refuse above it *before* extracting, with a count. |
| `hostingMaxHeavyJobsPerUser` | **1** | concurrent jobs | The §16.6 single-slot lock: a zip extract and a deploy never run at once for one tenant. |
| `hostingPublishedRevisionsKept` | **3** | revisions / project | Enables one-click "undo my last publish" (§16.1) without unbounded storage. |

**D2 (Cyber Lab) defaults** follow the same mechanism and are enumerated in
`PLAN_TASK_156_CYBERLAB_REAL_WORLD_TOOLS.md` §10, but the *mechanism* is decided here: caps go on
`AdminSetting`, are admin-editable, and are enforced server-side. D2 must not invent a second
mechanism.

**P1 acceptance addition:** the hosting caps above are settable in admin, change server behaviour
without a redeploy, and a quota breach returns a clear message (not a 500).

---

## 15. Public serving host — owner decision (2026-10-01) — BINDING

Owner: *"We don't want to use our main `spaceworker`; we can allow users [to] use the **instaweb**
domain, which is for the public agent — and also the Workers/Pages, if linked, can be used for the
storage. Or, if it's hosted with instaweb, users can create a **redirect** to it, to have a better
and shorter link straight to download the file."*

**Decisions that follow:**

1. **Never serve user-uploaded bytes from the main `spaceworker.top` app host.** The hosting
   surface lives on the **`instaweb` public family** (`*.instaweb.top`, wildcard TLS already

   covers any single label — see TASK_122 §9), exactly like the public agent
   (`agent.instaweb.top`) and the installer-download host (`dl.instaweb.top`). Measured live
   2026-10-01: `dl.instaweb.top → 404` (host + TLS present, no root content — the natural
   candidate), `agent.instaweb.top → 200`, `spaceworker.instaweb.top → 200`.
   - Config is a **new optional `HOSTING_PUBLIC_BASE_URL`**, following `PUBLIC_LINK_BASE_URL`'s
     exact pattern in `lib/env.ts` (defaults to `appBaseUrl`, trailing slash stripped) ⇒ a
     **zero-behaviour-change addition** until the owner sets it to the chosen host.
2. **Pages *is* storage.** A user's linked Pages project (P3) already holds their assets
   (≤ 25 MiB/file, §9) and serves them from `*.pages.dev`; we do not duplicate those bytes on our
   metal. "Hosting" = our metal (P1) **or** the user's Pages project (P3) — one tab, two engines.
3. **A redirect is the short link.** The `/r/<token>` machinery (P2) promotes to user-owned
   redirects: a user can point a short slug at a `dl.instaweb.top` file **or** at a `*.pages.dev`
   URL, giving "a better and shorter link straight to download". So P1/P3 produce the *bytes* and
   P2 produces the *pretty link* — deliberately decoupled.

**Consequence for §9 phasing:** P1's serving route is built host-agnostic (`/dl/<token>`-style)
and reads `HOSTING_PUBLIC_BASE_URL`; the owner flips the host in admin/env, not in code.


---

## 16. Owner additions 2026-10-02 — BINDING (this IS the P3 build spec)

Owner, verbatim: *"for the workers and pages, no option to upload folder and we extract and push to
preview first and then live, and they should be option to switch between the server and the premium,
we use the cf throway i gave you for premium, nothing that using premium is capped… we need both
option available and option for users to add there own cf tokens and id, and if users add multiple
like 3, we should be able to switch between them for hosting and give a smooth page, lets start with
one first… yes use the throway cf acct for p3… for now we dont need converters, just the rename of
file upload is enough for file store, we will add converstion later when we upgrade the ram."*

Five decisions follow. **P3 is the build; P4/P5 sit behind it.**

### 16.1 A folder goes up as a ZIP, is extracted, and lands on a PREVIEW first — then Publish

The owner's exact flow — *"no option to upload folder … we extract and push to preview first and then
live"* — is **four states**, and nothing is *live* until the user says so:

| # | State | What the user sees | What the server does |
|---|---|---|---|
| 1 | **Upload** | drops a `.zip` **or** multi-selects files | stores the archive **outside** the app dir; never extracts in place |
| 2 | **Extract + analyse** | a file tree, total bytes, and *"3 files skipped, 1 over the limit"* | `7z` (already on the box) into a **staging dir outside the deploy dir**, then the §11.1 scan + §14 caps |
| 3 | **Preview** | a **preview URL**, badged **"not live"** | our engine: `https://dl.instaweb.top/pv/<token>/…`; premium: a **non-production branch** deployment → `<hash>.<project>.pages.dev` (R17). Both **`X-Robots-Tag: noindex`** |
| 4 | **Publish** | *"Publish to live"* → the **production** URL | **a second deployment of the SAME asset hashes** on the production branch (R18) — never a re-upload, never a "promote" call (it does not exist) |

**Rules that make this safe and testable:**
- **The preview is a real URL the user can open, share and re-open later.** For the free engine it
  lives on the **same `dl.*` origin as their files** (one link style for the whole product); for
  premium it is the `*.pages.dev` preview URL. **It is never the URL we advertise as "your site".**
- **Publish is deliberate, idempotent and reversible.** Keep the **last 3 published revisions** per
  project; "undo my last publish" is one click (a DB pointer change we own, not a Cloudflare delete).
- **The zip is never trusted.** Zip-slip (`../`), absolute paths, symlinks, hardlinks, nested zips,
  >20,000 entries, and per-file `> hostingPagesMaxAssetMb` are **rejected by name**, before extraction
  completes. A rejected archive leaves **zero** partial state (staging dir is wiped).
- **Preview → Publish must not move bytes twice.** Publish reuses the uploaded asset hashes
  (the T0 flow: `check-missing` → `upload` → `upsert-hashes` → `deployments`); if the bytes are
  already on Cloudflare, publish is a **manifest-only** call.
- **A preview costs a cap slot but not a "live site".** `hostingFreeMaxFiles`/quota count the
  extracted set; the preview URL is inside `hostingPreviewTtlHours` (default **72 h**) and is swept
  when it expires without a publish.

**The free engine gets the same shape.** `/pv/<token>/…` is a *staging* tree served by the same
`/hf/`-style nginx location; publishing promotes the staging tree to the live tree (an atomic rename
inside `HOSTING_STORAGE_DIR`) and mints the stable `/hf/<token>` link. Same four states, no
Cloudflare, no third party — so the flow can be built and proven **before** the Cloudflare path.

### 16.2 One picker, two engines — "our server" vs "premium", per item

Owner: *"they should be option to switch between the server and the premium."*

- **Engine is a per-item column, not a global setting.** `HostedAsset.engine` (`local` | `cloudflare`)
  already exists for files; P3 adds the same idea for **sites** (`HostingProject.engine`).
  A user can host page A on our metal and page B on Cloudflare, in the same tab, at the same time.
- **The picker shows the truth, live.** Each option carries what it actually costs and does:
  *Our server — free, instantly live, files served from `dl.instaweb.top`, custom domains not
  available* vs *Premium (Cloudflare) — global edge, `*.pages.dev` and custom domains, subject to the
  premium caps (§16.3)*. **Never a silent fallback**: if premium fails, the item stays on premium and
  the error is plain language; we do **not** quietly host it on our metal.
- **Switching an item's engine is an explicit migration**, not a toggle: *"Move this site to Premium"*
  → a preview deploy on the new engine → the user publishes → the old engine's copy is retired after
  the new one is verified 200. Until then **both URLs work** (that is the safe rollback).
- **Which credential powers premium** is a separate, adjacent choice (§16.4): the **platform**
  account (ours, capped) or one of the user's **own** accounts.
- **During a *job*** (a running multi-hundred-file deploy) the account is **locked** for that job,
  because a switch mid-upload would split a manifest across two accounts. Switching *between* jobs is
  free. *(That lock is the only "start with one first" concession left, owner A5.)*

### 16.3 Premium is capped too — "nothing that using premium is capped" is a *product* rule, not a licence

Owner: *"nothing that using premium is capped"* = premium **is what users pay for**, so its caps must
not be the free tier's caps. It does **not** mean "no limits": the platform Cloudflare account is a
shared, finite asset we own and pay the blast radius for.

- **Separate cap family**, admin-editable, enforced server-side, exactly like §14:
  `hostingPremiumMaxProjects`, `hostingPremiumMaxFilesPerProject`, `hostingPagesMaxAssetMb` (**hard
  `< 25`**), `hostingPremiumMaxBandwidthGbPerMonth`, `hostingPremiumDeploymentsPerDay`.
- **One platform account, many tenants.** Every premium deploy is recorded (`HostingProject`) so
  admin can see, per user and per project, what the shared account is carrying, and revoke/reclaim.
- **A user's own account is capped by *us* too, but generously** — an abuse ceiling, not a paywall:
  we refuse to exceed *their* limits silently, and we surface Cloudflare's own error in plain words.
- **The 100-project ceiling is real** (R1). `hostingPremiumMaxProjects` is the lever; a project is
  reclaimed only when its last published revision is idle past `hostingPlatformTokenTtlHours` (§14).

### 16.4 Multiple credentials, and a smooth switch "between them"

Owner: *"option for users to add there own cf tokens and id, and if users add multiple like 3, we
should be able to switch between them for hosting and give a smooth page, lets start with one
first."*

- **The store is already multi-account** (P2: `HostingCredential`, one `isDefault` per provider).
  P3 adds the **chooser** and the **project↔account binding**.
- **The smooth page = one row per account**, each with: label, account id, **4-char token hint only**
  (never the token), last-verified stamp, project count, and **"Use for new deploys"**. Switching is
  a **radio**, not a form: pick account → the next deploy binds to it → existing projects keep the
  account they were built on (a project's account is **immutable**; moving it is the §16.2 migration).
- **Verify on save, and re-verify on use.** `GET /user/tokens/verify` + a cheap
  `GET /accounts/{id}/pages/projects?per_page=10` (the `per_page=50` gotcha is a **trap** — see §13.2).
  A dead token marks the row red and **fails closed** with plain language; it never silently falls
  back to the platform account.
- **Exactly one default.** Setting a new default clears the old one in the same transaction (§P2).
- **"Start with one first"** is honoured: P3 ships the chooser + binding + verify; **switching during
  a live job stays locked** and the managed pool is P5.
- **Never echo a token.** Not in a response, a log, an AI prompt, an error, a screenshot, or a
  support bundle. The 4-char hint is the maximum that ever crosses the wire (§11). Tokens at rest are
  AES-256-GCM via the existing `lib/mailbox-crypto.ts` — **do not fork the helper**.

### 16.5 Converters are OFF (owner, 2026-10-02)

*"for now we dont need converters, just the rename of file upload is enough for file store, we will
add converstion later when we upgrade the ram."* ⇒ **P4's converters are cancelled, not merely
deferred-with-a-date.** `ffmpeg`/`libreoffice`/ImageMagick stay **off** the box; `sharp` is not added.
The file feature is: **upload → rename (Content-Disposition, sha256 unchanged) → link → delete**, plus
the §16.1 folder/preview flow. Any doc or prompt that implies conversion exists is **wrong** — fix it.

### 16.6 The RAM shadow over all of this (recorded, not built — owner A8)

Owner: *"we need every hard load monitored and queued properly, so the governor can also adjust to
everything… lets build first, and when we are done, we will update the governor to understand the
load and adjust users accordingly."*

- **Do not touch `lib/resource-governor.ts` in the P3 run.** *(That is the separate, later task.)*
- **Do** make P3's heavy steps **measurable and queueable**: a zip extract, a Pages deploy, and a
  multi-hundred-file upload are exactly the loads the governor will need to see. P3 therefore:
  (a) runs them behind a **single-slot lock per user** (no two heavy hosting ops for one tenant);
  (b) records `bytesProcessed`, `entries`, `durationMs`, `peakRssMb` on the job row;
  (c) exposes the **concurrency dials** as `hosting*` `AdminSetting` fields so the governor task has
  a knob to turn **without a schema change**;
  (d) never runs an extract **inside the Next.js request process** if it can shell out to `7z` with a
  hard timeout + output cap (a 1 GB zip must not become 1 GB of RSS).
- **The Cyber Lab is the other heavy consumer.** Its RAM dials are already recorded (D2 caps); when
  the governor task lands it must see **both** families through the same `AdminSetting` mechanism
  (§14 rule 1) — one mechanism for hosting caps, lab caps and governor dials, never three.

## 17. Owner additions 2026-10-02 (after the P3 deploy) — BINDING, this IS the P4 run

Owner (verbatim): *"The hosting page ui needs to be better, the site should be a tab, and the links
and the files as well, separate tab, and more functionalities, the links redirect should be able to
use the premium same with the file, and we need preview like a test before deploying to production,
if that's going to be easy. Add this to the task.. lets fix it.. and make sure all hosting wrks..
also the cloudflare account token should be in settings. and as soon as user adds it, it becomes an
option during all hosting."*

### 17.1 Tabs — Sites | Links | Files are separate tabs on the Hosting page

- The single scrolling panel becomes **a tab bar under the status strip**: `Sites`, `Links`, `Files`
  (counts as badges: sites count, `linkCount / maxLinks`, `fileCount / maxFiles`).
- The **status strip** (storage used / files / storage engine) stays visible above the tabs — it is
  the "what am I allowed to do" read (P1 contract, unchanged).
- **"More functionalities"** concretely means the capabilities the APIs already have but the UI
  doesn't expose: **links → open / edit target / delete** (P2 ships `PATCH`/`DELETE /api/hosting/
  links/<id>`, the panel only renders Copy); **files → visibility toggle (public/private)** (P1
  ships it in `PATCH /api/hosting/files/<id>`, the panel never shows it).

### 17.2 Premium applies to LINKS the same way it applies to files

- Files already swap their main dial free→premium (`hostingPremiumStorageQuotaMb`). Links get the
  same treatment: new **`hostingPremiumMaxLinks`** `AdminSetting` column (default **500**), resolved
  in `resolveHostingCaps` when `premium` is true — **free users keep `hostingFreeMaxLinks` (50)**.
- Same mechanism as every cap (§14): named AdminSetting field, read server-side on every create,
  admin-editable live, additive migration only.

### 17.3 Preview as the test step — surfaced, not rebuilt

- The §16.1 **zip → preview → publish** flow already IS the "test before deploying to production".
  This run makes it **impossible to miss**: every site card shows the two-step hint inline
  ("1. Upload zip → preview · 2. Check it, then Publish"), the preview badge states the TTL, and the
  preview link + "Publish to live" are the primary actions on every unpublished revision.
- No new mechanism. If a flow change would require a new mechanism, it is out of scope for P4.

### 17.4 The Cloudflare account token lives in Settings, and unlocks premium everywhere

- The **Connection section moves off the Hosting page into `dashboard/settings`** (own card:
  add account / verify / set-default / remove — same `/api/hosting/credentials/*` routes, token
  never echoed, 4-char hint only).
- **"As soon as user adds it, it becomes an option during all hosting"** = the moment
  `status.credentials.length > 0`:
  - the Sites tab's **engine picker offers `Premium (Cloudflare)`** (with the account chooser);
  - with **zero** accounts the picker shows a disabled "Premium (Cloudflare) — add an account in
    Settings" option + a direct hint, so the option visibly *arrives* when the token lands.
  - The Hosting page keeps a read-only one-line pointer ("Accounts are managed in Settings").
- **Scope note (assumption, flagged):** file UPLOADS keep the admin-global engine (`hostingProvider`,
  P1 contract §9) — "all hosting" covers every place a *user* picks an engine (sites). Making the
  file-storage engine per-user is a separate decision; do NOT silently change upload storage.

### 17.5 "Make sure all hosting works" = the acceptance bar for P4

- `prisma validate` + migration applies to a scratch DB; `tsc --noEmit` 0; eslint clean on touched
  files; **`test:hosting` green** (with a new assertion: premium swaps `maxLinks` like it swaps the
  storage quota); `CI=1 next build` exit 0.
- **Live after deploy:** `GET /api/hosting/status` 200 with `caps.maxLinks 500` for a premium user;
  upload → link → redirect works; `/hf/<token>` serves; Settings card renders; the engine option
  appears the moment an account exists.
- **NOT DONE / not tracked in P4 (flagged for the lead):** (a) a *diff* view or on-demand
  *re-run* of a preview (before/after comparison between revisions) — the owner's "preview like a
  test before deploying" is satisfied by the EXISTING zip→preview→publish flow made impossible to
  miss (§17.3); a diffing/re-run subsystem would be a NEW mechanism and needs its own plan.
  (b) per-user file-upload storage engine — uploads stay on the admin-global `hostingProvider`
  (§17.4 scope note); only sites expose the engine choice to users. Both are deliberate scope
  decisions, not regressions.




## 18. Owner addition 2026-10-02 (after P4) — Domains tab. SCOPED, NOT BUILT (this IS the P5 spec)

Owner, verbatim: *"i am thinking we should be able to allow users add domain, if there is an automation
we can do or if the user needs to add something or whatever. lets try to add domain tab as well, so
users can choose that domain instead of the link. we can scope this for the next task so its well
grounded."*

This section is the **grounded scope**. It is written so P5 can start with zero further discovery.
It is deliberately NOT binding until the lead answers §18.9 — the delivery path (§18.2) has a
VPS-side consequence that is a genuine decision, not a detail.

### 18.0 The ask, restated as a build target

A **Domains** tab (a 4th tab beside Sites | Links | Files) where a user:
1. **adds a domain they own** (`go.acme.com`, `links.acme.io`, …),
2. **proves they own it** (one DNS record — the pattern already exists, §18.1),
3. **binds it to something they already have** — a short **link** (the primary ask: "choose that
   domain instead of the link"), and, in the same shape, a **hosted site** or a **file**,
4. after which the thing is reachable at **their** domain instead of `spaceworker.top/r/<slug>`.

"if there is an automation we can do or if the user needs to add something or whatever" is answered
concretely in §18.3: **exactly one DNS record is unavoidable** (nobody can add a record in a zone
they don't control), and **everything after that record is automatable** — and we already run the
exact automation primitive needed (§18.1, the `sudo -n` helper).

### 18.1 What exists today vs what is missing (all verified in-tree, 2026-10-02)

**Exists — reuse, do not rebuild:**

| Thing | Where | Why it matters here |
|---|---|---|
| **DNS TXT verification, live** | `lib/sending-domains.ts` (`txtRecords()` via `node:dns/promises`, `verifySendingDomainDns`) | The ownership-proof engine already exists, including the *"a transient SERVFAIL reads as not-published; verify is explicit + repeatable"* philosophy (comment at `txtRecords`). Domains must use the **same** shape, not a new one. |
| **Privileged host commands from app code** | `lib/sending-domains.ts` → `sudo(args)` = `execFile("sudo", ["-n", …])`, used for `/bin/cp`, `/bin/chown`, `systemctl reload opendkim` | **This is the automation primitive.** `sudo -n` fails fast (never hangs on a prompt). Whatever nginx/certbot automation P5 does runs through this same helper — no new privilege mechanism. |
| **Premium cap resolution** | `lib/hosting/rules.ts` → `resolveHostingCaps(src, { premium })` (§17.2 just extended it for `maxLinks`) | Domains get a cap dial the same way (§18.6). |
| **Public base URL** | `lib/hosting/providers.ts` → `hostingPublicBase()`; `PUBLIC_LINK_BASE_URL` in `lib/env.ts` | Every "your URL is X" string already flows through here; a domain swap must route through it too. |
| **The tab skeleton** | `components/hosting-panel.tsx:153` → `useState<"sites" \| "links" \| "files">` | Adding `"domains"` is a one-word change to the union + a tab body. |

**Missing — the real work:**

1. **No `Host`-aware serving anywhere.** Every public route is token-in-path: `app/r/[token]/route.ts`,
   `app/hs/[token]/…`, `app/pv/[token]/…`, `app/hf/[token]`. A custom domain arrives as a **`Host`
   header**, so a resolver that maps `Host → binding` is genuinely new code. `grep` for
   `x-forwarded-host` / `headers().get("host")` across `app/` and `lib/` returns **nothing** today.
2. **No Next.js middleware.** No `middleware.ts` at any level. Host-based routing must be introduced
   deliberately (see §18.2 — it may not need middleware at all).
3. **nginx is single-host and applied by hand.** `deploy/nginx-spaceworker.conf` has exactly one
   `server_name spaceworker.top;`, one shared cert (`/etc/letsencrypt/live/instaweb.top/…`), and its
   own header says it is **"NOT part of the automated Build & Deploy pipeline — applied by hand
   (`nginx -t` then `systemctl reload nginx`)."** A custom domain cannot reach the app through this
   config as-is: an unknown `Host` gets no matching vhost.
4. **No wildcard / catch-all cert.** Let's Encrypt per-domain issuance (or a CF edge) is required
   for TLS on a user's domain; there is no wildcard today.
5. **The Cloudflare client is Pages-only.** `lib/hosting/cloudflare.ts` exposes `verifyCredential`,
   `ensureProject`, `deployTree` — **no** zone/DNS/custom-domain calls.
6. **No `HostingDomain` model.** `prisma/schema.prisma` has `HostingSite`, `HostedAsset`,
   `LinkRedirect` (with `slug`), `HostingCredential` — and nothing that stores a hostname.
### 18.2 The delivery path — the ONE decision that shapes everything (§18.9 Q1)

A custom domain can reach content two ways. Both are buildable; they are NOT equivalent in
cost, risk, or how many moving parts live on our VPS.

**Path A — "Cloudflare edge" (user's domain is already on Cloudflare).**
The user's domain is in *their* Cloudflare account (the same account we already hold a
`HostingCredential` token for — `hostingCredentialId`). We add the hostname as a **custom domain
on the CF project** via the Pages API (`POST /accounts/{id}/pages/projects/{project}/domains`,
new call in `lib/hosting/cloudflare.ts`). Cloudflare then owns **DNS + the TLS certificate** for
that hostname. **Zero new nginx work, zero certbot, zero new privileged commands** — all of it
happens inside the user's own CF account, which they own and can revoke.
- Pro: cheapest, safest, no VPS change, self-scoped to the user's account, TLS is CF's problem.
- Con: **only works for CF-engine sites** (Pages), so v1 would cover Sites, not the Links that are
  the owner's actual ask. And it needs the domain to be on CF + our token to carry the
  `Zone: DNS: Edit` / `Pages: Edit` scopes.
- **Feasibility must be probed live before promising it** (§18.9 Q1): does the BYO token scopes
  permit the domains call, and does Pages custom-domain attach need the user to add the CNAME it
  returns, or does CF auto-create it? The Pages domains endpoint historically returns the
  DNS record the user must add — so this path is **"one DNS record the user adds"**, exactly
  consistent with §18.3.

**Path B — "our metal" (domain points at our VPS).**
The user points an `A`/`CNAME` at `spaceworker.top` (or the VPS IP). Then WE must:
   (a) **accept the unknown `Host` in nginx** — a catch-all `server_name _` vhost with a default
       cert, or a per-domain vhost written on activation; and
   (b) **present a valid cert for THEIR domain** — Let's Encrypt per-domain issuance
       (`certbot`/`acme.sh`, DNS-01 or HTTP-01) and an `nginx` reload.
- Pro: **works for Links, Sites and Files uniformly** — one mechanism covers the whole product,
  and the owner's headline ask ("choose that domain instead of the link") is a Link.
- Con: **this is where all the cost and risk is.** It means (i) a hand-applied nginx change first
  (today's config has no catch-all — §18.1.3), (ii) per-domain cert automation running as
  privileged (`sudo -n` — the primitive exists, §18.1, but it must be granted for `certbot`,
  `nginx -t` and `systemctl reload nginx` in sudoers, which is a **deploy-time/hand** action on
  the box, not something the app can grant itself), and (iii) an abuse surface: a user who points
  a hostile/parked domain at us is now served by our metal.
- **Feasibility must be probed live** (§18.9 Q1): confirm whether `certbot` is even installed, what
  the current sudoers grant is, and whether the maintenance-vhost pattern in
  `deploy/nginx-spaceworker.conf` generalises cleanly to a wildcard catch-all.

**Recommendation (for the lead to ratify, §18.9 Q1): phase the delivery path.**
- **P5a = the whole tab, the model, verification, and BINDING — with Path A wired for Sites**
  (CF custom domain, one returning DNS record the user adds) **and the Links half specified but
  inert** until Path B lands. Everything except *serving a Link on our metal* is fully deliverable
  in P5a, and it is deployable (additive, NULLABLE, no serving change, no nginx change).
- **P5b = Path B** (nginx catch-all + per-domain cert + the `Host`→Link/Site/File resolver). This
  is the piece with the hand-applied nginx change and the sudoers grant, so it is its own run with
  its own live-verification bar. Do NOT bundle it into P5a.

This keeps the promise truthful: the tab ships, verification ships, binding ships, CF-hosted sites
get real custom domains — and the Link-on-our-metal half is built as soon as the box is prepared,
not faked in the meantime.

### 18.3 "what can we automate vs what must the user do" — the honest split

| Step | Who | Automatable? | Mechanism |
|---|---|---|---|
| Add the domain to the tab | **user** | — | the new Domains tab form |
| Prove ownership / point it at us | **user** | ❌ **unavoidable** — no one can write a record in a zone they do not control | **one** DNS record (a `TXT` ownership proof reusing the `lib/sending-domains.ts` pattern, and/or the CF-returned CNAME for Path A) |
| Verify the record landed | **us** | ✅ | `node:dns/promises` TXT/CNAME/A lookups, same "explicit + repeatable, transient SERVFAIL reads as not-published" rule as `lib/sending-domains.ts` |
| Bind domain → link / site / file | **us** | ✅ | a `Host`→binding lookup (§18.4) |
| Issue TLS | **us** | ✅ for Path A (Cloudflare does it); ✅ for Path B **only once** `certbot` + a sudoers entry exist on the box | Path A: CF Pages domains API. Path B: `sudo -n certbot …` + `sudo -n systemctl reload nginx` via the existing `sudo()` helper |
| Accept the unknown `Host` | **us** | ✅ Path A (CF proxies to the project's own hostname, we never see a foreign Host); Path B needs a one-time hand-applied nginx catch-all | §18.2 |
| Serve the content at the domain | **us** | ✅ | `Host` resolver → 302 (Link) or a file (Site/File), mirroring the existing `/r`, `/hs` handlers |

**Blunt answer to the owner's question:** *there is no way to avoid the user adding one DNS record.*
Everything else we can automate — and for CF-hosted sites we can automate the whole TLS journey
today via the account token we already store. For Links/Sites on our metal, we can automate it too,
but only after a one-time privileged setup on the VPS (§18.2 Path B, §18.9 Q1).
### 18.4 Schema draft (P5a) — additive + NULLABLE, same discipline as P1–P4

One new model. No edits to `HostingSite` / `HostedAsset` / `LinkRedirect` / `User` — the binding
lives on the DOMAIN row (so one domain binds to one target, and every existing model stays
untouched, exactly like `LinkRedirect.userId` was added as a plain scalar in P2).

```prisma
// TASK_155 P5 — a user's own hostname, verified and bound to one thing they host.
// Path A (Cloudflare, §18.2) is fully automated; Path B (our metal) is P5b.
model HostingDomain {
  id       String  @id @default(cuid())
  // Plain scalar, matching HostedAsset.userId / LinkRedirect.userId, so the
  // User model needs NO edit (the P2 precedent).
  userId   String

  // The hostname the user added, lowercased + validated (a shared validator,
  // the way lib/hosting/rules.ts owns SLUG_RE — never trust the raw input).
  hostname String  @unique

  // How it reaches us. "cloudflare" = CF edge owns DNS+TLS (§18.2 A);
  // "local" = points at our VPS, P5b only.
  path     String  @default("cloudflare")

  // Where the domain is pointed. "link" is the owner's ask; "site"/"file"
  // reuse the identical shape so the tab is general, not link-only.
  targetType String          // "link" | "site" | "file"
  targetId   String          // LinkRedirect.id / HostingSite.id / HostedAsset.id
  // Denormalised read-only label for the tab list ("-> go.acme.com", "My site").
  targetLabel String?

  // Ownership proof (reuses the lib/sending-domains.ts DNS-check philosophy).
  // pending_verify -> active -> (error) ; "disabled" = user turned it off.
  status     String  @default("pending_verify")
  // The record the USER must add, echoed back for the UI. Never a secret:
  // a TXT proof value is public by nature (same as a DKIM p=).
  verifyRecordName  String?
  verifyRecordValue String?
  // Last check roll-up + when, mirroring SendingDomain.lastCheckDetail/lastCheckedAt.
  lastCheckDetail   String?
  lastCheckedAt     DateTime?

  // Path A only: the CF project the hostname was attached to, and the DNS record
  // CF told us the user (or we) must add.
  cfProject String?
  cfRecordName String?
  cfRecordValue String?

  // Path B only (P5b): the cert/nginx state, so a reload is idempotent.
  certIssuedAt   DateTime?
  nginxAppliedAt DateTime?
  lastError      String?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([userId])
  @@index([hostname])
}
```

Notes that matter:
- **`hostname @unique` is load-bearing.** Two users must never claim the same hostname. The unique
  index is the arbiter, not a pre-check (a check-then-insert race would let the second claim slip).
- **No secret is stored.** A `TXT` proof value and a CF-returned CNAME target are public; the one
  thing that must never be echoed is the **credential token**, which already lives in
  `HostingCredential` and is never read back out (the P4 Settings rule).
- The migration is **additive + NULLABLE** → deployable via `deploy.yml` in-window, same as P4's
  `20261030120000_task155_p4_premium_links`.

### 18.5 The Domains tab (UX) — mirrors the existing tabs, one new idea

`components/hosting-panel.tsx`: extend the union at line 153 to
`"sites" | "links" | "files" | "domains"`, add a 4th tab button with a count badge
(`domainCount / caps.maxDomains`), and a `tab === "domains"` body. The body has:

1. **Add a domain** — one input (`go.acme.com`), client-validated against the shared hostname rule.
2. **A "what to do next" card, per domain**, showing the EXACT record to add — this is the whole
   UX, and it must be as copy-pasteable as the sending-domains DKIM card already is:
   - Path A: "Add this CNAME at your DNS provider -> `...pages.dev`" (the record CF returns), plus
     a **Check** button;
   - Path B (P5b): "Add `TXT sw-verify=<value>`", then "point `A` at `<VPS IP>`".
3. **Bind** — pick what the domain serves: a **Link** (the primary case), a **Site**, or a **File**,
   from dropdowns listing the user's own rows (same lists the other tabs already render).
4. **Status + actions** — `pending` / `checking` / `active` / `error`, a **Check** button (explicit
   + repeatable, never auto-polls aggressively), **Copy** on the record values, and **Remove**
   (which must also release the CF custom domain in Path A).
5. **The one-line promise, made concrete**: once active, the tab shows the final URL
   (`https://go.acme.com` -> target) so the user sees the domain *replacing* the
   `spaceworker.top/r/<slug>` link.

Premium + cap messaging is identical in shape to the existing tabs (a locked state + "Premium" hint
when over the cap or not entitled).

### 18.6 Premium gate + admin dials (the §14/§17.2 mechanism — reuse, do not invent)

- **Dials** (new `AdminSetting` columns, additive migration, same as §17.2):
  `hostingFreeMaxDomains` (**default 0** — domains are a premium feature on day one, per the
  owner's *"links redirect should be able to use the premium same with the file"* framing) and
  `hostingPremiumMaxDomains` (**default 3**).
- `lib/hosting/rules.ts` → `resolveHostingCaps` swaps `maxDomains` on `{ premium }` exactly the way
  it now swaps `maxLinks`. The new test mirrors the §17.2 one: *a PREMIUM user gets
  `hostingPremiumMaxDomains`, not the free dial.*
- **Premium** means the same entitlement resolution the Links/Files caps already use
  (`ENTITLEMENT_KEYS` / the `hosting` entitlement). **No staff badge, no staff gate** — the owner's
  A14 rule carries over (see §17 and `PROMPT_NEXT_AGENT.md` A14).

### 18.7 Phasing

- **P5a (deliverable, deployable, no serving-path risk):** the `HostingDomain` model + migration;
  the shared hostname validator + TXT/CNAME verification engine (reusing `node:dns/promises`);
  the **Domains tab** (add / verify / bind / status / remove); **Path A wiring** for CF-engine
  sites (attach the custom domain via the Pages API — a new call in `lib/hosting/cloudflare.ts`);
  premium caps + the two dials; the `/api/hosting/domains` routes; tests. **No nginx change, no
  cert work, no `Host` resolver.**
- **P5b (its own run, has a VPS prerequisite):** the `Host`→binding resolver, the nginx catch-all
  vhost (hand-applied once, like every nginx change), per-domain TLS via `sudo -n certbot` +
  `sudo -n nginx -t` + `sudo -n systemctl reload nginx`, and Link/Site/File serving on our metal.
  **Blocked until §18.9 Q1 is answered and the sudoers grant + catch-all vhost are in place.**
- **P5c (optional, later):** apex/naked-domain handling, per-domain analytics, a custom 404 page —
  explicitly out of scope for P5a/P5b.

### 18.8 Acceptance bar (P5a)

- `prisma validate` clean; the new migration applies to a scratch DB; `tsc --noEmit` 0; eslint at
  HEAD parity on touched files; `CI=1 next build` exit 0; **`npm run test:hosting` green** with new
  cases: (a) premium swaps `maxDomains`; (b) the hostname validator rejects bad hosts and accepts
  real ones; (c) verifying a domain whose TXT is absent → `pending`, present → `active`; (d)
  `hostname` uniqueness (a second user cannot claim the same host).
- **Live after deploy:** `GET /api/hosting/status` exposes `caps.maxDomains`; a premium user can
  add a domain, see its record, hit **Check**, and bind it to a link; a CF-engine site can be given
  a real custom domain end-to-end (Path A) once the CF scopes allow it.
- **Explicitly NOT in P5a (so nobody reports it as a bug):** a Link/Site/File *served on our metal
  at a custom domain* — that is P5b and needs the box prepared first (§18.9 Q1/Q2).

### 18.9 Open questions for the lead — ANSWER BEFORE P5a BINDS

1. **Path A vs B, and the phased recommendation in §18.2** — ratify *"P5a = tab + model +
   verification + binding + CF-Path-A for sites; P5b = our-metal serving"*. If the lead instead
   wants the our-metal Link path FIRST (the owner's literal ask), then P5 must start with the VPS
   prerequisite: a hand-applied nginx catch-all vhost + a sudoers grant for `certbot` /
   `nginx -t` / `systemctl reload nginx`. **Confirm the box is open to that.**
2. ~~**Is `certbot` installed, and what is the current sudoers grant for the app user?**~~
   **✅ ANSWERED 2026-10-02, verified directly on the box** (`ssh -i ~/.ssh/tacticalrmm_vps
   root@164.68.105.96`): **certbot 1.21.0 installed** (`/usr/bin/certbot`), **nginx 1.30.4**
   installed with 13 live vhosts in `/etc/nginx/sites-enabled/` (spaceworker.top, instaweb.top,
   vantra, rmm, mesh, agent, dl — all separate `server_name`s), 8 certbot lineages in
   `/etc/letsencrypt/live/` (incl. `instaweb.top`, `spaceworker-top`, `broks.beauty-wildcard`), the
   app runs as **`User=trmm`** (`next start -p 3500`), and **`/etc/sudoers.d/trmm` grants
   `trmm ALL=(ALL) NOPASSWD:ALL`** — i.e. the sudoers prerequisite for Path B is ALREADY SATISFIED
   (certbot/nginx/reload are all runnable passwordless today; a scoped grant would be tidier but is
   not required). **There is NO default vhost** (no `default_server`, no `000-default`) — an unknown
   `Host` falls through to the first-listed server block, so the catch-all vhost is a NEW file to
   add, not an edit. Path B is therefore "write one vhost + wire the resolver", NOT a week of
   provisioning. NOTE: do NOT touch the other products' vhosts (vantra/rmm/mesh share this box).
3. **Does the BYO Cloudflare token carry the scopes Path A needs** (`Zone:DNS:Edit` and
   `Pages:Edit` on the domain's zone)? If not, Path A still works but the user may have to add the
   returned CNAME by hand — confirm that's acceptable as "one DNS record".
4. **Which entitlement gates domains** — the existing `hosting` entitlement (my default, §18.6),
   or a new `domains` key in `ENTITLEMENT_KEYS`?
5. **Apex vs subdomain in v1** — the owner wrote *"choose that domain instead of the link"*; most
   short-link use is a subdomain (`go.acme.com`). Subdomain-only for v1 is my default, which skips
   the naked-domain/ALIAS problem entirely.
6. **Abuse posture for Path B** — once our metal serves user hostnames, a hostile domain pointed at
   us is served by our IP. Confirm the guardrails (rate limits, a takedown path, the §5.2-style
   sentinel hook) before P5b, not after.

---
*End of §18. Scope only — no P5 code exists yet. Nothing above is implemented; the only changes on
disk today are this section and the P4 work committed at `d79eee6`. §18.9 Q2 was later answered from
the live box — see the corrected Q2 below (2026-10-02, verified via ssh).*

---

## 19. Owner addition 2026-10-02 (after P4 deploy) — the THREE-option engine model. SCOPED, NOT BUILT (this IS the P6 spec)

### 19.0 The ask, verbatim (binding)

> "i can see no more premium links unless user add there cloudflare, i hope i can switch between
> the cloudflare throway and the instaweb link, and also option to add more to the admin, so users
> can use ours. and ours should be the premium, while byo should be for the users added cloudflare,
> i thought it was going to be 3 options, free which is the instaweb, then premium which is the
> cloudflare and option to add more to rotate at the admin, and then byo which is the users own
> cloudflare to get more. lets make sure its scoped properly"

Restated as the three options the owner expects to see, **per item, switchable**:

| # | Option | Who provides Cloudflare | Who can pick it | State today |
|---|---|---|---|---|
| 1 | **Free — Instaweb / "Our server"** | nobody (our metal, `/hs` `/pv` `/hf` `/r`) | any user with hosting enabled | ✅ exists (`engine: "local"`) |
| 2 | **Premium — OUR Cloudflare (platform account)** | the **platform**; admin adds/rotates accounts | premium users, **zero setup** | ❌ **missing — this is the gap** |
| 3 | **BYO — the user's own Cloudflare** | the user (`HostingCredential`) | users who added a token | ⚠️ exists, but the UI mislabels it "Premium (Cloudflare)" (§17.4) |

The owner's first sentence — *"no more premium links unless user add their cloudflare"* — is TRUE
as perceived today: the engine picker's only Cloudflare option is disabled until a BYO credential
exists, so "premium" currently means nothing until the user brings their own token. Option 2 fixes
that: **premium must work with no BYO at all.**

### 19.1 Exists vs missing (all verified in-tree / on the box, 2026-10-02)

**Exists:**
- `HostingSite.credentialId` schema comment ALREADY says *"(NULL = platform account)"* — the schema
  anticipated option 2 (prisma/schema.prisma, HostingSite).
- `resolveDeployCredential` comment says *"otherwise the platform account (env)"* — **the code does
  NOT implement it**: named BYO → user default → 400 `no_credential` ("Add a Cloudflare account…").
  This comment currently lies; P6a makes it true (lib/hosting/sites.ts, `resolveDeployCredential`).
- `createSite` has **no premium check** on `engine: "cloudflare"` — any hosting-enabled user can
  create a CF site; it only fails at deploy with a BYO nudge.
- BYO credential store complete: AES-256-GCM, `isDefault`, verify-on-use, red-fail-closed
  (`lib/hosting/credentials.ts`) — **reused verbatim for platform rows' crypto + health pattern**.
- Cloudflare Pages client complete and used by sites: `verifyCredential` / `ensureProject` /
  `deployTree` (`lib/hosting/cloudflare.ts`).
- Admin dials pattern: `WRITABLE_FIELDS` (`app/api/admin/hosting/route.ts`) + `HOSTING_CAP_FIELDS`
  and `HostingCapsPanel` (`app/admin/(protected)/admin-panel.tsx`).
- Caps resolver free-vs-premium split (`resolveHostingCaps` / `resolveCapsForUser`).

**Missing (the P6a build list):**
1. **Platform-account storage** — admin-managed Cloudflare accounts: N rows, AES-GCM tokens,
   health, rotation order.
2. **The platform fallback branch** in `resolveDeployCredential` (the comment is written; the code
   is not).
3. **A premium gate** on `engine: "cloudflare"` with `credentialId = NULL` (option 2 = premium;
   see §19.9 Q1 for option 3's gate).
4. **The three-option picker** + per-site badge that says *which* Cloudflare source ("ours" vs
   "yours"), and removal of the §17.4 misnomer (BYO is not "Premium").
5. **The admin rotation surface** — add / verify / reorder / disable platform accounts with health.
6. Honest degradation: when no healthy platform account exists, a plain-language message (never a
   silent fall back to `local` for a CF-engine site).

### 19.2 The resolution rule (BINDING — this is the whole feature in one block)

```
engine = "local"                       → our metal. Free tier default. Any hosting-enabled user.

engine = "cloudflare", credentialId NULL
                                       → PLATFORM account: premium users only.
                                         Pick the healthy row with the LOWEST priority
                                         (1 = primary); unhealthy rows (verifyError non-null
                                         or status != "active") are SKIPPED, not used.
                                         NO BYO required. Zero setup.

engine = "cloudflare", credentialId <id>
                                       → that BYO credential (the user's own account),
                                         still re-verified on use (§16.4, fail CLOSED).
```

- **Fail CLOSED, in order:** dead platform token → mark row red, try next priority; **no healthy
  platform row** → `403` with plain language ("Premium Cloudflare hosting is being set up right now
  — try again shortly, or add your own Cloudflare account"), **never** a silent `local` fallback for
  a CF-engine site, and never a raw CF error.
- **Free user selects option 2** → `403 premium_required` ("Premium Cloudflare hosting is part of
  the premium plan…"), caught at site creation AND at deploy (defense in depth — creation alone can
  be raced by a downgrade between create and publish).
- **Rotation** = admin reordering `priority` + automatic skip of unhealthy rows. Re-verify on use,
  exactly like BYO (the existing `verifyCredential` call site is shared, not forked).

### 19.3 Schema draft (P6a) — one NEW additive table, nothing existing changes shape

```prisma
// TASK_155 P6 (PLAN §19) — OUR Cloudflare accounts, managed by the admin and
// rotated across premium users ("ours should be the premium"). Deliberately
// NOT a HostingCredential: there is no userId (ownership is the platform) and
// no isDefault (rotation is `priority`). Same AES-256-GCM token discipline.
model HostingPlatformAccount {
  id        String   @id @default(cuid())
  // Cloudflare account id (not a secret) — shown in the admin list.
  accountId String
  // Human label ("cf-main", "cf-backup-2").
  label     String
  // AES-256-GCM ciphertext of the API token — never plaintext, never returned.
  tokenCiphertext String
  tokenIv         String
  tokenTag        String
  tokenHint String @default("")
  // Rotation order: the healthy row with the LOWEST priority serves. 1 = primary.
  priority  Int      @default(100)
  // "active" | "disabled" | "revoked" — disabled/revoked rows are kept, never used.
  status    String   @default("active")
  // Same health contract as HostingCredential: NULL = never verified;
  // non-null verifyError marks the row RED and it is skipped by rotation.
  lastVerifiedAt DateTime?
  verifyError    String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([status, priority])
}
```

- **No change to `HostingSite`** — its `credentialId NULL` ALREADY means platform (the column
  comment promised this in P3).
- **No change to `HostingCredential`** — BYO stays byte-for-byte as built in P2/P3.
- Migration is purely additive (one `CREATE TABLE`) → same deploy path as P4.

### 19.4 UI — the picker becomes exactly the owner's three options

**Sites create form** (`components/hosting-panel.tsx`, the engine `<select>`):

1. `Our server (free)` — always enabled. (unchanged)
2. `Cloudflare — ours (Premium)` — enabled **iff** premium (and ≥1 healthy platform account);
   **no credential dropdown appears**; sub-line: "No setup needed — hosted on our Cloudflare."
3. `Cloudflare — yours` — enabled iff ≥1 active BYO credential; credential dropdown (existing) +
   Settings link; sub-line: "Uses your own Cloudflare account, limits and domains." With zero
   credentials: disabled + "Add your Cloudflare token in Settings" (the §17.4 hint, re-worded so it
   no longer claims to be "Premium").

**Per-site badge:** `Our server` | `Cloudflare · ours` | `Cloudflare · yours` (derive:
`engine === "cloudflare" && credentialId === null` → *ours*).

**Admin panel:** a new **"Platform Cloudflare accounts"** block inside `HostingCapsPanel`'s tab —
rows (label, account id, token hint, priority with ↑/↓, last-verified stamp, health dot), plus
**Add** (account id + API token + label — token never echoed back), **Verify now**, **Disable**.
Follows the panel's existing fetch → state → PATCH pattern; served by a sibling
`/api/admin/hosting/platform-accounts` route (admin session, same `requireAdminSession` as today)
rather than overloading the caps PATCH, so the caps route's subset-PATCH semantics stay untouched.

### 19.5 Optional dial (§19.9 Q3)

`hostingPlatformCfEnabled` (bool, `kind: "bool"` in `WRITABLE_FIELDS`) — a kill-switch that takes
option 2 down without a redeploy or touching rows. Cheap; include it unless the lead objects.

### 19.6 What "premium links" means — FLAGGED, not guessed (§19.9 Q2)

Links (`LinkRedirect`, served by `/r/<token>` on our base) have **no engine** — a link is a DB row +
a redirect, never touching Cloudflare. So the owner's *"switch between the cloudflare throway and
the instaweb link"* is ambiguous:
- **(a)** he means hosted **sites** (he has been testing sites) → fully covered by P6a;
- **(b)** he means the **Links tab literally** → the premium benefit would be serving that redirect
  from a CF edge (a Worker) or on a custom domain — the latter is **§18 Domains (P5)**, the former a
  possible **P6c**. Do NOT build a CF-Worker link base in P6a without an explicit answer.
- The Links tab's premium cap (500, P4) stays exactly as shipped either way.

**Files:** the global `hostingProvider` AdminSetting dial still selects the upload engine for
everyone (§17.4 NOT-DONE list). Applying option 2 to *files* (per-user provider resolution) needs a
per-asset provider column — that is **P6b**, its own slice, NOT in P6a.

### 19.7 Phasing

- **P6a (deliverable, this spec):** `HostingPlatformAccount` + migration; the platform branch in
  `resolveDeployCredential`; premium gate on option 2 (create + deploy); the three-option picker +
  badges + §17.4 relabel; the admin rotation block (+ kill-switch dial); tests for the §19.2 matrix;
  deploy (additive, §9 procedure).
- **P6b — CANCELLED 2026-10-03 by owner.** Option 2 for FILES never happens: files stay **local
  only** (`dl.*` / instaweb) with no engine dial at all. See §19.12.0 and §19.12.2.
- **P6c — CONFIRMED, in progress:** links on CF Workers on a custom host. This is the only
  remaining item of §19.11 #4. Spec is §19.12.3.

### 19.8 Acceptance bar (P6a)

- `prisma validate` clean; the new migration applies to a scratch DB; `tsc --noEmit` 0; eslint at
  HEAD parity on touched files; `CI=1 next build` exit 0; **`npm run test:hosting` green** with new
  cases: (a) free user, `engine=cloudflare`, NULL credential → `403 premium_required`; (b) premium
  user, NULL credential, healthy platform row → resolves the PLATFORM accountId (CF client mocked);
  (c) first platform row unhealthy → rotation skips to the next priority; none healthy → clean 403
  with the plain-language message; (d) explicit BYO credentialId → that credential even if a
  platform row exists; (e) admin can add/reorder/disable a platform account, and PATCH rejects
  unknown fields (existing behaviour preserved).
- **Live after deploy:** a premium user creates a CF site **with zero BYO** and publishes; the admin
  adds a second platform account, reorders, and the badge reads *ours* vs *yours* correctly; a free
  user gets the premium_required message; killing switch (if built) takes option 2 down with a
  clean message.
- **Explicitly NOT in P6a (so nobody reports it as a bug):** files on the platform engine (P6b),
  links on a CF edge (P6c / §18), custom domains (§18 P5), any change to BYO behaviour.

### 19.9 Open questions for the lead — ANSWER BEFORE P6a BINDS

> **★ AMENDMENT 2026-10-02 (owner answered some by construction).** Read the §19.0 verbatim again
> before treating any question below as open. The owner's own words already settle these:
> **Q4 (rotation shape) → ANSWERED: multiple CF accounts in priority order** ("*option to add more
> to rotate at the admin*"). **Q5 (DB vs env) → ANSWERED: DB**, admin-managed from the UI ("*add
> more to the admin, so users can use ours*"). **Q3 (kill-switch dial) → default stands: yes**
> (cheap, one bool; the owner never objected). **Q1 (may a FREE user use BYO?) → ANSWERED: NO —**
> see §19.11: the owner's *"free which is the instaweb"* grants free users exactly one engine,
> so both Cloudflare options are premium. **Q2 (did "premium links" mean the Links tab literally?)
> → STILL OPEN** — default stands (P6a treats it as sites; links keep their P4 caps). Everything
> else in this section is unchanged.

1. **May a FREE user use BYO (option 3)? → ANSWERED 2026-10-02: NO.** The owner granted free users
   *"free which is the instaweb"* and nothing else — *"ours should be the premium"* and *"byo … to
   get more"* both sit on the premium side of the line. **Implemented** in `createSite` and
   `resolveDeployCredential` (both 403 `premium_required`, create-time AND deploy-time). This
   supersedes the original default below, which said "yes — the cost sits on the user's own
   account". One line in `lib/hosting/sites.ts` reverts it if the owner ever changes his mind.
2. **Did *"premium links"* mean the Links tab literally?** If yes: custom domain = §18 P5; CF edge
   redirect = new P6c scope. Default: P6a treats it as "sites" and links keep their P4 caps.
3. **Include the `hostingPlatformCfEnabled` kill-switch dial?** Default: yes (cheap, one bool).
4. **Rotation shape:** multiple CF **accounts** in priority order (what §19 builds — "option to add
   more to rotate at the admin"), or one account and rotation is just re-verification? Confirm the
   multiple-accounts reading.
5. **Platform tokens in the DB (AES-GCM, admin adds them from the UI — no redeploy) vs env vars on
   the box?** Default: **DB** — the owner explicitly wants to add/rotate from the admin.

### 19.10 Owner follow-up, verbatim (2026-10-02, same day) — CF-silent UI, premium-first, domains

> "also fix the ui. the hosting label is just for file, and also take out the cloudflare talk on the
> screen, space premium gives users the premium first, then users have option to add cloudflare to
> settings and then be able to add domain easily, and we handle the automation. and if we can also
> allow users just add domain to our cloudflare, just thinking if it wont make things complicated."

**Rules this adds (binding for every future hosting screen):**

1. **"Hosting" must not read as file-only.** The header line describes all three tabs (Files, links
   and sites in one place…). ✅ **DONE** — fixed in the copy pass (committed with §19's scoping run).
2. **Cloudflare talk is OFF the Hosting page.** No "Cloudflare" string on `/dashboard/hosting` —
   engine option 2 is labeled **`Premium`**, the account dropdown says **`Account` / `Ours
   (default)`**, hints say "connect an account in Settings". Brand talk (pasting a CF token) lives
   only in **Settings → Hosting accounts**, which is where the owner wants it. ✅ **DONE** for all
   existing copy; P6a must keep this rule when it rewrites the picker (§19.4 labels below are
   superseded by this rule — read option 2 as the word **`Premium`**, option 3 as **`Yours`**).
3. **Premium-first, zero setup:** a premium user's Premium option works **immediately** — nothing to
   paste, nothing to connect (that is exactly option 2 / P6a). BYO is the *optional* upgrade path,
   not the entry ticket. The current UI (premium disabled until a credential exists) violates this
   and is what P6a fixes.
4. **Domains ride the same flow:** premium first → (optionally) connect their own Cloudflare in
   Settings → **add a domain easily → WE handle the automation** (the TXT/CNAME verification, the
   attachment, the TLS — §18.3's "one record from the user, everything else ours").
5. **"Add a domain to OUR Cloudflare" — feasibility verdict (owner asked "if it won't make things
   complicated"):** **it does NOT complicate the model — it is §18 Path A run on the platform
   account instead of a BYO token.** Because §18 already requires the user to VERIFY the domain
   first (TXT proof they own it), pointing a domain at our platform CF is safe: no zone is ever
   transferred, the user just adds the one CNAME/TXT we show them, and we attach the verified
   hostname via the platform token. The only real constraints: (a) it needs a healthy
   `HostingPlatformAccount` (P6a) to exist — so this is **§18 Path A + platform provider**, not new
   machinery; (b) abusive domains pointed at us are governed by §18.9 Q6's guardrails exactly like
   any other domain. **Recommendation: make "Ours (automatic)" the DEFAULT provider for domain
   binding, with BYO as the escape hatch** — one line in the §18 binding table decides it (§18.9 Q1
   amendment: provider = platform | byo, default platform).

### 19.11 Owner decisions, BINDING (2026-10-02) — premium-only BYO, all three resources

Recorded here because these answered §19.9 and they bind every hosting screen from P6a on.

> "free which is the instaweb … then premium which is the cloudflare and option to add more to
> rotate at the admin, and then byo which is the users own cloudflare **to get more**."

1. **BYO is PREMIUM-ONLY.** Free users get exactly one engine: `local` (our metal), under §14's
   free quotas. Options 2 **and** 3 — *ours* and *yours* — both require premium. Enforced twice,
   at `createSite` and at `resolveDeployCredential` (403 `premium_required`, plain language),
   because a downgrade between create and publish must not buy a Cloudflare deploy. The picker
   disables **both** non-free options with one shared hint ("*Free hosting is included. Premium
   and Yours are both part of the premium plan.*").
   *This supersedes §19.9 Q1's original default. Revert point: one `if (!premium)` in each of
   `lib/hosting/sites.ts`'s two gates.*
2. **Local/free stays open to everyone**, with the admin-editable free caps: `hostingFreeStorageQuotaMb`
   (total stored bytes — files **and** site revisions), `hostingFreeMaxBandwidthGbPerMonth`,
   `hostingFreeMaxFiles`, `hostingFreeMaxFileSizeMb`, `hostingFreeMaxLinks`.
3. **The free STORAGE limit the owner asked for already exists and is wired**: `hostingFreeStorageQuotaMb`
   (default 1024 MB), editable in Admin → Hosting caps as `freeStorageQuotaMb`, enforced in
   `lib/hosting/rules.ts` (uploads) and `lib/hosting/sites.ts` (site trees). Premium reads the
   sibling `hostingPremiumStorageQuotaMb`. **No new migration, no new code** — this item is
   CLOSED; the monthly-shaped part of the ask is `hostingFreeMaxBandwidthGbPerMonth`.
   *Read the owner's "per month" as the bandwidth dial; storage is a standing cap, not a reset.*
4. **Platform + BYO apply to FILES, LINKS and SITES — not sites only.** P6a ships **sites**
   (the resource the owner was testing). The same three-way choice must reach:
   - **files** — **RESOLVED 2026-10-03: files get NO three-way choice.** They stay local
     (instaweb) permanently; the `hostingProvider` dial remains the global uploader selector and
     gains no per-user column. See §19.12.2;
   - **links** — **CONFIRMED**: a redirect gets a per-link engine, CF Workers on a custom host →
     **P6c**, spec §19.12.3. The Links premium cap (500) still applies on top.
   Nobody should report "links don't have the three options" as a P6a bug — it is declared scope.
   And nobody should report "files have no Cloudflare option" as a bug either — that is the
   owner's decision, not an oversight.

**P6a status:** built (schema + migration, resolver, create/deploy gates, three-option picker,
per-site *ours/yours* badge, admin roster route + panel, kill switch, status fields) and covered by
`tests/hosting-platform-accounts.test.ts` + `tests/hosting-platform-admin-route.test.ts`.
**Not yet done:** a real platform Cloudflare account added/verified on the live box (the roster is
empty until the admin pastes one — until then premium sites honestly say "being set up").

---
*End of §19. §19.1–§19.10 were scope; §19.11 records the owner's BINDING answers. P6a's code now
exists (see the P6a status above); P4 (deployed, live), §18 (P5, scoped), §19.11's P6b/P6c and §20
(P6d) are unaffected by it.*

---

## 19.12 Owner decision, BINDING (2026-10-02, REVISED 2026-10-03) — FILES stay LOCAL; LINKS run on Cloudflare Workers. THIS IS THE P6c SPEC

### 19.12.0 The decision, verbatim — and the CORRECTION it makes to the first draft

> **(REVISED 2026-10-03 — this SUPERSEDES the R2 draft that stood here before.)**
> "files should stay local instaweb … only sites and links get the cloudflare option … links
> should be workers on custom hosts … a link can just point at our own /hf/<token> url, so no
> bucket is needed."

The FIRST draft of this section (2026-10-02) put FILES on Cloudflare R2. The owner has since
decided against that. This section therefore now reads:

* **FILES — one engine only: `local` (our own metal).** No R2, no S3 credentials, no bucket, no
  presigned URLs, no public R2 hostname. The P1 implementation is untouched and **P6b does not
  exist as a work item any more**. Nothing in `HostedAsset`, `HostingCredential` or
  `HostingPlatformAccount` changes shape.
* **SITES — `local` | platform Cloudflare Pages | BYO Cloudflare Pages.** Already built and live
  (§19.1–§19.11); unchanged by this revision.
* **LINKS — `local` | platform Cloudflare Worker (edge redirect) | BYO Cloudflare Worker.** This
  is the whole of the remaining work, and it is P6c.

Grounded, not guessed:

* **Pages is static sites only.** It cannot hold a generic binary and it cannot 302, so the
  three-option model must extend to links with a *different* engine: an edge redirect Worker on
  a custom host.
* **Files need no edge engine for links to work.** A Cloudflare link may simply target our own
  stable `/hf/<token>` URL — that URL is already public and already served by us — so there is
  no reason to move bytes to R2 merely to have something to redirect to. This is exactly why the
  R2 layer was cut: it added a second storage system, a second credential type and a second
  failure mode in order to solve a problem a plain redirect already solves.
* The Cloudflare branch stays **premium-only**, exactly like sites (§19.11 rule 1).
* **Free** keeps `local` for links — unchanged, no migration surprise.
* The **resolution rule does not change** (§19.2 verbatim, generalised): a named credential
  means *yours* and only yours; a null credential means the platform roster; anything else is a
  plain-language 403 and **never a silent downgrade to local**.

### 19.12.1 Schema — additive, LINKS ONLY. No `HostedAsset` and no credential column changes shape.

```sql
-- Links: per-link engine + where its Worker lives.
ALTER TABLE "LinkRedirect"  ADD COLUMN "engine"        TEXT NOT NULL DEFAULT 'local';
ALTER TABLE "LinkRedirect"  ADD COLUMN "credentialId"  TEXT;   -- NULL = platform roster
ALTER TABLE "LinkRedirect"  ADD COLUMN "workerName"    TEXT;   -- the deployed script
ALTER TABLE "LinkRedirect"  ADD COLUMN "routePattern"  TEXT;   -- e.g. "go.acme.com/*"
ALTER TABLE "LinkRedirect"  ADD COLUMN "customHost"    TEXT;   -- "go.acme.com"
ALTER TABLE "LinkRedirect"  ADD COLUMN "deployStatus"  TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE "LinkRedirect"  ADD COLUMN "deployError"   TEXT;   -- plain language, never a raw CF error
CREATE INDEX "LinkRedirect_engine_idx" ON "LinkRedirect" ("engine");
```

**That is the entire schema change of P6c.** Nothing else.

**Rules that are not negotiable:**

* **No `HostedAsset` column is added and no storage credential column is added** anywhere. The R2
  draft's `HostedAsset.credentialId` and the sixteen `storage*` columns across
  `HostingCredential`/`HostingPlatformAccount` are **cancelled** — they existed only to serve
  files, and files are local. A migration carrying any of them must never be applied.
* Campaign `LinkRedirect` rows (`userId IS NULL`) get `engine = 'local'` by the DEFAULT and keep
  resolving on `/r/<token>` exactly as in Task 30 — **P2 acceptance is not disturbed.**
* `engine` is `local` by DEFAULT so **every existing link row keeps working untouched**; only a
  newly created link can opt into Workers.

### 19.12.2 Files — UNCHANGED. `local` is the only engine, by owner decision.

* `lib/hosting/files.ts` and `app/hf/[token]/route.ts` keep serving bytes straight off our own
  disk with the P1 semantics intact: same `sha256` anchor, same public/private refusal, same
  rename-touches-only-`dispositionFilename` rule, same `/hf/<token>` stable URL.
  **P6c makes no code change to either file.**
* The single consequence links depend on: a hosted file's shareable URL is
  `<PUBLIC_LINK_BASE_URL>/hf/<token>`, and that is already a perfectly good redirect **target**
  for a Cloudflare link. So "Premium file" is not a thing, and it does not need to be.
* Because nothing moves to the edge, **there is no R2 quota to meter and no bucket to create**,
  and the Files UI does **not** grow a Free/Premium/Yours switcher. Files are simply "Hosted
  files" — one engine, no dial. Sites and Links carry the three-option model; Files does not.

### 19.12.3 Links — Workers on custom hosts

* New `lib/hosting/workers.ts`, all over the REST API with the **account token** we already hold:
  * `PUT /accounts/{id}/workers/scripts/{name}` — **multipart** with a `metadata` part
    (`main_module` + `bindings`) and a `script` part. A JSON body is refused, same class of trap
    as the Pages `manifest` field.
  * `POST /accounts/{id}/workers/routes` — `{ pattern, script }`.
  * `GET /accounts/{id}/workers/routes` for teardown.
* **One script per USER**, not per link: `sw-<hash of userId>`, holding a `const MAP = {...}` of
  `token|slug → target` for that user's `engine = 'cloudflare'` links. Rewriting one map on every
  link change keeps the Workers bill and the route count flat instead of linear per link.
* **Route lifecycle, in order, and each step is verified before the next:**
  1. the user's **custom host** must be a verified zone in the same Cloudflare account
     (`GET /zones?name=<host>` + `zone.status === "active"`), else the link stays
     `deployStatus = "no_host"` with that exact plain-language message;
  2. upload the script (idempotent — a 409/"already exists" is success);
  3. create the route `host/*` → script; an existing identical route is success;
  4. only then set `deployStatus = "live"` and return a URL. **A link is never reported live
     before its route exists** — the same rule the Pages readiness gate taught us.
* A `cloudflare`-engine link **also** stays resolvable on our own `/r/<slug>` route while it is
  deploying, and forever after: the edge is an accelerator, never the single point of failure.
  Editing or deleting a link re-writes the user's map.
* Deleting the last `cloudflare` link on a user deletes the route and then the script (in that
  order), so a half-deleted route can never outlive its script.

### 19.12.4 Caps, rotation and migration defaults

| Dial | Free | Premium / Yours |
|---|---|---|
| Storage quota | `hostingFreeStorageQuotaMb` | `hostingPremiumStorageQuotaMb` — **local bytes only; there is no R2** |
| Per-file size | `hostingFreeMaxFileSizeMb` | same (shared, so the numbers cannot drift) |
| Max files | `hostingFreeMaxFiles` | same |
| Bandwidth | `hostingFreeMaxBandwidthGbPerMonth` | `hostingPremiumMaxBandwidthGbPerMonth` |
| Max links | `hostingFreeMaxLinks` | `hostingPremiumMaxLinks` |

* **Workers cost no storage quota.** A Cloudflare link stores only a map entry; the target is
  somebody else's URL. So publishing a Worker link must **not** consume file quota or count against
  bandwidth — the same rule as a Pages deploy, which was never metered either.
* Rotation is the platform roster, ascending priority, skipping red rows, verified on use. **A
  premium Workers link that cannot be deployed fails with a plain-language reason; it never
  silently stays `local` while the UI says Premium.**
* **Migration defaults:** existing files are untouched (no column changed); existing links keep
  `engine = "local"`. Nothing moves, nothing re-uploads, no downtime, no user-visible change. Only
  a **new** link opts into Workers.
* The `hostingPlatformCfEnabled` kill switch turns down Pages **and** Workers together — one
  switch, no half-on premium. Files are unaffected by the switch entirely.

### 19.12.5 Acceptance bar (P6c — links only)

**Correctness review of 2026-11-02 — three real lifecycle bugs, all fixed and pinned by test.** These were
found while reviewing the engine before first deploy; each was silent, and each would have shipped a
Worker that is live but wrong:

1. **The first link a user ever created was not in its own map.** When `customHost` was omitted, the row
   was created with `customHost` NULL while the publish inferred the host from the zone and filtered the
   map by it — so the row could not match itself. Fixed with `publishUserMap({ includeLinkId })`, which
   re-fetches that one row by id (scoped to the user) regardless of its stored host.
2. **A platform-published link recorded a platform account id in `LinkRedirect.credentialId`.** Teardown
   resolves that column through `getHostingCredentialById`, which matches on the user's own rows, so it
   found nothing: the route and script leaked with no error anywhere. Platform links now record NULL,
   as the schema comment already said they should.
3. **Moving a live link to a different host left the old route serving the old target.** Now the old host
   is torn down first, then the new one is published — and the order is forced, because there is ONE
   script per user: tearing down second would delete the script the new route was about to point at.

Also fixed: zone queries (`/zones`) are now scoped with `account.id=<the credential's account>`, so a
token that can see more than one account cannot match a domain belonging to another.

**Links (P6c)**

* The generated script is asserted to contain **this user's** map and **no other user's** target.
* Route creation is ordered: no verified zone → `no_host` and **no** route call is made.
* Editing a live link rewrites the map; deleting the last link removes route then script, in that
  order.
* A campaign link (`userId NULL`) still resolves on `/r/<token>` with zero behaviour change.
* A `cloudflare` link is still reachable on our own `/r/<token>` — **the local fallback must work
  even when the Worker is live**, which is asserted by test, not assumed.
* The premium gate bites twice: free user + `engine: "cloudflare"` → 403 `premium_required`; and a
  BYO credential that fails verification → 403 in plain language, **never** a local fallback.
* **Files are proven UNCHANGED**: the existing file tests stay green byte-for-byte, and a
  regression test asserts no file row gains an engine/credential column.

**Repo-wide**

* `tsc --noEmit` 0 · focused ESLint at HEAD parity · `npm run test:hosting` and
  `npm run test:pages` green · no secret ever appears in a view, a log line or an API response
  (asserted by test).
* Live, against the real account: mint a link, confirm the Worker route answers a real **302** on
  the custom host.

### 19.12.6 Explicitly out of scope

**Cloudflare R2 / any object storage, for any resource** (cancelled by the owner revision above —
no bucket, no S3 keys, no presigned URLs) · files on the edge · Workers KV analytics · per-link
click attribution through the Worker · moving an EXISTING local link onto a Worker (that is
§16.2-style migration work, owner-gated) · private (authorised-download) files.

---

*End of §19.12. This section BINDS P6c (Links→Workers). P6b (Files→R2) is **cancelled** by the
2026-10-03 owner revision; Files stay local and gain no engine dial. §19.1–§19.11 and §20 are
unaffected by it.*

---

## 20. Owner addition 2026-10-02 (after P4 deploy) — SITE UPLOAD INPUTS: not only `.zip`. SCOPED, NOT BUILT (this IS the P6d spec)
### 20.0 The ask, verbatim (binding)

> "also add to the plan, not only zip option should be available for site upload,, i think we should
> be able to collect file or folder. or what do you think"

The owner wants the **Sites** tab to accept **three inputs** — a **single file**, a **folder**, and
(today's only option) a **`.zip`** — instead of forcing everyone to zip a folder by hand first.

### 20.1 Exists vs missing (all verified in-tree, 2026-10-02)

**Exists / what is actually true today:**
- The upload API `app/api/hosting/sites/[id]/revisions/route.ts` (POST) takes **exactly one**
  multipart part named `file` (a `Blob`). It does **not** accept many parts and does **not** read any
  folder structure.
- `writeIncomingArchive` (`lib/hosting/sites.ts:110`) streams that Blob to disk and **hard-names it
  `<token>.zip`**. The extension is cosmetic — `7z` sniffs the real format by **content**, so a real
  `.zip` works regardless of the name.
- `createRevisionFromArchive` (`lib/hosting/sites.ts:357`) → `listArchive` (`7z l -slt`, `extract.ts`)
  → **`analyseArchive`** (PURE, holds *all* the §16.1 guards: zip-slip / absolute path, symlink,
  nested `.zip`, entry ceiling, per-file ceiling, junk filtering) → `extractArchive` (`7z x`) →
  `scanExtractedTree` (+ `scanSiteFile`, `rules.ts:295`) → preview (`deployRevision`) → publish.
  **The entire pipeline is zip-shaped.**
- The UI is a single `<input type="file" accept=".zip">`; the copy reads *"Zip a folder, check the
  preview, then publish."*
- **A single-file upload does NOT work today.** Post `index.html`: it is stored as `<token>.zip`,
  then `7z l` rejects it as "not archive" → the user gets a bad-archive refusal. It is simply not a
  supported input.
- **A folder upload does NOT work today.** A plain `<input type="file">` yields *files*, not a tree;
  there is no `webkitdirectory`; and the API takes one Blob.
- **The Files tab (a *different* surface) already accepts a single arbitrary file** — this ask is
  about **site** upload only.
- **No JS zip library in `package.json`** (checked: no `fflate`/`jszip`/`adm-zip`/`archiver`). The box
  has only **`7z`** (`unzip` is absent — PLAN §12), so a *server-side* re-zip is not even available.

**Missing (the P6d build list):**
1. The three UI input modes (file / folder / zip).
2. A folder → one-archive normalization for the API.
3. A single-file → one-entry-archive path.
4. Copy naming all three inputs (and the §19.10 rule: no "Cloudflare" string on this screen).

### 20.2 The normalization rule (BINDING recommendation — this is the whole feature in one block)

**Normalize EVERY input to the ONE existing zip pipeline, in the browser.**

```
mode "zip"    → the chosen .zip is uploaded byte-for-byte (today's path, UNCHANGED).
mode "folder" → the browser zips the folder (webkitdirectory gives the tree; a small
                pure-JS zip writer assembles ONE .zip) and uploads THAT.
                Same API call, same caps, same 7z pipeline.
mode "file"   → the browser zips the single file as a ONE-ENTRY archive (member name
                preserved, e.g. index.html) and uploads that.
```

**Why this, and not a second server path — the direct answer to "or what do you think":** the server
pipeline is where every safety guard lives, and all of them are in ONE pure function
(`analyseArchive`) with a real-`7z` test behind it. A **second** server path for loose files or
multi-part folder uploads would mean **re-deriving all of those guards** for data that now arrives as
many HTTP parts with **client-supplied relative names** — a strictly *larger* attack surface (exactly
the class of bug the guard exists to stop) for **zero** user-visible gain. Client normalization keeps
**one** pipeline, **one** set of caps, and **one** place to test.

**Cost, stated honestly:** one tiny pure-JS zip dependency. Recommend **`fflate`** (MIT, ~8 KB, no
native deps, ESM; store-only or deflate). It runs in the **user's browser**, so it never touches the
server's RSS (the reason we deliberately never unzip server-side into memory). The existing
`maxZipMb` ceiling still bounds what any user can send, and `maxZipEntries` still bounds the tree.

**Rejected for v1 (record it so nobody re-proposes it as "free"):** server-side multi-part upload and
server-side zipping of a loose tree. If ever wanted, that is its own task with its own guard tests.

### 20.3 Single-file = the "quick site" case

A lone `index.html` is the most common *"just put this online"* case. Under §20.2 it is a one-entry
zip; the site then serves that file at the revision directory root (`/pv/<token>/` in preview,
`/hs/<token>/` live). **No new serving rule is needed** — it is the existing pipeline with
`fileCount: 1` — but the UX should name it ("Upload a file → we'll serve it as your site's page").

### 20.4 Optional server hardening (NOT required for P6d)

Accept a **loose single file** server-side: if the uploaded Blob is **not** a zip (no `PK\x03\x04`
magic at offset 0), write it straight into the revision staging dir (a single **sanitised** filename —
no path components, so there is nothing to zip-slip), **skip `7z` entirely**, run the **existing**
`scanSiteFile` on it, then the **existing** quota / manifest-hash / preview steps. This is ~30 lines,
removes the last *"you must zip first"* trap for scripts and `curl`, and adds no traversal surface
(there is no archive and no relative path). **Default: build it**; if the lead prefers minimal surface,
the client path (§20.2) alone already satisfies the owner's ask.

### 20.5 Schema impact: NONE

No new table, no new column, **no migration**. The revision row already stores
`archiveName`/`archiveBytes`/`fileCount`/`manifest`; a one-file site is simply `fileCount: 1`. The
`HostingRevision` shape is unchanged, so P6d is **UI + a small `lib/` helper only** — nothing to
deploy-verify in the DB.

### 20.6 UX (Sites tab)

The create-revision form becomes a small segmented control:

```
[ Upload a file ]  [ Upload a folder ]  [ Upload a .zip ]
```

- **file** → `<input type="file">` (any single file; a `.php`-class member is still refused by
  `scanSiteFile` after extraction).
- **folder** → `<input type="file" webkitdirectory multiple>` (desktop; **not available on iOS Safari**
  — mobile users fall back to file/zip).
- **zip** → today's `<input accept=".zip">`.
- Keep the preview→publish hint (unchanged) and the **§19.10 rule: no "Cloudflare" string on this
  screen.**

### 20.7 Phasing

- **P6d (this spec):** the three input modes + client normalization (§20.2), the optional server
  loose-file path (§20.4), the copy, and the tests. **Independent** of P6a/b/c **and** of §18 P5 — it
  may ship before or after them. It touches `components/hosting-panel.tsx` +
  `app/api/hosting/sites/[id]/revisions/route.ts` + a new `lib/hosting/` helper; **P6a touches the same
  panel, so sequence the two if they land in one run.**
- **Not in P6d:** server-side multi-part tree upload, a drag-and-drop editor, incremental/partial
  upload, resume.

### 20.8 Acceptance bar (P6d)

- A folder with subdirectories zipped **in the browser** produces the **same revision** (same
  `fileCount`, same manifest keys) as the same folder zipped **by hand** — proven by a test that builds
  both and compares.
- A single `.html` uploads, previews and publishes; `/hs/<token>/` serves it.
- The existing zip path is **byte-for-byte unchanged** — `test:hosting` stays green and
  `tests/hosting-pages.test.ts` needs no edit.
- Caps still bite: over-ceiling folder → `archive_too_large`; over-entry folder → `too_many_entries`;
  a >25 MiB member → `file_over_limit`; a `.php` member → `scanSiteFile` refusal.
- `tsc --noEmit` 0 · eslint at HEAD parity · `CI=1 next build` 0 · `npm run test:hosting` green.
- **Live after deploy:** upload a folder on `/dashboard/hosting` → preview 200 → publish → `/hs/<token>/`
  200. (This closes the **P3 write-path gap** that §6.4 of the handoff still lists as unverified — do it
  here rather than leaving it open.)

### 20.9 Open questions for the lead — ANSWER BEFORE P6d BINDS

1. **Zip dependency:** add **`fflate`** (recommended), or prefer **store-only** (no compression → larger
   uploads, but a ~200-line writer we own and no dependency)? Default: **`fflate`**.
2. **Folder on mobile:** confirm *"file/zip only; folder is desktop-only"* is acceptable
   (`webkitdirectory` is not on iOS Safari). Default: acceptable.
3. **Loose-file server path (§20.4):** build it, or client-only? Default: **build it**.

---

*End of §20. Scope only — no P6d code exists yet. §20 is the binding spec for P6d. P4 (deployed, live),
§18 (P5, scoped) and §19 (P6, scoped) are unaffected by it.*
