# TASK_131 — Self-hosted Phase 3: sw-rmm-core extraction

**Status: OPEN. Assigned to Cline.** This is Phase 3 of
`/Users/mikeolab/.claude/plans/transient-moseying-tome.md` — extracting
Vantra's `app/api/internal/sw/**` device-check-in surface into its own
standalone service.

**This task lives in a DIFFERENT repo, not spaceworker.** New private repo:
`https://github.com/softdeployautomation-sketch/sw-rmm-core`, already cloned
locally at `/Users/mikeolab/sw-rmm-core` on `main`. Work there directly (it's
small enough not to need a worktree pattern yet — check with the user before
force-pushing or rewriting history, same as any repo). This SpaceWorker repo
file just tracks the task for continuity with TASK_129/130's numbering; there
is nothing to change in `spaceworker` itself for this task.

## What's already built (commit `cd6f936` on `sw-rmm-core`'s `main`)

Read `sw-rmm-core/README.md` first — it documents what's deliberately NOT
ported and why. Already done:

- `prisma/schema.prisma` — the 8-model slim (`Organization`, `Deployment`,
  `DeviceGroup`+`DeviceGroupMember`, `DeviceStatusSnapshot`,
  `QueuedAgentCommand`, `DeviceAutoMove`, `DeviceLabel`,
  `DeviceCredentialRequest`+`DeviceCredential`+`DeviceCredentialAuditLog`).
  **This is the ground truth for every field name below** — every "opaque
  reference, no FK" field is named `ownerRef` / `actorRef` / `requestedByRef`
  (never the original `ownerId`/`actorUserId`/`requestedByUserId`, and never
  a `User` relation — there is no `User` model in this schema at all).
