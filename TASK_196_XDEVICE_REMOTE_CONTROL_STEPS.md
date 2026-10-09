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

---
