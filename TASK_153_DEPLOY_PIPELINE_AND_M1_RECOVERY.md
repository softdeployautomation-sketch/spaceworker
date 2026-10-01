# TASK_153 — Production is STALE: deploy-pipeline gap, and M1 was never built

**Owner report:** *"all task to m7 done and committed, but i cant see m6 commit on the
github ui, but agent claimed it was done.... also after m5 there was a build and deploy,
but the live app still shows the screen monitor under capture and still the same, no
difference."*

**Verdict:** The owner is right on both counts, and the cause is **not** either of the two
things it looks like. Nothing from TASK_150 T1→T5, TASK_151, or TASK_152 M2→M7 has ever
reached the server. The M6 commit **does** exist. And separately, **M1 — the reported
input bug — was never implemented at all.**

---

## 1. Verified state (all evidence gathered 2026-10-01)

### 1.1 M6 IS committed. The GitHub UI is showing a cosmetic oddity, not a missing commit.

```
$ git --no-pager log --format='%h %ci %s' -6
8d06658 2026-10-01 09:36:31 +0100 TASK_152 M7: monitor summaries feed the agent's context (read-only)
f1d3aa0 2026-10-01 09:24:00 +0100 TASK_152 M6: capture scheduler - headroom concurrency, per-user fairness, rotation
88e8e48 2026-10-01 08:31:16 +0100 TASK_152 M5: user-defined screen triggers + periodic digest, delivered via existing notifyUser

$ git merge-base --is-ancestor f1d3aa0 origin/main && echo YES
YES: f1d3aa0 IS an ancestor of origin/main
$ git branch -r --contains f1d3aa0
  origin/HEAD -> origin/main
  origin/main
$ git ls-remote origin refs/heads/main
8d06658fb0c19247f383708412e2ad4b2ad4c77a	refs/heads/main
```

M6's artefacts are all present: `prisma/migrations/20261027000000_task152_m6_capture_scheduler/migration.sql`,
`scripts/task152-m6-evidence.ts`, and in `prisma/schema.prisma` the
`ScreenshotRotationCursor` model plus `screenshotRotationSliceMinutes Int @default(25)`.

**Why it looked missing:** the GitHub Actions run for M6's push is titled **"Build & Deploy"**
rather than the commit subject:

```
36837384772  TASK_152 M7: monitor summaries feed the agent's context (read-only)  main push
36836099988  Build & Deploy                                                       main push   <- this IS M6 (f1d3aa0)
36830814061  TASK_152 M5: user-defined screen triggers + periodic digest ...       main push
```

GitHub fell back to the workflow name for that run's title. The commit is in the history;
only the run label is wrong. **Do not re-do M6.**

### 1.2 THE REAL PROBLEM — nothing has been deployed since 2026-09-30 12:49 UTC

`deploy.yml` declares `on: push: branches: [main]` **and** `workflow_dispatch`, but the
two jobs are gated differently:

```
- name: Build & typecheck                     <- runs on every push
- name: Deploy to production (manual only)     <- workflow_dispatch ONLY
```

For **every** TASK_152 push, the deploy job read `skipped`:

```
--- run 36821377780 (M2) ---
  Build & typecheck = success
  Deploy to production (manual only) = skipped
--- run 36825124830 (M3) ---   same
--- run 36827282851 (M4) ---   same
--- run 36830814061 (M5) ---   same
--- run 36836099988 (M6) ---   same
--- run 36837384772 (M7) ---   same
```

The last *actual* deploy was a manual dispatch:

```
$ gh run list --workflow=deploy.yml --event=workflow_dispatch --limit 3
success  main  workflow_dispatch  36717347002  6m46s  2026-09-30T12:49:59Z
success  main  workflow_dispatch  36710405144  4m54s  2026-09-30T11:44:36Z
success  main  workflow_dispatch  36701734546  5m11s  2026-09-30T10:19:44Z
```

Every TASK_152 commit is dated **2026-10-01**, i.e. *after* the last deploy. The VPS agrees:

