# PROMPT — VERIFICATION AGENT for TASK_188 (secret admin devices page + deleted-devices recovery)

TASK_188 implementation is expected to be COMPLETE when you run. Your job: independently
verify it and close it out — or FAIL it loudly with repro steps. Sources of truth:
**`TASK_188_SECRET_ADMIN_DEVICES.md`** (scope S1–S5, owner's verbatim words) and the
implementer's **`TASK_188_STEPS.md`** (their tracker — MUST exist with every step checked
+ evidence; missing/incomplete = FAIL and report). Playbook (binding):
`HOW_WE_MOVE_FAST.md` (§7 gates → §2/§3 deploy → §4/§6 live evidence). NEVER git stash;
never edit `.env`; never touch TASK_133; REJECT any commit/doc containing live secrets.

Start: `git log --oneline -8` in `/Users/mikeolab/spaceworker`. Record
`git rev-parse HEAD`. TASK_188 work must be after `62ffb3e` (TASK_185 steps commit) and
after the TASK_187 commits if both landed (verify order by `git log`).

## 1. S1/S2 — Devices tab GONE from admin panel; secret page exists
- `grep -n '"devices"' app/admin/\(protected\)/admin-panel.tsx` → no Tab union member,
  no tab button, no `setTab("devices")`, no `<DevicesTab` render; `grep -n "View
  devices"` → no jump in UsersTab.
- `components/admin/devices-tab.tsx` exists; admin-panel imports nothing of it.
- `app/admin/device/101/page.tsx` (+ its guard) exists and renders the extracted tab.
- **Secrecy:** `grep -rn "admin/device/101" app components lib` → only the route file
  itself (no nav/menu/sitemap/robots reference). `curl -sI https://spaceworker.top/admin/device/101`
  without admin cookie → redirect/401 to `/admin/login` (not 200 content); WITH the
  admin session cookie → 200 (house curl pattern with the box's admin session).
- `npm run test:devices` + the new suite (whatever they named it) green, including the
  static locks: no devices-tab entries left in admin-panel, route gated.

## 2. S3/S4 — Deleted subtab + restore/reassign
- API: `GET /api/admin/devices?removed=1` (admin session required — 403 without) returns
  soft-deleted rows; **default GET unchanged** (still excludes `removedAt` rows).
- `PATCH /api/admin/devices/[deviceId]/restore` with `{userId?}`: 403 without admin
  session; with admin: sets `removedAt` to NULL explicitly (read the route — it must be
  an explicit clear, never a sync side-effect), reassigns owner when `userId` given,
  rejects an unknown target user. Unit test covers all four cases.
- Tools on deleted rows: the Deleted subtab list carries run-command + mesh-urls and
  those endpoints accept a soft-deleted device id (check for `removedAt` filters in the
  admin tool routes — flag any that block a deleted device from being operated).
- Live (house pattern, clean up after): soft-delete a test device → appears in Deleted
  subtab with owner + timestamp → Recover with a chosen user → row leaves subtab AND
  appears in that user's `/api/devices` list. Owner eyeball = final evidence.

## 3. REGRESSIONS + DEPLOY-STATE
- `npx tsc --noEmit` → 0; ESLint touched files → 0 NEW (stash A/B; admin-panel carries
  pre-existing errors — NOT theirs; flag new ones only).
- Suites: `test:devices` 6 · `test:xdevice` 38 · `test:module-gate` · `test:wallet` 63 ·
  `test:wrapper-cookie` 6 · `test:maintenance-cache` 6 · `test:vantra` 90.
- Prior tasks intact: TASK_184 (locks live), TASK_185 P1/P2 (chip + counts), TASK_187
  if landed (support notify + invoice composer present), TASK_183 wrapper, TASK_186.
- Deploy-state: fresh BUILD_ID, service active, site 200, repo↔box md5 parity on
  touched files, secrets scan over new commits.

## 4. HANDOFF + REPORT
- Check off / append evidence in `TASK_188_STEPS.md`; mark TASK_188 S1–S5 complete;
  refresh `SENIOR_HANDOFF.md` §6; REWRITE THIS PROMPT for the next verifier; commit with
  explicit messages; push.
- Report: PASS/FAIL table over §1–§2, regression output, deploy evidence (BUILD_ID,
  curl status matrix for the secret route with/without admin session, chunk greps), and
  an OPENLY UNVERIFIED list (browser clicks, owner-only checks like "no link exists in
  my UI").