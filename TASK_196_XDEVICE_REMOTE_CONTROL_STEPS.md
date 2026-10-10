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


---