- `lib/sw-internal-auth.ts`, `lib/db.ts`, `lib/env.ts` — service plumbing.
- `lib/sw-org-naming.ts`, `lib/provision.ts` — ported org-provisioning,
  already stripped of Vantra's `ensureServiceUser()` and
  `PRIVATE_ORG_EXEMPT_EMAILS`/`ensureExemptPrivateOrg()` (the Phase 0
  finding — Vantra's own owner-account allowlist, never port this).
- `app/api/internal/sw/orgs/route.ts` — one fully ported exemplar. **Read
  this file closely before porting anything else** — it's the pattern every
  other route follows.

## What you're porting (source: `/Users/mikeolab/vantra`)

### Supporting libs (port before the routes that need them)

| File | Size | Notes |
|---|---|---|
| `lib/trmm.ts` | 1056 lines | TRMM API client. Port as-is — no Vantra-specific coupling expected, but audit imports as you go (same discipline as Phase 0's audit — if you find one, strip it and note it in your handoff, don't silently drop functionality). Uses `TRMM_API_BASE_URL`/`TRMM_API_KEY` (already in `lib/env.ts`, matching names — don't rename). |
| `lib/meshcentral-api.ts` | 389 lines | MeshCentral control-channel API. Port as-is. |
| `lib/agent-domains.ts` | 86 lines | Reads `Organization.agentDomainTier`/`agentApiHosts` — already on the slimmed schema, should port cleanly. |
| `lib/sw-agent-tenant.ts` | small | Imports `isSwOrgName`/`SW_ORG_PREFIX` from Vantra's `lib/spaceworker-service.ts` — repoint that import to sw-rmm-core's `lib/sw-org-naming.ts` (same export names, just relocated per the exemplar's own comment). |
| `lib/installer-download-host.ts` | 75 lines | Audit for Vantra-only coupling (installer download hosting — check whether it references any Vantra-only concept before porting verbatim). |
| `lib/zip-generator.ts` | 187 lines | Same audit-then-port. |
| `lib/generation-queue.ts` | 61 lines | Same audit-then-port. |
| `lib/sw-installer-names.ts` | 189 lines | Same audit-then-port. |

### The remaining 16 route files

All under `app/api/internal/sw/**` in Vantra — port each into the identical
path under sw-rmm-core, following `orgs/route.ts`'s established conventions:

```
app/api/internal/sw/orgs/[orgId]/install-link/route.ts
app/api/internal/sw/devices/route.ts
app/api/internal/sw/devices/idle/route.ts
app/api/internal/sw/devices/[agentId]/action/route.ts
app/api/internal/sw/devices/[agentId]/idle/route.ts
app/api/internal/sw/devices/[agentId]/maintenance/route.ts
app/api/internal/sw/devices/[agentId]/mesh-urls/route.ts
app/api/internal/sw/devices/[agentId]/pin-request/route.ts
app/api/internal/sw/devices/[agentId]/queued-commands/route.ts
app/api/internal/sw/devices/[agentId]/relay/health/route.ts
app/api/internal/sw/devices/[agentId]/relay/install/route.ts
app/api/internal/sw/devices/[agentId]/clone/capture/route.ts
app/api/internal/sw/devices/[agentId]/clone/launch/route.ts
app/api/internal/sw/devices/[agentId]/clone/receive/route.ts
app/api/internal/sw/devices/[agentId]/clone/revoke/route.ts
app/api/internal/sw/devices/[agentId]/clone/status/route.ts
```

**`orgs/[orgId]/install-link/route.ts` needs extra care**: Phase 0's audit
found it pulls in 5 libs not originally in the plan's file list (all listed
in the table above — `agent-domains.ts`, `installer-download-host.ts`,
`zip-generator.ts`, `generation-queue.ts`, `sw-installer-names.ts`). Port
those first, then this route.

## Conventions to follow on every port (from the exemplar + schema)

1. **No `User` model, ever.** Any field that was a real `User` relation in
   Vantra (`actorUserId`/`actorUser`, `requestedByUserId`/`requestedByUser`,
   etc.) is now a plain string column already renamed on the schema
   (`actorRef`, `requestedByRef`, ...) — just pass the id through, don't add
   a relation, don't look it up.
2. **`logApiError` doesn't exist here.** Vantra's admin "Errors" tab
   infrastructure isn't part of the 8-model extraction — drop those calls
   (the exemplar route already shows this: `console.error` only, no
   `logApiError`). If a route's error handling leans heavily on it for real
   behavior (not just logging), flag it rather than silently changing
   behavior — but for every route audited so far it's been logging-only.
3. **Anything else Vantra-only you find while porting** (billing checks,
   ticket references, its own admin/session concepts) — strip it and note
   what you stripped in your final report, the same way Phase 0's audit
   surfaced `provision.ts`'s owner-exempt logic. Don't guess at a
   replacement; if a route's core behavior seems to depend on something
   Vantra-only in a way that isn't obviously safe to drop, stop and ask
   rather than inventing a workaround.
4. **Zero changes needed on the SpaceWorker side.** `lib/vantra-link.ts`,
   `lib/device-tools.ts`, `lib/clone-transport.ts` already call
   `${env.vantraInternalUrl}/api/internal/sw/...` with a bearer token — as
   long as sw-rmm-core's routes live at the same paths and accept the same
   bearer scheme (`verifySwSecret`, already ported), SpaceWorker doesn't
   need to know this is a different codebase at all.

## Verification

- `npm install` in `/Users/mikeolab/sw-rmm-core`, then `npx prisma generate`,
  `npx tsc --noEmit`, `npx eslint .` — all clean.
- A real local Postgres (own DB, never SpaceWorker's/Vantra's — see
  README) + `npx prisma migrate dev` for the initial migration.
- Manual smoke test against a **real TRMM test instance** (check with the
  user for one, or Vantra's own dev/staging TRMM if one exists) — at minimum:
  `POST /api/internal/sw/orgs` creates a real TRMM Client+Site (the exemplar
  route's full path, unchanged from Vantra's).
- **Exit-code warning** (this project's standing lesson): never check a
  command's exit code through a pipe ending in `tail`/`head`/`grep` — that
  reports the pipe's last stage, not the command you're checking. Redirect
  to a file and check `$?` directly.
- Commit directly to `sw-rmm-core`'s `main` (small repo, no branch
  discipline needed yet — check with the user before that changes).

## Deferred / out of scope for this task

- Phase 4 (the actual "SpaceWorker RMM Engine" Tauri app, WSL2 orchestration,
  the install-automation script) — separate task, hard dependency on this
  one finishing first.
- Any admin UI for sw-rmm-core itself — it's server-to-server only,
  reachable exclusively via SpaceWorker's own admin panel (Infrastructure
  tab, per TASK_130's wizard) — no standalone admin surface planned.
