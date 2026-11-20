# LIVE TRIAGE — 2026-10-03 — hosting / Pages / links / accounts

> Written from a live investigation against **production** (app, Postgres, and the two real
> Cloudflare accounts). Every claim below is backed by a command + its output, quoted inline.
> **This document is the source of truth for the five items the owner raised.** Read it before
> starting the next piece of work.
>
> HEAD at time of writing: `main` @ `71ca4d7` (synced with `origin/main`), tree clean.

---

## 0. TL;DR for the five questions

| # | Question | Verdict |
|---|----------|---------|
| 1 | Pages preview "shows the same error" | **NOT SSL. NOT Cloudflare. ALREADY FIXED** in `0452397`, deployed. The owner tested a preview built 38 min *before* the fix. Re-upload → works. See §1. |
| 2 | "I don't want broks.beauty linked anywhere" | The owner's own `mylink` → `go.broks.beauty` is the only link and it works. **But there is a real governance hole**: the platform token spans the private device zone. Needs a 2-minute CF token fix + a server-side denylist. See §2. |
| 3 | Add a domain from the app? | **Yes.** One `POST /zones`, then **one unavoidable manual step** (set 2 nameservers at the registrar). No CF-for-SaaS needed. Token scope for zone creation is **still unverified**. See §3. |
| 4 | "2 of 2 accounts usable" — what does that mean? | An **ordered fallback pool**, not capacity. The number hides a real **split-brain**: one account has Pages, the other has Workers. See §4. |
| 5 | Add a tickets tab | Not built. Schema + API + UI sketched in §5, gated on §3. |

---

## 1. The Pages "error" — ROOT CAUSED, and it was ALREADY FIXED

### What the owner reported
A preview URL showed "this page can't be found", and it recurred on re-uploading the same file.
The earlier read of this as an **SSL/certificate** problem was **wrong** — see §1.3.

### 1.1 The decisive evidence

```
$ curl -o /dev/null -w '%{http_code}' https://c01095fa.testsite-735.pages.dev/
404                                   <-- the site root
$ curl -o /dev/null -w '%{http_code}' https://c01095fa.testsite-735.pages.dev/inn/
200                                   <-- the SAME deployment, one folder deeper
```

The deployment itself is healthy and successful:

```
GET /accounts/<a>/pages/projects/testsite/deployments/c01095fa-…
  environment = "preview"
  url         = https://c01095fa.testsite-735.pages.dev
  latest_stage= {"name":"deploy","status":"success"}
  files       = {"/inn/.DS_Store":"3f5dd93…", "/inn/index.html":"5c52362…"}
                      ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                      EVERY FILE IS UNDER /inn/ — THERE IS NO /index.html AT THE ROOT
```

Contrast with the site uploaded *later*, which works:

```
GET …/projects/test2/deployments/f4a1d80b-…
  files = {"/index.html":"5c52362…"}          <-- at the root
  → https://f4a1d80b.test2-bli.pages.dev/  == 200
```

### 1.2 Root cause, and why it "kept happening"
The owner uploaded a **zip made by selecting a folder** (Finder / Explorer both put ONE
top-level directory inside the archive). The pipeline extracted it verbatim, so the Pages
manifest was `inn/index.html`. Cloudflare Pages serves exactly the manifest it is given;
with no root `index.html` it correctly answers `/` with **404**. Re-uploading the same zip
### 1.3 It is definitively NOT an SSL problem
```
$ curl -w 'ssl=%{ssl_verify_result}' https://f4a1d80b.test2-bli.pages.dev/
  → ssl=0 (OK), code=200
$ echo | openssl s_client -connect f4a1d80b.test2-bli.pages.dev:443 -servername …
  subject=CN=test2-bli.pages.dev
  X509v3 SAN: DNS:*.test2-bli.pages.dev, DNS:test2-bli.pages.dev
  notBefore=Oct  3 11:33:14 2026 GMT   notAfter=Jan  1 11:33:13 2027 GMT
```
TLS 1.3 negotiates, the chain verifies, and the wildcard covers the host. Cert provisioning
also **preceded** the deploy, so a "cert not ready yet" theory is ruled out too.