```
$ ssh … 'ls -la /opt/spaceworker/.next/BUILD_ID; systemctl show -p ActiveEnterTimestamp spaceworker'
-rw-r--r-- 1 trmm trmm 21 2026-09-30 14:52:28 +0200   (.next/BUILD_ID)
ActiveEnterTimestamp=Wed 2026-09-30 14:56:30 CEST
```

**So "there was a build and deploy" was a green CI run that never deployed.** Green
"Build & Deploy" in the Actions list is not evidence of a deploy.

Confirmed by reading the deployed tree directly:

```
$ ssh … 'grep -n "type Tabs" /opt/spaceworker/components/device-console.tsx'
94:type Tabs = "summary" | "control" | "command" | "clone" | "activity";   <- OLD: no "monitoring"
$ ssh … 'grep -c TASK_152 /opt/spaceworker/components/device-console.tsx'
0
$ ssh … 'ls /opt/spaceworker/components/screen-timeline.tsx /opt/spaceworker/lib/screenshot-summaries.ts'
No such file or directory   (both)
```

…which is exactly the owner's symptom: **the monitor card is still on the capture/summary
surface because the M2 tab has never been on the server.**

### 1.3 M1 WAS NEVER IMPLEMENTED — the original reported bug is still live

```
$ git --no-pager log --oneline --all -- browser-capture/
32626e6 TASK_127 Phase 1 — device screen monitoring, the capture half
```

One commit, ever. No M1. The code is unchanged:

```
browser-capture/capture.ts:161: async function enableInputToggle(frame: Frame): Promise<boolean> {
browser-capture/capture.ts:163:     const box = frame.locator("#DeskControl");
browser-capture/capture.ts:270:   await enableInputToggle(held.frame);      <- still called on every capture
```

The same stale file is on the VPS. **M1 was the one item explicitly marked "the reported
bug" and ordered first; it was skipped, and M2–M7 were built instead.**

### 1.4 M5's notification timer can never be installed — the pipeline silently ships dead features

`deploy/` now holds **13** timers, but the deploy step hardcodes a four-name list:

```
for name in mail-queue-drain dispatcher payment-verify automations-sweep; do
```

M5 added `deploy/screen-notify-sweep.{service,timer}`. It is **not** in that list, and it is
**not** on the VPS:

```
$ ssh … 'ls /etc/systemd/system/*.timer | xargs -n1 basename | sort'
automations-sweep.timer          digest-sweep.timer        payment-verify.timer
clone-sweep.timer                governor-sweep.timer      screenshot-sweep.timer
device-onboarding-sweep.timer    mail-queue-drain.timer    db-backup.timer
device-status-sweep.timer        (no screen-notify-sweep.timer)
```

**Consequence: even after a successful deploy, M5's triggers and digests would never fire.**
A silently dead feature is worse than an absent one — the owner would believe monitoring
notifications work, and nothing about a green deploy would reveal otherwise.

Systemic cause: the list is hardcoded, so **every future unit silently fails to ship**.
`screen-notify-sweep` is simply the first victim. The fix must make that impossible to
repeat, not merely add one name.

### 1.5 Eight migrations are unapplied on the VPS — all additive, none destructive

```
UNAPPLIED: 20261020000000_admin_device_commands
UNAPPLIED: 20261021000000_admin_device_command_kind
UNAPPLIED: 20261022000000_device_pin_request_origin
UNAPPLIED: 20261023000000_lead_duplicate_marker
UNAPPLIED: 20261024000000_campaign_test_recipient_selection
UNAPPLIED: 20261025000000_task152_device_screenshot_summary
UNAPPLIED: 20261026000000_task152_m5_screen_monitor_notifications
UNAPPLIED: 20261027000000_task152_m6_capture_scheduler
```

Verified additive: `destructive=0` (no `DROP TABLE` / `DROP COLUMN`) across all eight. The
deploy step runs `sudo -u trmm npx prisma migrate deploy`, so they apply on the next real
deploy. **A checklist item, not a defect** — but it must be verified afterwards, because a
failed migration aborts the deploy under `set -e` and can leave services stopped.

