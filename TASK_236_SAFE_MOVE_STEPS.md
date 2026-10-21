# TASK_236 — safe "Move to private" (install → verify → user-deletes)

**Owner-approved scope:** the safe move. The public Mesh device must stay ONLINE the whole
time; the private Tactical agent is installed and verified; ONLY the user deletes the public
device, and only after the private copy is verified. Wilk must not be deleted. Tactical and
Mesh are independent agents — enrolling Tactical does NOT replace Mesh.

**Incident this fixes:** Device I (2026-10-20) went dark — the public device disappeared from
the console while the private enrollment never appeared, leaving nothing to recover from.

---

## Branches / commits

| Repo | Branch | Commit | Base |
|---|---|---|---|
| vantra | `agent/task-236-move-safe` | `a0bc137` (2 commits: `5d5504c` + `a0bc137`) | `f98abae` (origin/main) |
| spaceworker (sw-vbsfix) | `agent/task-236-move-safe` | `fcde2e0` | `2fdd967` (origin/main) |

Both branches are pushed, **merged into `main`, and DEPLOYED** (2026-10-21, owner GO) — see the
"AFTER — DEPLOYED" section at the end of this file for the runs, BUILD_IDs and post-deploy proof.

---

## What changed

### Vantra (`/Users/mikeolab/vantra`)

- **`lib/trmm-move.ts` (NEW)** — the MOVEMENT command builder, in its own module (no
  `server-only`, no env, no imports) so it is directly unit-testable.
  - Idempotent: `Get-Service TacticalRMM` guard → a re-run is a no-op.
  - Tactical-only. No mesh code, no delete, no uninstall, no service removal anywhere.
  - Single-line variant (`; `-joined) — relay-safe (the mesh terminal relay fragments a
    multiline paste; live-proven 2026-10-20). No path variables are assigned — every path
    is inlined, and the service status is read inline (no `$svc =`).
  - Ends with an **audible verdict** tied to the service actually `Running`. A silent
    "installed" with a dead service is exactly what ate Device I.
- **`lib/trmm.ts`** — `createManualInstaller` mints the movement variant from the SAME
  deployment creds (zero extra TRMM calls) when `moveVariant: true`; re-exported for the
  existing import sites. TRMM rows are byte-unchanged.
- **`app/api/internal/sw/devices/[agentId]/move/route.ts`** — mesh rows (`node//`) get the
  movement variant and are marked `install.moved = true`; TRMM rows keep the normal installer.
- **`app/api/internal/sw/devices/[agentId]/move/verify/route.ts`** — **MESH branch added.**
  Mesh-only rows have no TRMM record, so the old path died as "Device not found" and *no public
  device could ever verify*. The source org now resolves from the public group, and the
  hostname comes from the mesh node itself. Read-only: never deletes, never reboots, never
  reconfigures.
- **`app/api/internal/sw/devices/[agentId]/move/remove/route.ts`** — **UNCHANGED**, and still
  server-enforced: verify re-runs before the delete, and the refusal (`not_verified_install_first`)
  precedes the delete call. Nothing automatic calls this route.
- **`tests/task-236-safe-move.test.ts` (NEW, 12 pins)** — one-line/relay-safe · no mesh
  reference · no deletion/uninstall · idempotency · audible verdict · no automatic removal
  path · remove-after-verify ordering · verify is read-only · movement variant minted only
  for mesh rows.

### SpaceWorker (`/Users/mikeolab/sw-vbsfix`)

- **`lib/device-tools.ts`** — `verifyMoveToPrivate()` asks Vantra's `/move/verify` (read-only)
  through the same `requireOwnedDevice` gate as every other tool. `install.moved?: boolean`
  added to `MoveToPrivateResult`.
- **`app/api/devices/[deviceId]/move-to-private/verify/route.ts` (NEW)** — the read-only verify
  endpoint. Session-gated, `deviceToolsDenied`-gated, ownership-gated. **It has no removal
  path at all.**
- **`components/device-list.tsx`** — the Move panel gains a "Check private copy" button and a
  truthful status line:
  - not yet → *"Private copy not seen yet. The public agent is untouched and still online."*
  - verified → *"…You can now delete the public row yourself — nothing was deleted for you."*
  The panel copy no longer says the public row is deleted for the user.
- **`tests/task-236-safe-move.test.ts` (NEW, 8 pins)** — no removal route is reachable · verify
  is read-only · the panel offers the check · the unverified message keeps the public device.
- **`tests/task-234-move-capture.test.ts`** — the panel pin now matches the
  `setMoveInstruction` **fields** (it grew the verify state) instead of one literal line.

---

## Safety properties (all pinned by tests)

