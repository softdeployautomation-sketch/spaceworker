# TASK 102 — AGENT HOST FLIP: instaweb = ONLY public, broks = private, retire agent.spaceworker

> Reference: HOW_WE_MOVE_FAST.md (deploy playbook §2, gotchas §6) · PLAN per-org model = vantra/TASK_82 · private tier = vantra/TASK_61

**Status: PHASES 1–3 DONE (code+DB flip, Wilk re-parented, hosts flipped live) — PHASE 4 (retire agent.spaceworker) pending Wilk registry move. DO NOT CLOSE.**

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
2. ✅ **Phase 2 — Wilk into the SpaceWorker private org** (SUPERSEDED the registry-rewrite
   plan — no reconfigure was needed at all). TRMM derives `Agent.client` from
   `Agent.site` (`@property`, agents/models.py), so the move was a single
   `PUT /agents/<id>/ {"site": 144}` → Wilk re-parented to the `sw-…-p` org,
   **online throughout, no restart, no reinstall**. Verified in TRMM + SpaceWorker.
   The agent's check-in host is unchanged by this and is still
   `api.spaceworker.top` — see Phase 4.
3. ✅ **Phase 3 — env flip (live):** `/opt/vantra/.env` now
   `TRMM_PRIVATE_API_BASE_URL=https://agent.broks.beauty` and
   `TRMM_PUBLIC_API_BASE_URL=https://agent.instaweb.top` (backup
   `/root/vantra.env.bak-t102p3-*`), vantra rebuilt + restarted. Live proof:
   private org → `agent.broks.beauty` (PowerShell command, no download URL);
   public org → `agent.instaweb.top` (deploy URL). Both directions checked for
   cross-leaks. Also closed a **latent leak**: the live env had been *inverted*
   (broks as public), and the resolver's fallback for an unknown host reads
   `TRMM_PUBLIC_API_BASE_URL` — so a fallback path could have baked the private
   host into a public installer.
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

## Execution log — Phases 2–3 + silent private installer (2026-09-23)

### Phase 2 — Wilk moved into the SpaceWorker private org (NO reconfigure, NO reinstall)
The old "PS command that duplicates the agent" idea was **abandoned**: the TRMM
agent's service name (`tacticalrmm`), install dir (`Program Files\TacticalAgent`)
and registry key are **hardcoded constants** in `agent.go` — there is no flag to
run a second instance, so a "duplicate install" would silently clobber the
existing one. Also, the agent never resolves its client at runtime — it caches
client/site/API in its config and reports itself at check-in — so reinstalling
was never required.

**The actual move is one API call.** `Agent.client` is a *property*, not a
column:

```python
@property
def client(self):        # agents/models.py
    return self.site.client
```

So a device's client is determined by its **site**, and `PUT /agents/<id>/ {"site": N}`
re-parents it. Moving Wilk therefore needed: no restart, no config edit, no
PowerShell, **no dropped channel**.

| Step | Result |
|---|---|
| Dry run (`/root/t102-move.py`) | Wilk = site 3 / client 3 → target site **144** / client 43; rollback site id recorded |
| Apply | `PUT /agents/<id>/ {"site": 144}` → "The agent was updated successfully" |
| Verified | `site 144`, `client vantra-…-cmue394ot…` (the `sw-…-p` private org), **status online**, last_seen current |
| Seen in SpaceWorker | ✅ owner confirmed the device appears |

`client` is **read-only** in `AgentSerializer` (line 45) and everything else is
derived from `site`, so the whole move is the single writable FK.

### Phase 3 — private host flipped to broks, public to instaweb
`/opt/vantra/.env` (backup: `/root/vantra.env.bak-t102p3-*`):

| Var | Before | After |
|---|---|---|
| `TRMM_PUBLIC_API_BASE_URL` | `https://agent.broks.beauty` ← **stale/wrong** | `https://agent.instaweb.top` |
| `TRMM_PRIVATE_API_BASE_URL` | `https://api.instaweb.top` ← **stale/wrong** | `https://agent.broks.beauty` |

⚠️ **Caught a latent private-host leak:** the live env was *inverted* (broks =
public, instaweb = private) — inconsistent with the Task-82 code (public
allowlist = instaweb only). `resolveAgentApiBaseUrlForHost` **falls back to
`TRMM_PUBLIC_API_BASE_URL`** for an unrecognised host, so any fallback path
would have baked the *private* host into a *public* installer. Setting both
vars to the flipped values closes it.

### Silent private installer (owner directive)
The private command now rides the **same Tactical RMM + agent flow** as TRMM's
own `installer.ps1`, but with **no visible UI**. `toPowerShellInstallCommand`
(`vantra/lib/trmm.ts`) previously emitted a noisy two-step chain (`Invoke-WebRequest`
progress bar, installer splash, reboot prompt, and a visible console from the
configure step). Now:

| Was | Now |
|---|---|
| `Invoke-WebRequest` (progress bar) | `$ProgressPreference='SilentlyContinue'` + `-UseBasicParsing` |
| `/VERYSILENT /SUPPRESSMSGBOXES` | `+ /NORESTART /SP-` (no reboot prompt, no "are you sure") |
| blind `Start-Sleep 7` | polls for the installed exe (30 × 1 s) — cannot race the extractor |
| `& "<agent>" <args>` (visible console) | `Start-Process -WindowStyle Hidden -Wait` |
| — | TLS 1.2 forced; temp installer cleaned up |

Live-verified end to end through Vantra's own internal route:

```
private → tier=private  host=agent.broks.beauty  downloadUrl=absent
          cmd: -m install --api https://agent.broks.beauty --client-id 43
               --site-id 144 --auth <token> --rdp --ping --power
          (silent flags + hidden configure present, no instaweb/spaceworker leak)
public  → tier=public   host=agent.instaweb.top
          downloadUrl=https://agent.instaweb.top/clients/…/deploy/
          (no broks / spaceworker leak)
```

### Still open
1. ⬜ **Phase 4 — retire `agent.spaceworker.top` / `api.spaceworker.top`.**
   **Note: Wilk still checks in via `api.spaceworker.top`** (its registry BaseURL
   was set during the 2026-09-21 migration; the env flip does not touch an
   existing agent's local config). It must be registry-rewritten to
   `https://agent.broks.beauty` — or the vhost kept — **before** Phase 4 removes
   anything, or the device loses its check-in host.
2. ⬜ Optional: verify the silent command on a real Windows device (the flags are
   verified structurally + against TRMM's own script; the UI behaviour is
   reasoned from Inno/Start-Process semantics, not yet observed).

