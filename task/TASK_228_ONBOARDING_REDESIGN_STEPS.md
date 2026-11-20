# TASK_228 — Onboarding redesign (quarantine out, hide-only + manual move) — STEPS

**Status: IN PROGRESS** — senior verification agent building IN-HAND (owner directive
2026-10-19: "handle this while the other agent handles 227 so we can deploy together").

## BEFORE record (2026-10-19)

- SpaceWorker: branch `agent/task-228-onboarding-redesign` @ `c9aa516` (= origin/main),
  worktree `/Users/mikeolab/sw-t228`.
- Vantra: changes uncommitted in the shared tree `/Users/mikeolab/vantra`
  (currently on `agent/task-207-mesh-scoped-mint` @ 0f31097 — NOT stacked on it;
  the 2 files will be committed on their own branch off vantra main at ship time):
  `app/api/internal/sw/orgs/route.ts` (modified), new
  `app/api/internal/sw/devices/[agentId]/move/route.ts`.
- Suite floor at c9aa516: 1677 tests / 1676 pass / 0 fail / 1 skip; tsc 0.

## Triage evidence (why — owner: "a lot of devices have gone missing after getting on")

1. **The hide is innocent**: `buildHideAgentScript` only renames DisplayName +
   registry Description + uninstall entry; never stops/restarts the agent.
