# TASK 102 — AGENT HOST FLIP: instaweb = ONLY public, broks = private, retire agent.spaceworker

> Reference: HOW_WE_MOVE_FAST.md (deploy playbook §2, gotchas §6) · PLAN per-org model = vantra/TASK_82 · private tier = vantra/TASK_61

**Status: PHASE 1 DONE (code+DB flip live) — PHASE 2/3 pending on WilkSF9 coming online. DO NOT CLOSE.**

## Owner decision (2026-09-23)
instaweb.top becomes the ONLY public agent family; broks.beauty moves to the
PRIVATE tier; `agent.spaceworker.top` / `api.spaceworker.top` retired. Reason:
spaceworker.top is a public site — a hit on it must not expose the private
agent path, so private gets a domain with no public web surface.

## Safety sequence (owner-set — do NOT reorder)
1. ✅ **Phase 1 — code+DB flip** (commit `66addf9`, deployed + verified):
   - `agent-domains.ts`: public set = instaweb only; broks commented (audit trail)
   - New orgs default `agent.instaweb.top`; migration backfilled all PUBLIC orgs' allowlists
   - Download host: dl.instaweb.top for BOTH tiers (generator default); legacy broks-family Deployment rows keep dl.broks mapping
   - `rewriteInstallerDownloadUrl` → no-op (post-flip correct behavior)
   - Private tier resolution still env-driven → **unchanged so far**
2. ⬜ **Phase 2 — Wilk to public:** when WilkSF9 is ONLINE, registry-rewrite its
   BaseURL to `https://agent.instaweb.top` (same flow as the 2026-09-21 api.spaceworker
   migration), restart agent, VERIFY check-ins hit agent.instaweb.top (vhost
   access log) and device is Online in TRMM/SpaceWorker.
3. ⬜ **Phase 3 — env flip:** `/opt/vantra/.env` `TRMM_PRIVATE_API_BASE_URL=https://agent.broks.beauty`
   (backup first), restart vantra.service, verify private orgs (Sc01t,
   Thegreenerland) resolve to broks and private agents still check in.
4. ⬜ **Phase 4 — retire agent.spaceworker:** sweep access logs for any client
   still hitting agent.spaceworker.top / api.spaceworker.top → when zero
   (except migrated Wilk, already moved), remove vhosts + DNS records, verify
   all device check-ins unaffected.

## Standing safety notes
- ALL agent vhosts (agent.broks, agent.instaweb, api.spaceworker) front the SAME
  TRMM backend — devices never lose identity during the transition.
- `agent.broks.beauty` vhost ALREADY serves TRMM, so Phase 3 is pure relabeling.
- Post-flip verification matrix: public org ZIP mints dl.instaweb + agent.instaweb
  URLs; private org 403s self-service; admin panel host picker shows instaweb only.