### 1.6 Two env vars are absent on the VPS — and that is FINE (verified, no action)

```
SCREENSHOT_CAPTURE_URL   = MISSING  -> falls back to http://127.0.0.1:3403              (device-screenshots.ts:331)
SCREENSHOT_BASE_DIR      = MISSING  -> falls back to /var/spaceworker/screenshots in prod (device-screenshots.ts:199-200)
SCREENSHOT_CAPTURE_TOKEN = present  <- the one that actually gates the capture call      (device-screenshots.ts:332-334)
```

Both fallbacks are correct for this host. **Do not add these vars.**

### 1.7 What the deploy tar actually ships (reassuring, and non-obvious)

```
tar czf /tmp/deploy.tar.gz .next node_modules package.json package-lock.json prisma browser-server worker deploy browser-capture
```

`components/` and `lib/` are deliberately **not** shipped — the compiled client and server
code live in `.next`, which is. `browser-capture/` **is** shipped, so an M1 fix will reach
the VPS. A stale `components/device-console.tsx` on the VPS is therefore harmless; the
running UI comes from `.next`. Do not "fix" the tar list.

### 1.8 One more consequence: M5/M6/M7 code ships without their timers or migrations

Because of 1.4 and 1.5, a deploy alone would leave the new notification and scheduler code
**present but inert** — no timer invoking `screen-notify-sweep`, no rotation-cursor table.
S3 must not be declared done on "deploy succeeded"; it must prove the new units are
installed, enabled, and firing.

---

## 2. What is actually wrong, in priority order

| # | Defect | Impact | Task |
|---|---|---|---|
| D1 | Nothing deployed since 2026-09-30 12:49Z | Owner sees no change from any TASK_150/151/152 work | **S3** |
| D2 | `screen-notify-sweep` never installed; hardcoded unit list | M5 silently dead, and every future unit too | **S1** |
| D3 | M1 never implemented | The originally reported input bug is still live | **S2** |
| D4 | 8 migrations pending | Applied automatically on deploy; must be verified | **S3** |

**Not defects, do not "fix":** the M6 commit / GitHub run title (1.1); the missing env vars
(1.6); the tar list (1.7); `push` not deploying — deliberate and documented.

---

## 3. The tasks

### S2 — M1: make the capture path honest about the mesh Input toggle **(do this FIRST)**

This is the owner's original bug, it is the smallest item, and it is isolated in
`browser-capture/` — it cannot conflict with anything else in the queue.

`browser-capture/capture.ts:161-171` ticks `#DeskControl` before every frame, and the
function's own docblock already concedes the capability is unused:

> *"Phase 1 itself NEVER dispatches input ... ticking the box grants a capability nothing
> here uses."*

It is ticked only because the originally-confirmed frame was taken that way, and **nobody
ever verified a view-only session paints the same pixels.** That is the whole task.

**Verdict-first, not delete-first:**

1. Reproduce current behaviour; record what the mesh console shows.
2. Capture the **same screen twice** — Input ticked vs not ticked — and deliver a
   byte/structural comparison **plus both images**, with a stated verdict.
   - Equivalent → remove the tick from the screenshot path.
   - Different (black / blank / degraded) → **do not ship the removal.** Report with
     evidence and STOP for a decision. A blank frame is worse than an unused capability.
3. Restructure so the capability is explicit: `captureScreen` takes a named option
   (e.g. `enableInput`) that **defaults to false**; the sweep path always passes false; the
   `true` branch is unreachable or explicitly guarded, so it cannot silently regress when
   the deferred task/control phase is scoped. Comment the rule: **input is enabled only
   when a task must DRIVE the device; observation never needs it.**

**Do not touch:** the disconnect mechanism (`cmdeskaction(11, null)`) or the two-step
Connect — both are load-bearing findings documented at `capture.ts:1-40`.
**Do not add a `lib/` import to `browser-capture/`** — `lib/` is not shipped to the VPS and
several modules import `"server-only"`, which throws in a plain Node process.
**Never enable input on a real device to make a test pass.**