1. The generated command never touches Mesh — the public row stays online throughout.
2. No automatic path anywhere calls the remove route. `grep` for `move/remove` returns only
   the route's own file and a test.
3. Removal is refused server-side until the private org has an agent matching the old
   record's hostname.
4. A failed verification is **harmless**: the public record is exactly where it was, and the
   device is still online.

---

## Gates (verbatim)

**Vantra** (`/Users/mikeolab/vantra`)
- `npx tsc --noEmit` → exit **0**
- `npx eslint lib/trmm.ts lib/trmm-move.ts tests/task-236-safe-move.test.ts 'app/.../move/route.ts'` → **0** problems
- `npx tsx --test tests/*.test.ts` → **168 tests, 168 pass, 0 fail, 0 skipped**
- `npx tsx --test tests/task-236-safe-move.test.ts` → **12/12**

**SpaceWorker** (`/Users/mikeolab/sw-vbsfix`)
- `npx tsc --noEmit` → exit **0**
- `npx eslint` on all four changed files → **0** problems
- `npx tsx --test tests/*.test.ts` → **1705 tests, 1704 pass, 0 fail, 1 skipped** (the one
  DB-gated skip is the pre-existing baseline)
- `npx tsx --test tests/task-236-safe-move.test.ts` → **8/8**

**Secret scan** on both diffs → no matches.

---

## Deploy file list (for the senior lane)

### Vantra — rsync to `/opt/vantra/`
```
lib/trmm-move.ts
lib/trmm.ts
app/api/internal/sw/devices/[agentId]/move/route.ts
app/api/internal/sw/devices/[agentId]/move/verify/route.ts
```
(Import closure checked: `lib/trmm.ts` → `lib/trmm-move.ts` — both in the list. `move/route.ts`
imports `createManualInstaller` from `lib/trmm.ts` — in the list. `move/verify/route.ts` adds
`lib/meshcentral-api`, `lib/mesh-standalone-install`, `lib/spaceworker-service` — all
ALREADY deployed, unchanged by this task. `lib/sw-agent-tenant`, `lib/sw-internal-auth`,
`lib/trmm` — unchanged.)

### SpaceWorker — rsync to `/opt/spaceworker/app/`
```
lib/device-tools.ts
components/device-list.tsx
app/api/devices/[deviceId]/move-to-private/verify/route.ts
```
(`app/api/devices/[deviceId]/move-to-private/route.ts` is UNCHANGED by this task — it was
edited during the task and then reverted to its committed shape; confirm with `git show`.)

**Migration / DB steps: none.** No schema change in either repo.

**Post-deploy verification:**
- Vantra: `curl -s -o /dev/null -w '%{http_code}' http://localhost:3300/` → 200;
  `systemctl is-active vantra.service` → active.
- SpaceWorker: the Move panel on a public mesh row shows *"safe move — public agent stays
  online"*; "Check private copy" reports "not seen yet" until the private agent checks in.

---

## Live test plan (Device I) — OWNER RUNS THE COMMAND

1. Owner clicks "Move to private" on the public mesh row → the one-liner is revealed.
2. Owner pastes the one-liner into an **elevated** PowerShell on the machine.
3. Watch for the audible verdict: *"private agent installed and running. Public agent
   untouched."* If it throws instead, the public agent is still fine — re-run the command.
4. Click "Check private copy" in the console → it must report **verified** (the private
   agent has appeared under the private org).
5. **Confirm the public Mesh row is still ONLINE** — this is the property TASK_236 exists to
   guarantee. Wilk must not be deleted.
6. **Deletion is the owner's call, made by hand** from the device list. The console does not
   delete it, and Vantra refuses to remove the public record until verification passes.

---

## Risks / rollback

- **The one-liner is long.** It is one `;`-joined statement, so the relay cannot fragment it,
  but a very long paste into a PowerShell window is still a paste. The guard makes re-runs
  harmless, so a failed paste can simply be repeated.
- **Hostname matching is the verification primitive.** Two machines sharing a hostname could
  produce a false "verified". The match is scoped to the private client's own agent list, so
  a cross-tenant collision cannot happen; a same-hostname pair inside one private org is
  possible but harmless in practice.
- **Rollback:** both repos are one commit ahead of `origin/main` on their own branch —
  `git revert a0bc137 5d5504c` (Vantra) / `git revert fcde2e0` (SpaceWorker), or simply
  redeploy `origin/main`. The public device is never modified by this code, so a rollback
  cannot strand a machine.

---

## HANDOFF → VERIFICATION AGENT

- **repo + branch + commit:** vantra `agent/task-236-move-safe` @ `a0bc137`; spaceworker
  `agent/task-236-move-safe` @ `fcde2e0`. Both pushed, neither merged.
