# PLAN — Task 155: Workers & Pages (hosting, redirects, files, converters)

**Status: SCOPED + UNBLOCKED — owner answered §13 on 2026-10-01 and supplied a throwaway
Cloudflare account/token for the T0 spikes (§13.2). Buildable now: T0 → P1 → P2 → P3.**
**v1 = FREE-FIRST on our own metal** (files + redirects; no Cloudflare needed). Cloudflare
(Pages, custom domains, bulk redirects, R2) is a *later* engine, never the only path.
**Companion doc: `PLAN_TASK_156_CYBERLAB_REAL_WORLD_TOOLS.md` — these two ship hand in hand.**

**Owner's one-line version:** give every SpaceWorker user **one place to put something on
the internet and get a link** — a web page, a redirect/short link, a file (including a
*renameable* EXE), a converted file — with **Cloudflare Workers/Pages** as the engine, our
own **`dl.*` host** as the free tier, and **the agent doing the work**, so a user with zero
hosting experience never sees a dashboard, a CLI, or a token.

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
| **File type converter** | images (png/jpg/webp/avif, resize), docs (pdf→text, xlsx→csv via existing `xlsx`), archives (7z/zip) | C | ✅ (see §12 gating) |
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

- **New nav item "Hosting"** — one entry in `NAV_ITEMS` (`components/dashboard-nav.tsx:36`),
  icon e.g. `Cloud`. NB the dock/mobile nav are generated from that single array, so this is a
  one-line change that cannot drift.
- **Sections:** *Sites* (cards w/ thumbnail + URL + open/copy), *Links* (list + create),
  *Files* (upload, rename, convert, expiry), *Connection* (token mode, BYO token, scopes
  checklist, health), *Templates* (gallery).
- **Zero-experience path first:** the top of the tab is **not** a dashboard — it is a
  one-sentence box ("What do you want to put online?") that hands off to the agent.
- **EXE build target:** hosting is web-only → add these hrefs to the EXE exclusion logic the
  same way `BUILD_ALLOWED_HREFS` (`components/dashboard-nav.tsx:52`) already narrows the
  extractor build.

---

## 9. Phased delivery — free first

### T0 — Spikes (no user-facing code; answers the open questions in §2)
- **S0-a** Confirm R4/R15 and the custom-domain endpoint with **one real curl** against a
  throwaway Cloudflare account (owner's). Deliverable: a short evidence note appended here.
- **S0-b** Prove **Direct Upload over raw REST** for a 3-file static site, and prove the
  **25 MiB rejection** (upload a 26 MiB file → observe the failure) so the constraint is
  witnessed, not assumed.

### P1 — Files engine on our own metal (free, no Cloudflare at all)
- Upload/list/rename/delete; `Content-Disposition` rename with `sha256` unchanged;
  expiry; per-user quota (AdminSetting). Ships behind the `hosting` entitlement, **dark**.
- **Exit:** a user uploads an EXE, renames it, downloads it, and the hash matches.

### P2 — Redirects, user-owned (free, no Cloudflare)
- Promote the existing `/r/<token>` machinery to user-owned links + custom slugs + hits.
- **Exit:** create a link in the tab, click it from a real browser, see the click counted.

### P3 — Pages engine (BYO token)
- Connection pane + scoped-token checklist + verify-on-save; deploy a site from a template;
  return the live `*.pages.dev` URL. **Agent can do it** via a gated proposal.
- **Exit:** "build me a landing page for X" → a real public URL, produced end-to-end by the agent.

### P4 — Templates + converters + bulk redirects
- Template gallery; image/doc/archive conversion; CSV → Bulk Redirects (R11) on a custom zone.

### P5 — Platform-token "try it" tier + managed pool
- Cap, quota, reclaim idle platform projects; the multi-account pool + switcher.

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
| **Image conversion** | ❌ **no `sharp`** in deps; **no ImageMagick** on VPS | add `sharp` (pure npm, no sysdeps) **or** install `imagemagick` |
| **Doc conversion** | ❌ **no LibreOffice/pandoc** on VPS | install `libreoffice --headless` in the deploy image, or scope to what `xlsx`/`pdfjs-dist` already do |
| **Archive** | ⚠️ `7z` **present**, `zip`/`unzip` **absent** | prefer the `7z` already installed |
| **Video** | ❌ `ffmpeg` **absent** | out of scope until demand (heavy dep) |
| **R2** | ❌ not configured; needs billing (R13) | premium/BYO path only |
| **Cloudflare account + token** | ✅ **throwaway account/token supplied 2026-10-01** (§13.2); Account ID `4c822d…0492` | The token verifies `active` and — with the Account ID — `/pages/projects` and `/workers/scripts` return **200** (R2 → **403**, no scope). The **T0 spikes** (25 MiB rejection, Direct-Upload REST, R4/R15, custom-domain endpoint) are still unrun. The real **platform** token is a production decision. |

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

- **Q4 — converters:** heavy binaries (`libreoffice`, `ffmpeg`) on the VPS vs dependency-free
  (`sharp`, `7z`, `xlsx`, `pdfjs`). **Owner did not answer.** P4 only; recommend dependency-free.
- **T0 facts still unverified** (§2): R4, R15, the exact custom-domain endpoint, and whether a
  Free-plan account can create tokens via API without extra scopes — **spike them, don't assume**.

*Historical (pre-answer) questions retained for provenance:*
1. Wedge for v1: files+redirects on our own metal (P1/P2), or Pages (P3)? *Rec: P1→P2→P3.*
2. Platform token tier: days before reclaim?
3. Custom domains: premium only?
4. Converters: heavy binaries or dependency-free? *Rec: dependency-free.*
5. AUP: which lawyer?
