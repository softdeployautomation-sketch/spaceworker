# PLAN — TASK 157: Platform Domains, Premium Hostnames & Support Tickets

**Status:** design locked, Phase 1 starting.
**Predecessor:** Task 155 (Workers & Pages) — commit `2ac7b1c`, deploy `37129561869`.
**Successor:** Task 156 (Cyber Lab) — deferred until this lands.

---

## 1. The request (owner, 2026-10-03)

> we have the instaweb, we can use the instaweb domain for the publish … make it
> available in the admin so I can allow users to use a certain domain I add …
> an easy way to switch any time I add a new domain, and this should be
> available for the redirect too, so I can always switch domains for premium
> easily from admin … I like the way it goes to dev, it's nice, just want that as
> an option, maybe publish to the site's premium domain … also add domain to the
> hosting, restructure the hosting, and add tickets in SpaceWorker so users can
> create a ticket.

Decomposed into six deliverables:

- **D1** Premium sites publish on a platform domain (`instaweb.top`), not only `<project>.pages.dev`.
- **D2** Admin can change the premium domain(s) **live**, no redeploy.
- **D3** The same premium domain mechanism drives **redirect links**.
- **D4** Free tier uses a Cloudflare-hosted *dev* host with **no domain at all** — the
  `<project>.pages.dev` / `*.workers.dev` equivalent — so a free user never needs a zone.
- **D5** Hosting UI restructured: a real **Domains** section (BYO + platform).
- **D6** User-facing **support tickets**, carrying zone metadata only — never tokens.

---

## 2. Live reconnaissance (read-only, 2026-10-03)

Probed through the encrypted platform credentials; **no writes were made**.

| | Primary `4c822d3b…` | New Prod `9bc97c44…` |
|---|---|---|
| Zones | **none** | `instaweb.top`, `mainaccess.top`, `spaceworker.top`, `broks.beauty` — all `active` |
| Pages projects | 9 (`test2`, `testsite`, `fileshare`, …) | **0** |
| `workers.dev` subdomain | `403` — never configured | **`myrate619`** |
| Worker scripts | none | `sw-027970396cd46c94fd3b39e958bbd5c5` |

Two facts constrain the design, and they are not the same account:

1. **Zones and Pages projects live on different Cloudflare accounts.** A Pages custom
   domain can only be created and pointed automatically when the zone sits in the
   *same* account as the project. Premium sites must therefore publish to **New Prod**.
   Publishing to Primary and pointing it at `instaweb.top` would leave a permanently
   `pending` domain and a broken live URL.
2. **`myrate619.workers.dev` already exists.** That is the zero-domain host D4 needs —
   no DNS record, no zone, no registrar, nothing for a free user to configure.

Note: the New Prod token still *sees* `broks.beauty`. That is the reserved zone. The
server-side reserved-zone guard is what protects it (narrowing the token is defence in
depth, not the control). **Re-probing/restricting that token remains open.**
---

## 3. The model

One idea, applied twice: **free runs on Cloudflare's own free hostname; premium runs on
a platform domain the admin controls.**

| | Free (no domain, zero setup) | Premium (platform domain) |
|---|---|---|
| **Sites** | `<project>.pages.dev` | `<slug>.<premiumSiteDomain>` e.g. `<slug>.instaweb.top` |
| **Links** | `<script>.myrate619.workers.dev` | `<premiumLinkDomain>` e.g. `go.instaweb.top` |

- The dev host is **always available** and remains the fallback when a premium domain
  is unset, its zone is not `active`, or attach fails. The owner asked to keep it: *"I
  like the way it goes to dev, it's nice, just want that as an option."* So dev is not
  removed — it becomes the default and the safety net, and premium becomes the option.
- Both premium domains are `AdminSetting` columns, read server-side per request, edited
  from the admin panel. Changing one is a **live change**, exactly like every other cap
  (CROSS-TRACK RULE 7).
- The local `/r/<token>` fallback is untouched and stays as the last-resort tier.

### AdminSetting additions (additive, default to today's behaviour)

| Column | Default | Meaning |
|---|---|---|
| `hostingPremiumSiteDomain` | `""` | Base zone for premium sites. Empty ⇒ dev-only. |
| `hostingPremiumLinkDomain` | `""` | Full host for premium links. Empty ⇒ dev-only. |