- **exact deploy file list:** see above (Vantra 4 files, SpaceWorker 3 files).
- **migration/DB steps:** none.
- **post-deploy verification checks:** see above.
- **risks + rollback:** see above.
- **Not done, by design:** the live Device I test needs the owner to run
  the command themselves.

> **RESOLVED 2026-10-21:** the owner gave the GO — merged to `main`, pushed and
> deployed by CI (Vantra run `39523455753`, SW run `39523958243`). See the
> "AFTER — DEPLOYED" section below.

---

# AFTER — DEPLOYED 2026-10-21 (senior lane, owner GO)

The owner explicitly requested deployment, so this session ran the senior-lane
procedure from `PROMPT_SENIOR_VERIFICATION_AGENT.md` (§3 preflight, §4 deploy,
§5 verification). The task-agent branch was **merged to `main`, pushed, and
deployed by CI** — the primary deploy path (GitHub Actions `Build & Deploy`),
not the `scripts/deploy-vps.sh` fallback.

## Merges (fast-forward; both branches were direct descendants of `origin/main`)

| Repo | branch → main | main commit | ancestry check |
|---|---|---|---|
| vantra | `agent/task-236-move-safe` → `main` | `a0bc137` | `git merge-base --is-ancestor … origin/main` → **OK** |
| spaceworker | `agent/task-236-move-safe` → `main` | `1073dec` | same check → **OK** |

The ancestry check is mandatory (`HOW_WE_MOVE_FAST.md`): a fix that is not an
ancestor of `main` is silently reverted by the next CI deploy. Both passed.

## Preflight (§3) — all six items, evidence

1. **Working tree vs intent** — the deploy file list was built from the branch
   commits (`git diff --stat origin/main..agent/task-236-move-safe`), not a
   working tree. Working trees were clean at merge time.
2. **Import closure** — every `@/…` import of every shipped file resolved to an
   existing file (`/tmp/t236-import-closure.sh`): SW `lib/device-tools.ts`,
   `components/device-list.tsx`, both move routes; Vantra `lib/trmm.ts`,
   `lib/trmm-move.ts`, both move routes. **Zero missing.** `parseInstallInvocation`
   confirmed exported from `lib/trmm.ts` (the new `lib/trmm-move.ts` consumer).
3. **Shared-file drift** — branches with unique commits vs `origin/main`:
   Vantra: only `agent/task-236-move-safe` (2) and `agent/task-206-sw-device-move`
   (2, **behind main, not merged — no conflict**). SW: `agent/task-236-move-safe`
   (3) plus unrelated long-lived branches (`mailer-exe`, `self-hosted-build`,
   `xdevice-monitor`, `cyberlab-scope`, `task-205/206/209`) — **none of them touch
   the files this task ships** (their `device-list.tsx` / `device-tools.ts` diffs vs
   `origin/main` are *deletions* of pre-main content, i.e. older branches, not
   competing edits). No `sw-lab` ref exists. Box copies are stale source (CI ships
   runtime only) → no box-source clobber.
4. **Schema** — **none**. No `prisma/schema.prisma` change in either repo; no
   migration files; no `db push` / `migrate deploy` was run by this task.

## Deploy (§4) — CI, Vantra first