2. **The hide never even ran** on the stuck devices: `hideDoneAt = NULL` on every
   recent onboarding row (incl. the owner's live test device); every attempt bounced
   off `vantra_503: This device is currently offline` — and the OLD sweep burned an
   attempt per 503, killing rows red after 6.
3. **The killer is the auto-move**: Vantra's `moveAgentToSite` rewrites the agent's
   registry BaseURL/ApiURL to the private domain and force-restarts `tacticalrmm`.
   Offline mid-move ⇒ agent stranded in the private org forever.
4. Timeline proof on the owner's test device: install 11:59:55, last TRMM check-in
   12:03:50, agent dark ~4 min in — before hide@5/move@15 could ever fire.

## EMERGENCY BOX KILL (done, owner-ratified, BEFORE any code shipped)

All 11 Vantra orgs `sw-%`: `autoMoveToPrivateEnabled=false` (UPDATE 11 confirmed,
before/after listing captured). 10 pending DeviceAutoMove rows cancelled on the next
poller cycle via the disabled flag (`advanceDeviceAutoMove` cancels when flag off).

## Work completed (code, this worktree + vantra tree)

- [x] **A1 Vantra** new `app/api/internal/sw/devices/[agentId]/move/route.ts` —
  `verifySwSecret` + `assertAgentInSwOrg` (404 never 403), destination =
  `sw-<uid>-p` companion (mirrors device-auto-move.ts:77-89, never the shared
  service user's other private org), `moveDeviceToPrivate` then
  `cancelPendingAutoMoveForManualMove(agentId, sourceOrgId)`, D6 shape
  (200 {ok:true,moved} / 200 {ok:false,reason} / 401 / 404).
- [x] **A2 Vantra** `sw-orgs/route.ts` — removed the auto-move opt-in for new
  public orgs (default false stands).
- [x] **B1 SW** `lib/device-onboarding.ts` rewritten hide-only: `ONBOARDING_HIDE_AFTER_
  SECONDS=60`, `ONBOARDING_MAX_ATTEMPTS=10` (genuine failures only), `nextOnboarding-
  Action(row, now)` (null under 60s = quiet first minute), `onboardingRowLabel` →
  `{text, tone} | null` (released → null; failed → red "Hide failed"; due → amber
  "Hiding agent…" / "…retry N"). All quarantine exports removed.
- [x] **B2 SW** sweep route rewritten: sync-users-first (unchanged), freshness gate
  (`isDeviceOnline`) BEFORE claim, hide via `runCommandNow({userId, deviceId, cmd,
  shell:"powershell", timeoutSeconds:90, runAsUser:false})`, label from `row.hideLabel`,
  success → `status:"released" + hideDoneAt + releasedAt`, FAIL output or non-offline
  transport error → attempts++ (red at 10), `vantra_503|currently offline` → claim
  released, NO burn, NO lastError. Response `{ok, synced, syncErrors, checked, hid,
  released, failed, skippedOffline}`. Claim = old `hideDoneAt:null` exactly-once.
- [x] **B3 SW** `lib/device-tools.ts` +`moveAgentToPrivateOrg({userId, deviceId})`
  (requireOwnedDevice → vantraFetch POST …/move).
- [x] **B4 SW** new `app/api/devices/[deviceId]/move-to-private/route.ts` — session 401,
  deviceToolsDenied gate, `{id,userId}` 404 (no oracle), tier private → 409
  already_private, Vantra no_private_org → 409, other {ok:false} → 502, success →
  best-effort `syncDevices` + `{ok:true}`.
- [x] **B5 SW** `components/device-console.tsx` — OnboardingCard + render block + the
  lib imports removed; the hideLabel prefill (L1237) untouched.
- [x] **B6 SW (partial)** `components/device-list.tsx` — imports reduced to
  `onboardingRowLabel`; `attempts` added to the DeviceRow onboarding type; strip +
  failures + stuck memos and ALL their render blocks deleted; row badge rewritten for
  the new label shape (ISO→Date conversion client-side); public-first stable sort in
  the `visible` memo (owner: "make public device appear on top").

## Remaining (in order)

- [x] **B6c** Move-to-private button on public rows (`movingId` state, themed confirm
  via useConfirm, `load()` on success, ShieldCheck icon at right-10 so it never
  overlaps Remove at right-2; placed inside the row's action container, OUTSIDE the
  row `<Link>`; TriangleAlert import dropped as now-unused).
- [x] **B6d** Copy fixed — "stay public until you move them to private" (link panel)
  and "then stay public until you move them to private" (copy snippet); no more
  "silently move" language anywhere.
- [x] **B7** Straggler grep clean — removed exports referenced ONLY by the old test
  file; app/components/lib zero hits.
- [x] **B8** tests rewritten: `tests/device-onboarding.test.ts` 13 tests (3 rule +
  10 sweep incl. the THE-503-BUG regression, offline-no-burn, claim race via
  updateMany-count-0 override, sync-first with one broken link, hideLabel-name
  regression). Dead `tests/xdevice-onboarding-display.test.ts` deleted (tested
  quarantine helpers that no longer exist). NEW files: the sweep's 503 path now
  also restores `status:"pending"` (was left stuck on "hiding"); genuine transport
  errors stored as `STEP:transport_error: <msg>` (old sweep's greppable format);
  worktree needed a `node_modules` symlink to the primary tree (gitignored).

### Fixes discovered BY the new tests (record for the record)

1. 503/offline path released the claim but left `status:"hiding"` — badge would
   have sat on "Hiding agent…" all night. Now restores `pending`.
2. `errorDetail` stored raw messages — added the `STEP:transport_error:` prefix so
   the failure class stays greppable in the DB/UI like the old sweep.
- [ ] B9 gates: tsc, eslint touched files, full `npm test`, `CI=true npm run build`
  (SW worktree); tsc + tests on the Vantra tree.
- [ ] Commit SW branch; commit Vantra 2 files on their own branch off vantra main.
- [ ] Merge SW to main, push, dispatch CI after owner 🚦 GO; box steps at deploy:
  `device-onboarding-sweep.timer` 5min → **1min**, verify sweep journal; Vantra's 2
  files need the Vantra deploy path (cross-repo — confirm with owner).
- [ ] Post-deploy: fresh install — hide at 60–120s, badge gone after release, device
  stays public, Move button moves (agent survives); DB: no rows in
  `moving`/`staying_on`, auto-move rows all `cancelled|completed`.


## DEPLOYED & VERIFIED — 2026-10-19 (senior verification agent, owner GO given)
**SW side:** merged (c0b56f2), merged-tree gates tsc 0 · lint 0 · suite 1642/1641 pass/0 fail/1 skip · build ✓. Dispatch run 39138493191 — BUILD_ID FzRmVYbdp4To16F2NjDaT → DavUl7Z8N2p9pbivrx4zw, fresh PID, services active, public 200, zero -p err. On-box proof: move-to-private + stall-info route dirs present; sweep v2 markers hide_script_fail + STEP:transport_error in deployed chunk _1jjh660._.js; anon POST move-to-private → 401; regression pin: install-link DELETE still 401.
**Vantra side:** branch agent/task-228-vantra-move merged to vantra main (edc71ec..9482891) + dispatch run 39138149563 → BUILD_ID JiHmYVEgGEJyrBLNEe7-2 → 1s5EIPdtVRUoKqzQjVuGX. Move route dir present under internal/sw/devices/[agentId]/move/; no_private_org string in deployed chunk. Existing-orgs autoMoveToPrivateEnabled=0 UPDATE already applied box-side 2026-10-19.
**Timer tightened (owner ask "first/second minute"):** /etc/systemd/system/device-onboarding-sweep.timer OnUnitActiveSec 5min → 1min (backup .timer.pre-t228 kept). The old 5-min rationale was the retired quarantine's stage quantisation — void under hide-only. Worst-case hide latency now ~2 min (60s timer + 60s min-age); the device must be genuinely online at the tick or it is skipped with no burn.
**Live-data note:** device "I" (the owner's repro) sits pending/attempts=2 from the OLD code; v2 retries it cleanly on a tick where it is fresh, with no error spam either way.