Empty defaults mean **this migration changes nothing until the owner types a domain** —
the same safety property as `hostingEnabled`.

---

## 4. Phases

**Phase 1 — Domain registry (spine).** Schema columns, a pure `lib/hosting/domains.ts`
resolver (`resolveSiteHost` / `resolveLinkHost`), the admin API `kind: "domain"`
validator, and the admin panel fields. Unit-tested; no behaviour change yet.

**Phase 2 — Sites on the premium domain.** `POST /accounts/{id}/pages/projects/{p}/domains`
at publish time, adopt-if-exists, poll `active`/`pending`, keep `<project>.pages.dev` as
`revision.cfUrl`. Teardown detaches. Read the account from the *zone*, not from
platform-account priority, so a priority change cannot strand a published site.

**Phase 3 — Links: dev host + premium domain.** Prefer `hostingPremiumLinkDomain`; fall
back to `go.<zone>` then to `*.workers.dev`. Free links skip DNS and routes entirely.
Route creation becomes zone-optional.

**Phase 3b — Per-purpose account pinning (owner 2026-11-04).** Implemented ahead of the
site custom-domain work because the owner wants premium LINKS on a dedicated
Cloudflare account and did not want the free/Pages side moved. `AdminSetting`
`hostingPremiumLinksAccountId` / `hostingPremiumSitesAccountId` name one Cloudflare
account per purpose; `resolvePlatformCredential({ pinAccountId })` honours it.

Priority alone could not express this: both `sites.ts` and `links-engine.ts` walk the
same ascending-priority roster, so an account placed first to win links also wins
sites. Pins are values the admin can edit live, and a pin **fails loudly**
(`pinned_account_missing` / `pinned_account_unavailable`) rather than rotating on —
silently serving premium links from the free account's subdomain is the exact mixing
the pin exists to prevent. Default `""` leaves every existing install byte-for-byte
unchanged.

**Phase 4 — Domain onboarding wizard.** ⚠️ **REVISED 2026-10-03 after the live probe —
see §7.4.** The original flow (BYO or platform → `POST /zones` → show the two assigned
nameservers → poll to `active`) **cannot run**: the probe proved every platform token
returns `403 com.cloudflare.api.account.zone.create`.

**⚠️ REVISED AGAIN, 2026-10-03 (later) — the owner corrected the target model.** The
first revision assumed users would pick from the platform's own active zones. The owner's
actual requirement is the opposite, and it is an **ownership** rule:

> "i don't want users too be able to pick instaweb or mainaccess.. and i don't want to use
> mainaccess at all.. the platform domains are only selectable by admin, users can only
> select the domain they own or added"

So Phase 4 is **not** a zone picker over platform zones. It is:

- **4a (BUILT, this session) — the `UserDomain` registry + the two guards.**
  A user owns a domain; a user's list can contain ONLY domains they own. Enforcement is
  in the data layer (`lib/hosting/domain-registry.ts`), never by hiding rows in the UI.
  **Two deliberately SEPARATE guards**, because the two owner instructions are different
  rules and merging them would break one of them:
  - `RESERVED_ZONES` (a **write** guard) — `mainaccess.top` joins `broks.beauty` here:
    nobody writes there, ever.
  - `PLATFORM_ONLY_ZONES` (a **selection** guard) — `instaweb.top`: we may publish there,
    a **user may not select it**. It is NOT retired, because the owner asked to hide it
    from users, not to decommission it. A test pins that `instaweb.top` fails selection
    while still passing writes — that is the proof the two guards are genuinely distinct.
- **4b — the user's "add a domain" input**, accepted on **Cloudflare's own rules**
  (`normalizeDomainInput` / `isValidDomainApex`: DNS 1123 labels, 1–63 chars, no
  leading/trailing dash, alphabetic TLD, ≥2 labels), plus an apex reduction so
  `www.shop.example.co.uk` → `example.co.uk`. Deliberately NOT a public-suffix list:
  being *more* permissive than Cloudflare is safe (the write still fails closed), being
  stricter would reject domains users legitimately own.