| Order | Repo | Run | Commit | Jobs |
|---|---|---|---|---|
| 1 | vantra | [`39523455753`](https://github.com/softdeployautomation-sketch/vantra/actions/runs/39523455753) | `a0bc137` | Build & typecheck ✅ · Deploy to production ✅ |
| 2 | spaceworker | [`39523958243`](https://github.com/softdeployautomation-sketch/spaceworker/actions/runs/39523958243) | `1073dec` | Build & typecheck ✅ · Deploy to production ✅ |

**Vantra before SpaceWorker** — SpaceWorker's new "Check private copy" button
calls Vantra's `/move/verify`; the SW half is useless without the Vantra half.
Both were `workflow_dispatch` (the deploy job runs ONLY on dispatch).

## Post-deploy verification (§5) — every row evidenced

### BUILD_ID changed
- Vantra: `DsqUsssuSrpWjU64yu6Oh` → **`ILii0-sQ58h1xHZ2_DENb`**
- SpaceWorker: `KwN0Mfs6wYh2-2ji_gaxK` → **`DYki66BfVsDiG-RbAxdh6`**

### New code IS in the BUILT output (not just rsynced)
- Vantra `.next/server`: `private agent installed and running. Public agent untouched`
  (in `chunks/lib_trmm_ts_*.js`), `old_agent_hostname_unavailable` (the new mesh
  branch of the verify route), `private agent already installed; nothing to do`
  (the idempotency guard).
- SW `.next/server`: `Check private copy`, `public agent stays online`,
  `not_verified` (all in `chunks/ssr/components_device-list_tsx_*.js`), and the
  new route path in `app-paths-manifest.json`.

### Services & health
- `vantra` **active**, `NRestarts=0`, `Result=success`, listening on 3300;
  `localhost:3300` → **200**, `https://vantra.spaceworker.top/` → **200**.
- `spaceworker`, `spaceworker-browser`, `extraction-worker` **all active**;
  `localhost:3500` → **200**, `https://spaceworker.top/` → **200**.
- Maintenance flag `/var/www/sw-maintenance.on` → **absent = OFF** (correct).

### Functional proof (real calls, real token — the exact SW→Vantra path)
Token read from the box `.env`, never printed (length 64 only).

| Probe | Result | Verdict |
|---|---|---|
| `POST …/move/verify` with a **bogus** id + real token | **404** `{"error":"Device not found"}` | auth PASSED, route live |
| same, **no** token | **401** `{"error":"Unauthorized"}` | fail-closed gate intact |
| `POST …/move/verify` on a **real public mesh** id | **200** `{"ok":true,"verified":false}` | **the new mesh branch works** (this path previously always died as 404) |
| `POST …/move/verify` on a **real TRMM** id | **200** `{"ok":false,"reason":"no_private_org"}` | TRMM branch unchanged |
| `POST …/api/devices/x/move-to-private/verify` (SW route, anon) | **401** | route exists + session-gated (not 404) |
| `POST …/api/devices/x/move-to-private` (SW route, anon) | **401** | pre-existing route still gated |

**`/move` on a real public mesh device** (agent `node//7Qmu$P8qlQDQ…`, owner org
`sw-cmtl47mcc0000kpr1ds5s2xic`, which has its private companion
`sw-cmtl47mcc0000kpr1ds5s2xic-p`) → **200**, and the returned plan was checked
field-by-field:

```
ok            : True
flow          : install_verify_remove
moved flag    : True
dest org      : sw-cmtl47mcc0000kpr1ds5s2xic-p
singleLine len: 1829
single line (no newline): True
audible verdict        : True
idempotency guard      : True
says public untouched  : True
mentions mesh          : False          <-- mesh is never touched
dangerous tokens       : NONE          <-- no Uninstall / Remove-Service / Stop-Service / schtasks /delete
```

and `/move/verify` on that **same** device → `{"ok":true,"verified":false}`
(correct: the private agent has not been installed yet).

The generated one-liner is idempotent, Tactical-only, and ends with the audible
verdict *"private agent installed and running. Public agent untouched. Verify it
in your private devices, then delete the public row yourself."*

## Gates re-run on the exact shipped trees (my own, not the task agent's)
- Vantra: `npx tsc --noEmit` → **0**; `npx tsx --test tests/*.test.ts` → **0**;
  `npx eslint` on the 4 shipped files → **0**.
- SW: `npx tsc --noEmit` → **0**; `npx tsx --test tests/*.test.ts` → **0**;
  `npx eslint` on the 4 shipped files → **0**.

## Incidents
- **None.** The two scary journal lines were both explained as normal deploy
  mechanics (SIGTERM 143 on stop; a 17s Vantra restart window). No rollback needed.

## Still the OWNER's job (unchanged by this deploy)
The **live Device I test** — pasting the one-liner into an elevated PowerShell on
the target machine — cannot be run by an agent. Steps in the "Live test plan"
section above. The public Mesh row must stay ONLINE throughout; the public row
is deleted by the user, by hand, only after "Check private copy" reports verified.

## Rollback
`git revert a0bc137 5d5504c` (Vantra) / `git revert fcde2e0` (SW) → push → CI
dispatch, or redeploy `origin/main`. The public device is never modified by this
code, so a rollback cannot strand a machine.


### Journal
- Vantra: the only "Failed with result 'exit-code'" line is `status=143/n/a`
  — the expected SIGTERM of the CI stop, **not** a crash. `NRestarts=0`,
  `Ready in 231ms` after restart, **zero** errors after 02:52.
- SW: the two `vantra_502` lines are stamped **02:51:28** = inside Vantra's
  restart window (Vantra was down for ~17s). **Zero** SW errors after 03:02.

5. **Safety copy** — `cp -a` of both live `.next` trees to
   `/root/.next.<BUILD_ID>-safety` (Vantra `DsqUsssuSrpWjU64yu6Oh`, SW
   `KwN0Mfs6wYh2-2ji_gaxK`). Present.
6. **Log capture** — all deploys ran via script files under `/tmp/t236-*.sh`
   with output to `/tmp/t236-*.log` / `*-verify.txt`; CI logs read via `gh run view`.

5. The public agent is deleted only by the user, through the ordinary device-list Delete
   (the existing `/action` → `delete` path, which is the owner's own button).
