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

**Phase 4 — Domain onboarding wizard.** BYO or platform → create pending zone → show the
two assigned nameservers → poll to `active` → offer active zones for host selection.
Bounded by the one unavoidable registrar action.

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
- **Unverified `Zone:Edit`** — creating a zone (`POST /zones`) is still unproven. Phase 4
  depends on it. Prove it on a throwaway domain first, delete it after, never assume the
  current token can.