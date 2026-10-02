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

### P1 — Files engine on our own metal (free, no Cloudflare at all) — ✅ **DONE + PROVEN 2026-10-01 (`a131835`), NOT deployed**
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

### P3 — Pages engine + folder→preview→publish + the engine switch (**§16 BINDS this — it is the next build**)
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