### 1.4 THE FIX IS ALREADY IN `main` AND ON PRODUCTION
```
$ git log -1 -S 'singleRootPrefix' -- lib/hosting/extract.ts
0452397 2026-10-03 01:59:27 +0100
        fix(hosting): Pages root 404 root-caused - unwrap the zipped folder + gate on deployment readiness
```
The commit adds `singleRootPrefix()` (`lib/hosting/extract.ts:133`) + `collapseRootDir()`,
called from `lib/hosting/sites.ts:445`, and strips the wrapper prefix **only when unambiguous**
(every non-junk path shares one top-level dir and no top-level file sits beside it — a site
with two genuine top-level folders is left exactly as the user zipped it). It also drops
`.DS_Store`, which is why it shipped in the old manifest.

**THE TIMING IS THE WHOLE STORY:**

| event | time (UTC) |
|---|---|
| `testsite` preview deployed → **404** | `2026-10-03 00:21` |
| fix `0452397` authored | `2026-10-03 00:59` (+0100 01:59) |
| `test2` preview deployed → **200** | `2026-10-03 12:29` |
| P6c deployed to production (`24c55b2`) | `2026-10-03` later |

`0452397` is an ancestor of the deployed `24c55b2`, so **production already contains the fix**.
---

## 2. `broks.beauty` — what is actually linked, and the real risk

### 2.1 Current state (live)
Exactly **one** Cloudflare-engine link exists, and it is the owner's own:

```
id=cmusdejvt0013kpiz8fd9awns  slug=mylink  host=go.broks.beauty  status=live
target=https://spaceworker.instaweb.top/r/REyVckus6rBr_PgKxvwmT6AP
```
It resolves end-to-end (verified):
```
go.broks.beauty/mylink        → 302 → spaceworker.instaweb.top/r/REyVckus… → 302 → dl.instaweb.top/hf/FjvmXrKO…
```
The deployed Worker map is correct and current — both keys are the **token** and the **slug**
of that one link, per `lib/hosting/links-engine.ts:131-134`:
```js
const MAP = {"2QtmwpaSQl4qP_jVn7Q4cmwM":"…/r/REyVckus6rBr_PgKxvwmT6AP",
             "mylink":"…/r/REyVckus6rBr_PgKxvwmT6AP"};
```
(The 302 target being `/r/<token>` is **not** a bug — the user chose a `/r/` URL as the link
target. The Worker faithfully serves `row.target`.)

### 2.2 THE ACTUAL PROBLEM — a governance hole, not a bug
The platform Cloudflare credentials in account `9bc97c44…` ("New Prod") can see and write
**all four zones in the account**:
```
ZONE broks.beauty : routes=["go.broks.beauty/* -> sw-027970396cd46c94fd3b39e958bbd5c5"]
ZONE instaweb.top : routes=[]
ZONE mainaccess.top: routes=[]
ZONE spaceworker.top: routes=[]
```
`broks.beauty` is the owner's **private device domain**. Because the token carries zone-wide
`Zone:Read` + Workers-route write for it, **any premium user who sets a custom host under
`broks.beauty` will succeed** — the app will happily create a Worker route on the private
domain. That is the thing actually worth fixing. Three layers, do all of them:

**(a) Immediate — 2 minutes, CF dashboard, no deploy.** Edit the platform API token's
**Zone Resources** from "All zones" to **Include → specific zones**: `instaweb.top`,
`mainaccess.top`, `spaceworker.top`. That removes `broks.beauty` from the app's reach entirely.
*(The owner should confirm the free-plan token limit before deleting/recreating.)*
---

## 3. "Can I add a domain to my Cloudflare account from the app?"

### 3.1 Yes — with exactly ONE manual step, and no CF-for-SaaS
Cloudflare's API creates a zone outright:
```
POST /zones  { "name": "example.com", "account": { "id": "<acct>" } }
  → 200, zone created, status = "pending", response carries name_servers: [ns1…, ns2…]
```
The user then does the **one unavoidable step**: paste those two nameservers at their
registrar. There is no API that changes registrar nameservers — that is a hard boundary of
internet governance, not a product limitation. After the change, Cloudflare flips the zone to
`status: "active"` (usually minutes, up to ~24h), and everything we already have works.

