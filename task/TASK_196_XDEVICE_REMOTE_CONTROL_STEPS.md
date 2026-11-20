# TASK_196 — XDEVICE REMOTE-CONTROL BLOCKED (hotfix)

**Started:** 2026-10-09 21:09 (owner interrupt, priority over TASK_195 S1)
Owner: "the xdevice tier … they are getting blocked from remote control. it
shows disconnect even when the device is online, but it works on premium plus."

## CHAIN MAP (traced this session, all reads verified)
User console `connect()` (device-console.tsx:843) →
`GET /api/devices/[deviceId]/mesh-urls` → session →
`deviceToolsDenied(userId)` (lib/device-gate.ts) →
`canUseDeviceTools` → `hasEntitlement` — **tier 3 live → allowed "xdevice"**
(entitlements.ts:74 — gate itself is sound, unchanged since TASK_181) →
`fetchMeshUrls` (lib/device-tools.ts:144) → `requireOwnedDevice`
(device must have `vantraAgentId`) → `vantraFetch GET Vantra
/api/internal/sw/devices/{agentId}/mesh-urls` → Vantra route:
`verifySwSecret` → **`assertAgentInSwOrg(agentId)` → 404 "Device not found."
if the agent is not in an sw- org** → `getMeshCentralUrls(agentId)` →
503 "device offline" via `isAgentUnreachableError`.

## ELIMINATED (with proof)
- TASK_191 entitlements edit = export-only (`git show 65c12ca` — comment +
  `export` keyword, zero logic change).
- TASK_191 devices-route edit only nulls `onboarding` — payload shape
  unchanged; console polls the same route for status (no status effect).
- UI lock path would show the ToolLockCard ("Upgrade to Premium XDevice"),
  NOT "disconnect" — so a tier-3 entitlement denial does not match the
  reported symptom either.

## OPEN LEADS (next actions)
1. Box logs: `journalctl -u vantra.service | grep -i 'mesh-urls'` — the real
   error from the failing users; same for spaceworker.service.
2. Vantra `assertAgentInSwOrg` (local repo /Users/mikeolab/vantra): what counts
   as an sw- org — is the PUBLIC org (where every XDevice agent lives) in it?
   Prime suspect: public-org agents failing the tenant guard or
   `getMeshCentralUrls` → the tier-3-specific break.
3. Live repro on the box with a minted tier-3 session (same technique as
   TASK_194 S3 probe): GET /api/devices → pick device → GET mesh-urls →
   capture the exact error; compare with a premium+ account.

## RULES
Read-only investigation; no deploy until root cause is proven and owner's
green. Every step recorded here before/after. TASK_195 S1 stays paused
(WIP uncommitted, see TASK_195_STEPS.md).

## 2026-10-09 21:16 — LIVE PROBE ON BOX (read-only, real session JWTs)

Ran `/tmp/t196-probe.ts` on the box (minted real `spaceworker_session` JWTs,
same issuer/audience/shape as lib/auth.ts; READ-ONLY):

- Box users: tier0×7 tier1×5 **tier3×2** tier5×6.
- **XDEVICE tier-3 (live term to 2026-11-07, device "Sc")**:
  - `GET /api/devices` → **200**, 1 device, `onboarding=null` (TASK_191 suppression working),
    status **offline** (lastSeen 2026-10-09T13:22Z).
  - `GET /api/devices/{id}/mesh-urls` → **200** with fully-minted mesh URLs.
- PREMIUM tier-5 (live term, device "I", offline since 09-26):
  `GET mesh-urls` → **200** with URLs (so mesh-urls does NOT require online).

**CONCLUSION: the spaceworker chain (entitlement gate → device ownership →
Vantra tenant guard → mesh mint) WORKS for tier-3.** The reported "disconnect"
is therefore NOT the xdevice_required gate. Remaining hypotheses, in order:
- **H1** TRMM/MeshCentral-side state for the specific failing agent (stale mesh
  node after the VBS uninstall/reinstall saga → viewer lands on a dead node and
  shows "disconnected" while the agent heartbeat is alive in spaceworker).
- **H2** the spaceworker device status is fresher/staler than TRMM's view
  (sweep skew) → viewer opens against an agent TRMM considers offline.