### S1 — Make the deploy ship *every* systemd unit, and install the one M5 added

Replace the hardcoded four-name list in `deploy.yml` with a **discovered** list, so a new
unit can never be silently omitted again:

- derive the set from `deploy/*.timer` (and the `.service` files they activate) at deploy
  time, rather than naming units in the workflow;
- install + `systemctl daemon-reload` + `enable --now` for each newly added unit;
- keep the existing units working unchanged;
- the step must **fail loudly** if a repo unit is not enabled after install, so a silent
  omission is impossible going forward.

Then confirm `screen-notify-sweep.timer` is actually installed, enabled, and firing on the
VPS. Note `deploy/screenshot-capture.service` and `deploy/spaceworker-browser.service` are
long-running services, not timers — handle services and timers correctly rather than
assuming everything in `deploy/` is a timer.

### S3 — Deploy `main` to production and verify the owner-visible result

Trigger the deploy (`workflow_dispatch` — a push will not do it, by design), then verify:

1. **Migrations applied** — all 8 from §1.5 present in `_prisma_migrations` on the VPS,
   including `ScreenshotRotationCursor` existing as a table.
2. **New code live** — `/opt/spaceworker/.next/BUILD_ID` mtime is newer, and the deployed
   tree contains the new modules from §1.2.
3. **Timers** — `screen-notify-sweep.timer` listed by `systemctl list-timers`.
4. **Services healthy** — `spaceworker`, `dispatcher`, `screenshot-sweep` active; no
   failed units introduced. A failed migration aborts the deploy under `set -e`.
5. **Owner-visible, in a browser:** the device console shows a **monitoring** tab, and the
   monitor card is **no longer under Summary**.

---

## 4. Ordering and constraints

**Order: S2 → S1 → S3.** S2 is independent and fastest. S1 must precede S3 or the deploy
ships M5 inert. S3 is last because it is the only step that touches production.

`S1` and `S3` both edit `.github/workflows/deploy.yml`; run them sequentially.
`S2` touches only `browser-capture/` and may run in parallel with S1 if needed.

**Rules (all tasks):**
- Never edit `.env` on either side. Never edit anything under `src-tauri/target/`.
- Stage only your own files by explicit path; never `git add -A`.
- No `prisma migrate` / `db push` against the live DB from this workstation — the deploy
  applies migrations on the VPS; do not duplicate that locally against production.
- Do not touch `lib/` from `browser-capture/`.
- Do not re-do M6, do not re-add the two optional env vars, do not change the deploy tar
  list of paths.
- Evidence: raw output only — file listings, `systemctl` output, `_prisma_migrations`
  rows, screenshots. Before and after. An honest gap beats a false "verified live".

**Two implementation details in `deploy.yml` that S1 must handle (verified verbatim):**

```
286:            for name in mail-queue-drain dispatcher payment-verify automations-sweep; do
287:              cp "/opt/spaceworker/deploy/$name.service" /etc/systemd/system/
...
292:            for t in mail-queue-drain dispatcher payment-verify automations-sweep; do
293:              systemctl enable "$t.timer" 2>/dev/null || true
294:              systemctl restart "$t.timer" 2>/dev/null || systemctl start "$t.timer" || true
295:            done
296:            systemctl is-active automations-sweep.timer || true
```

1. **The list is duplicated** — lines 286 and 292. Adding a name to only one still ships
   nothing. Both must come from a single source of truth.
2. **The verification is self-defeating** — line 296 checks exactly one timer and ends in
   `|| true`, so it can never fail. That is *why* the omission went unnoticed. The
   replacement must assert **every** repo unit and exit non-zero on a miss.

Gate confirmed verbatim, for S3:

```
30:on:
31:  push:
33:  workflow_dispatch:
36:  build:      name: Build & typecheck
123: deploy:     name: Deploy to production (manual only)
126:    if: github.event_name == 'workflow_dispatch'
```