**Cloudflare for SaaS / custom hostnames is NOT needed for this.** It would only be needed to
point a hostname at our zone **without** transferring nameservers — a separate, very likely
paid product. Do not build it for this ask.

### 3.2 The recommended UX (replaces "go to the dashboard")
1. User enters a domain and picks **BYO** (their own CF account) or **platform**.
2. App calls `POST /zones` and **shows the two assigned nameservers**, with a copy button.
3. User updates the registrar (the single manual step) and returns.
4. App polls `GET /zones?name=…` until `status === "active"` — server-side `listActiveZones()`
   already exists.
5. App then offers the existing `go.<domain>` setup.

Existing **active** zones must be usable **immediately** — only brand-new domains need step 2.
Add an **active-zone picker**; never silently use the first active zone.

### 3.3 **RESOLVED 2026-10-03 — NO, the tokens CANNOT create zones** ⚠️ (probe ran; see §3.5)

**Probed live against all 3 platform accounts / 5 configured tokens. Every one returned
the same 403.** The tokens are scoped to Pages + Workers/DNS only; zone creation is a
separate **account-level** permission they do not carry.

### 3.5 The probe — what was run, and the exact answer

Run **read-only / zero-write**, on the VPS, reusing production code
(`lib/mailbox-crypto.ts` `decryptSecretOrThrow` + the real `HostingPlatformAccount`
rows). **No token value was ever printed** — only labels, ids, hints and statuses.

**Method (why this is conclusive without touching a real domain).** For each token:
1. `GET /user/tokens/verify` — is the token even alive;
2. `GET /zones?per_page=3` — can it *read* zones;
3. **`POST /zones` with a deliberately INVALID domain name** — the probe.

Step 3 is the trick. A create with an invalid name **cannot create a zone** — but
Cloudflare evaluates the **account permission before validating the domain**, so the
HTTP status answers the permission question with **zero risk of actually claiming a
domain**. The trade-off: a `403` here is unambiguous (permission denied), while a `400`
would only have been *suggestive* and would have required a real throwaway domain on a
domain the owner controls to confirm.

**Raw result — all 3 accounts, all 5 configured tokens, identical outcome:**

| Account | Cloudflare acct id | Token | Zones readable | `POST /zones` |
|---|---|---|---|---|
| Primary cf | `4c822d3b…` | Pages `…fd99` | 0 | **403** |
| New Prod | `9bc97c44…` | Pages `…6939` | 0 | **403** |
| New Prod | `9bc97c44…` | Workers/DNS `…419f` | **3** (`broks.beauty`, `instaweb.top`, `mainaccess.top`, all `active`) | **403** |
| hosting Premium Links | `43b24dc0…` | Pages `…177b` | 0 | **403** |
| hosting Premium Links | `43b24dc0…` | Workers/DNS `…a5d7` | 0 | **403** |

Exact Cloudflare error on all five:
```
403  0: Requires permission "com.cloudflare.api.account.zone.create"
         to create zones for the selected account
```

**The exact permission needed** (for the record): `com.cloudflare.api.account.zone.create`
— in the CF dashboard, **Zone → Zone → Edit** scoped to the **ACCOUNT**. A token scoped
to specific zone *resources* cannot create a new zone at all; it needs account-wide
zone scope.

**Two side-findings from the same probe:**
- **A THIRD platform account now exists**: `hosting Premium Links` (`43b24dc0…`) — the
  per-purpose account pinning added earlier. It has **zero zones**, so it can serve
  `workers.dev` links only, never a custom domain.
- **`broks.beauty` is still visible to the Workers/DNS token on `New Prod`** — the
  §2.2 governance hole is **unchanged**, still un-remediated.

**Cleanup:** probe script + runner + the temp env file (holding `DATABASE_URL` and
`MAILBOX_ENCRYPTION_KEY`) were `shred`ed/`rm`'d from the VPS. No zones created, no DB
writes, `spaceworker.service` still `active`.

**⇒ Consequence for the domains wizard:** automatic zone creation is **NOT available**
with today's tokens. Either (a) the owner grants `zone.create` and this probe is re-run,
or (b) ship the **support-ticket fallback** for brand-new domains — with **active zones
in existing accounts** fully usable immediately (they need no creation at all). Option
(b) is buildable today and covers the user's day-to-day need.
---