- **H3** a client-side path specific to the failing account (needs the exact
  screenshot/string from owner — "disconnect" is not a literal spaceworker
  string; nearest = MeshCentral's own viewer states).

Next: query TRMM directly (via vantra's env) for the tier-3 agent's mesh node
status vs spaceworker's lastSeenAt; ask owner for the failing account/device +
a screenshot if TRMM state looks coherent.


## 2026-10-10 — PROBE 2 + PROBE 3 (TRMM view; same-instant table) + sync-trace

**Probe 2** (TRMM direct): tier-3 "Sc" agents — TRMM detail OK, mesh_node_id present,
last_seen == sw lastSeenAt EXACTLY; meshcentral endpoint → **overdue**. Only
online agent system-wide: tier-5 CSFD-CHECKOUT (meshcentral **online**).

**Probe 3** (same-instant, every device of tier-3+5, real user sessions):
- `GET /api/devices` → 200 for every user; **mesh-urls → 200 for EVERY device
  on both tiers** (8/8 devices, both tier-3 accounts included).
- SW status mirrors TRMM status exactly (offline⇔overdue, online⇔online).
  No SW-online/TRMM-offline divergence AT THIS INSTANT.
- All tier-3 devices currently genuinely stale (checkins since 10-09 13:22 /
  20:05) — the owner's test machine was NOT online during these probes.
- Notable: BOTH tier-3 "Sc" agents share public IP 105.112.30.28 (same
  physical machine enrolled to two accounts) — hostname "Sc" also exists in
  tier-5 (different IP) → name-only node matching is unsafe for probe 4.

**Sync-trace (code)**: `Device.status/lastSeenAt` are written ONLY by the
vantra-link device sync (lib/vantra-link.ts:1321-1339, mirroring Vantra's
`online`/`lastSeen` = TRMM checkins). There is NO independent spaceworker
heartbeat → a SW "online" and TRMM "offline" can only diverge inside the
5-min sync lag, or if TRMM checkins are alive while the agent's MESH session
is dead (checkin path and mesh path are independent links of the same agent).

**"disconnect" string**: zero hits in our UI. The console's control tab
embeds MeshCentral's own page in an iframe (`src={mesh.control}`) — the
disconnect verdict the owner sees is **MeshCentral's node state**, not ours.

## NEXT (probe 4): MeshCentral live node table

Query the mesh control channel ({"action":"nodes"}) as MESH_LOGIN_USER —
print every node's name/ip/conn/idletime → check whether the tier-3 nodes
are `conn`-alive in MeshCentral while TRMM reports overdue (that would pin
the bug to the mesh link), then arm a 60s divergence watcher so the owner's
next ON-session captures the SW-vs-mesh state at the same instant.


---
## 2026-10-10 — PROBE 4 (MeshCentral live node table) + watcher armed

Ran vantra's exact control-channel token (`{"action":"nodes"}` as
MESH_LOGIN_USER, standalone copy of makeLoginToken). 9 nodes total:

- **CSFD-CHECKOUT (tier-5, online): the ONLY node with `conn=1`** — agent
  mesh session active.
- EVERY other node — both tier-3 "Sc" nodes (both ip 105.112.30.28 = ONE
  physical machine enrolled to two tier-3 accounts) and every other tier-5
  node — has **no `conn` field = no active mesh session**. Last-known
  idletimes present (stale values from before disconnect).

**Verdict so far**: MeshCentral, TRMM and spaceworker all AGREE at every
layer, for every tier, at every instant sampled: tier is NOT discriminating
anywhere in the chain. The only remotely-online agent system-wide is the
tier-5 CSFD one; the owner's tier-3 test machine (105.112.30.28) has been
OFFLINE the whole observation window — so the reported state could not be
reproduced on demand.

**Leading hypothesis (H4, fits every fact)**: a partial/interrupted agent
install — the VBS uninstall/reinstall saga interrupted installs can leave an
agent whose TRMM checkin works but whose meshagent session does not come up.
Then: SW chip green (checkins fresh) + MeshCentral node dead → the iframe
shows "disconnect". Premium Plus "works" because that account's install is
the older clean one. Note the same physical VM is registered under TWO
tier-3 accounts + one tier-5 account (three Sc rows!) — re-registrations
never cleaned the previous agents' TRMM rows.

**Watcher armed** (`/opt/spaceworker/t196-watch.ts`, 60s polls, 24h,
log /tmp/t196-watch.log): logs a `*** DIVERGENCE ***` line the moment a
tier-3 agent has fresh checkins (SW would show online) while its mesh view
is NOT online — capturing the owner's exact bug state with server-side
evidence whenever their machine is next on.