- **4c — the merchant seam.** `source` (`byo` | `registrar` | `manual`) and `externalRef`
  are on the row now, so the planned external domain merchant is a **sync**, not a
  rewrite. A registrant's zone is not in the user's Cloudflare account, which is the
  reason the table exists at all rather than pure live discovery.
- **4d — routes + UI** (NOT yet built): a user-facing `/api/hosting/domains` and the
  picker, plus the admin route that lets the owner add a domain for a user.

Bounded by the one unavoidable registrar action — but only on the 4b path.

**Phase 5 — Hosting restructure.** Dedicated **Domains** section; surface active zones
and the chosen host; per-capability health (`Pages 1/2 · Workers 1/2`) instead of one
"usable accounts" count.

**Phase 6 — Support tickets.** User + admin, threaded status, attachments of **zone
metadata only**. A hard lint rule forbids any Cloudflare token in a ticket body.

---

## 5. Risks

- **Cross-account custom domains** — the trap in §2.1. Guard: premium sites publish only
  to an account that actually holds the zone; otherwise dev-only, never a broken URL.
- **Cert issuance latency** — a fresh custom domain is `pending` for up to ~15 min.
  Surface the state; do not report success as live.
- **Token over-scope** — New Prod still sees `broks.beauty`. The reserved-zone guard is
  enforced before any DNS/script/route write and is not being weakened here.
- **~~Unverified `Zone:Edit`~~ — RESOLVED NEGATIVE (2026-10-03).** The probe ran live
  against all 3 accounts / 5 tokens: every one returns
  `403 com.cloudflare.api.account.zone.create`. **Automatic zone creation is not available.**
  Phase 4 is therefore split 4a/4b/4c (§4). This risk is **closed as a known constraint**,
  not as a defect — re-open only if the owner grants account-scoped Zone → Zone → Edit.
---

## 7.4 Zone-create permission probe — RAW FINDINGS (2026-10-03)

Run **read-only** on the VPS against the real `HostingPlatformAccount` rows, decrypting
with the production helper (`lib/mailbox-crypto.ts` `decryptSecretOrThrow`). **No token
value was ever printed.** Full method + cleanup in `TRIAGE_2026-10-03_HOSTING.md` §3.5 and
`SENIOR_HANDOFF.md` §7.2 / §12.

**VERDICT: no token can create a zone.** All 5 configured tokens across 3 accounts:
```
403  0: Requires permission "com.cloudflare.api.account.zone.create"
         to create zones for the selected account
```

| Account | CF acct id | Token | Zones readable | `POST /zones` |
|---|---|---|---|---|
| Primary cf | `4c822d3b…` | Pages `…fd99` | 0 | **403** |
| New Prod | `9bc97c44…` | Pages `…6939` | 0 | **403** |
| New Prod | `9bc97c44…` | Workers/DNS `…419f` | **3** | **403** |
| hosting Premium Links | `43b24dc0…` | Pages `…177b` | 0 | **403** |
| hosting Premium Links | `43b24dc0…` | Workers/DNS `…a5d7` | 0 | **403** |

The three readable zones (`New Prod` Workers/DNS token) are **`broks.beauty`,
`instaweb.top`, `mainaccess.top`** — all `active`.

**Why this was safe:** the probe posted an **invalid** domain name. Cloudflare checks the
account permission *before* validating the name, so it returned `403` on permission and
could not have claimed a domain — so **no throwaway domain on an owner-controlled domain was
ever needed**. Reusable: a probe whose input is invalid-by-construction answers a permission
question at zero risk; only a *positive* result needs a real domain to confirm.

**Findings that change other parts of this doc:**
- **A third account exists** — `hosting Premium Links` (`43b24dc0…`, §3b per-purpose pinning).
  It has **zero zones** ⇒ `workers.dev` links only, **never a custom domain**. Phase 3's
  "fall back to `go.<zone>`" has no zone to fall back to here.
- **`broks.beauty` is still readable by the `New Prod` Workers/DNS token** — the §2.2
  governance hole is unremediated and zone-create being blocked mitigates **nothing** for it.
  The reserved-host denylist stays mandatory, and 4a must never offer `broks.beauty`.