## 4. "2 of 2 accounts usable" — what that number actually means

### 4.1 The definition (`components/admin/platform-accounts-panel.tsx:103`)
```ts
const healthy = accounts.filter(a => a.status === "active" && !a.verifyError).length;
```
Rendered at line 128 as `"{healthy} of {total} account(s) usable"`.

That is **healthy platform-account rows** — nothing more. It is **not**:
- a count of Pages projects,
- a count of simultaneous capacity,
- round-robin capacity of any kind.

### 4.2 It is an ORDERED FALLBACK POOL, not round-robin
`resolveForDeploy` walks the roster by **ascending `priority`** (1 = primary), skipping rows
that are not `active` or that carry a `verifyError`, verifying each candidate **on use**, and
taking the **first healthy row**. Worker publishing additionally skips any row with no
encrypted Workers token (`requireWorkers`, `platform-accounts.ts:318,346`). So N healthy rows
= N levels of redundancy, not N-way throughput.

### 4.3 The number currently HIDES a real split-brain
Live probe of the two rows:

| row | Pages token | Workers token | Pages projects | zones |
|---|---|---|---|---|
| `Primary cf` (priority 1) | ✅ valid | ❌ **none** | `test2`, `testsite` | none |
| `New Prod` (priority 2) | ❌ **none** | ✅ valid | none | `broks.beauty`, `instaweb.top`, `mainaccess.top`, `spaceworker.top` |

So **sites go to account A and links go to account B**, right now. Both are "healthy" so the
panel says 2 of 2 and the split is invisible. If account A's Pages token breaks, *sites* break
while the panel still reads healthy.

### 4.4 The fix
Report health **per capability** rather than as one number, e.g. `Pages 1/1 · Workers 1/1`,
---

## 6. Verification commands used (reproduce anything)

```bash
# Tunnel used for all DB reads
ssh -i ~/.ssh/tacticalrmm_vps -N -L 127.0.0.1:15432:127.0.0.1:5432 root@164.68.105.96

# The one command that settles the Pages question
for p in / /inn/ /inn/index.html /index.html; do
  printf '%s -> ' "$p"; curl -s -o /dev/null -w '%{http_code}\n' "https://c01095fa.testsite-735.pages.dev$p"; done

# TLS is fine (refutes the SSL theory)
curl -s -o /dev/null -w 'ssl=%{ssl_verify_result} code=%{http_code}\n' https://f4a1d80b.test2-bli.pages.dev/

# The deployment manifest that shows the real cause
GET /accounts/<acct>/pages/projects/testsite/deployments/c01095fa-b34f-4cac-b94b-899b283661a7
  → files = {"/inn/.DS_Store":…, "/inn/index.html":…}

# Zones + worker routes visible to the platform token
GET /zones?account.id=<acct>            ; GET /zones/{id}/workers/routes
```

---

## 7. What the next agent should do, in order

1. **Tell the owner §1.5** — re-upload the zip. No code needed; the bug is already fixed.
2. **Do §2.2(a)** — narrow the token's zone resources in the CF dashboard (owner action, 2 min).
3. **Implement §2.2(b)** — the reserved-host denylist + its tests. Small, self-contained, and
   it closes the real hole in `broks.beauty` regardless of token config.
4. **Verify §3.3** — does a Zone:Edit token create zones? Record the answer before any UI work.
5. **Then build the §3.2 domain wizard**, gated on 4, and only after the owner answers §3.4.
6. **§4.4** per-capability health, once §4.5 (priority migration) is confirmed.
7. **§5** tickets last — it is the landing pad for 4 and 5.

---

## 8. Cleanup required (temp artefacts, not in the repo)

```bash
rm -f /tmp/.swprod.env /tmp/.accts.txt /tmp/.cfprobe.mjs /tmp/.cfpages.mjs \
      /tmp/.cfdeploy.mjs /tmp/.cfscript.mjs /tmp/.cftestsite.mjs /tmp/.cfassets.mjs /tmp/.cfdep.mjs
pkill -f '15432:127.0.0.1:5432'      # the production DB tunnel
```
None of these are tracked by git; the repo tree is clean.
driven by whether each row has the token for that engine. Label it in plain words
("ready for sites" / "ready for links"). **Do not** expose a "current account" selector until
the migration question below is answered.

### 4.5 OPEN QUESTION — does changing priority migrate anything? ⚠️
Re-ordering the roster is believed to affect **future deployments only**. It does **not**
migrate existing Pages projects or existing Worker links to the other account. **This is
believed, not verified.** Confirm before building any UI that implies a switch, or a user may
click "make this the primary account" and lose their site.

---

## 5. Support tickets — scoped, not built

No ticket/support implementation exists anywhere in `app/`, `lib/` or `components/` (searched).

### Minimum scope
- A **user** opens a ticket (e.g. "help me add this domain") and can reply.
- An **admin** sees it, plus read-only context: zone name, zone `status`, the two assigned
  nameservers, which platform account row serves it, and the last error.
- Status lifecycle: `open → resolved / closed`; threaded replies.

### Hard rules
- **Never store Cloudflare API tokens on a ticket.** Tokens are per-row encrypted at rest; a
  ticket is a read surface. Attach metadata only.
- Every ticket auto-captures the zone's `id`, `name`, `status`, `name_servers` and the owning
  platform account id **at open time** (and re-syncs on admin view) so the admin does not have
  to re-query Cloudflare to answer the common case.
- Premium/admin gate the admin side, matching the existing admin surfaces.

### Blocked on
§3.3 (token scope) and the owner's §3.4 trust decision — the ticket is where a user who hits
the nameserver wall or a token problem actually lands.

**Verification step (do this before writing the UI):** mint a candidate token in the CF
dashboard, then probe it against a **throwaway domain the owner controls** (e.g. a subdomain of
a domain they own that is NOT yet a CF zone):
1. `POST /zones` → does it return 200, or a `403` listing a missing permission?
2. If 200, `DELETE /zones/{id}` to clean up.
3. Record the exact permission set needed in `SENIOR_HANDOFF.md`.

Do **not** test against `broks.beauty` (already a zone) or a domain the owner does not own.

### 3.4 A product decision the owner must make
If the domain is added to the **platform** account, **we then control that domain's DNS**. That
needs explicit consent in the UI, and it is a materially different trust posture than BYO.
Recommendation: default to **BYO**, offer platform as an explicit, clearly-worded choice.

**(b) Server-side denylist (defence in depth).** A reserved list consulted on link
create/edit, refusing a `customHost` whose registrable domain is on it — **regardless of what
the token permits**. Make it config-driven (env) so it is testable, and give it a distinct error
code (e.g. `reserved_host`) so the UI can say "that domain is reserved".
Relevant: the link create/edit validation in `app/api/hosting/links/route.ts` and
`app/api/hosting/links/[id]/route.ts`.

**(c) Zone allowlist on the Worker publish path.** `publishWorkerMap` already takes a zone id;
add the set of zone ids the Worker engine is permitted to publish into. Then the blast radius
of a leaked token is bounded to the three platform zones.

**(d) If the owner wants `go.broks.beauty` gone now:** delete the `mylink` link
(`DELETE /api/hosting/links/cmusdejvt0013kpiz8fd9awns`). P6c's teardown is **fail-closed** —
route, script entry and DNS record are removed together, already live-verified.

> **State left behind:** `go.instaweb.top` DNS was **intentionally retained** (not orphaned).

### 1.5 ACTION FOR THE OWNER (2 minutes, no code)
**Re-upload the same zip.** The existing `testsite` preview is a stale artefact from before
the fix and will keep 404-ing forever — it is not evidence of a live bug. `test2` already
proves the fixed pipeline serves `/` correctly.

### 1.6 Small follow-up worth doing (not urgent)
`deployTree()` already returns the **stable** preview alias (`dv.alias`, e.g.
`https://preview-<branch>.<project>.pages.dev`) but `deployRevision()` in
`lib/hosting/sites.ts:700+` stores `dv.url` — the **ephemeral per-deployment hash host**
(`https://f4a1d80b.…`). Hash hosts change on every preview and are not meant to be shared or
bookmarked. Prefer `dv.alias ?? dv.url` for `previewUrl`. The two behaved identically in this
incident, so this is hygiene, not a bug fix.
reproduces it exactly — hence "the same error, every time". **The platform was never at fault.**