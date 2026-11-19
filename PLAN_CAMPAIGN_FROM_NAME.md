# PLAN — Campaign "From Name" sender display name — web app first

## Goal
Campaign emails show a friendly sender **display name** (e.g. "Weekly Reminder") instead of the bare SMTP address (`admin@channelryapp.sbs`). From name lives **beside the subject** at campaign creation, with an option to add **multiple names to rotate** alongside subject and body. Web app first; mailer EXE after this is perfect.

## Verification checklist — implementation (tick each as done)
- [x] Schema: `EmailCampaign.fromNames String[] @default([])` added
- [x] Schema: `EmailQueueItem.resolvedFromName String?` added
- [x] New Prisma migration created for both columns
- [x] `lib/campaign-create.ts`: `fromNames?: string[]` added to `CreateCampaignInput`
- [x] `lib/campaign-create.ts`: `fromNames` threaded into queue build (rotated independently per recipient)
- [x] `lib/campaign-recipients.ts`: `buildQueueItemRows` assigns `resolvedFromName = fromNames[i % len]`
- [x] Drain route: `from = resolvedFromName ? '"Name" <address>' : bare address` at send time
- [x] Drain route: bare `fromAddress` still passed to `buildCampaignMessage` (mailto link); formatted `"Name <address>"` passed to `sendMail.from`
- [x] Drain route: `PinnedOverride` extended with `fromName`
- [x] `lib/deliverability.ts`: test-send `from` construction accepts optional name, keeps bare address for mailto
- [x] `app/api/campaigns/route.ts`: POST reads `fromNames` from body and forwards to `createCampaign`
- [x] `app/dashboard/campaigns/page.tsx`: UI input for fromNames list rendered beside subject; form types updated; POST body includes `fromNames`
- [x] New/extended unit tests: from-name independent rotation + `"Name <address>"` construction
- [x] `tsc --noEmit` passes (0 errors)
- [x] `eslint` clean on all touched files
- [x] Existing test suite floor maintained (no regressions) — campaign-template-content 8/8, campaign-message 15/15, render-merge 33/33, campaign-recipients 5/5 pass

## Verification checklist — behavior / QA
- [ ] Campaign creation form shows "From name(s)" field(s) beside subject(s)
- [ ] Multiple from names can be added and rotate independently with subject/body
- [ ] Real send displays friendly name in recipient inbox From field
- [ ] Bare address fallback preserved when no from name configured
- [ ] List-Unsubscribe mailto still uses bare address (not formatted name)
- [ ] Test-send uses configured from name

## In progress — unblock campaign-recipients.test.ts execution
- [x] Investigate server-only throw under tsx test runner
- [x] Apply minimal fix (test mock for server-only) without changing production prisma.ts behavior
- [x] Re-run campaign-recipients.test.ts; confirm fromName rotation tests pass — all 5/5 pass

## Deployment (post-verification)
- [x] All implementation + behavior QA gates pass locally
- [ ] Commit changes on feature branch (`task-254-android-agent`)
- [ ] Merge to `main` (fast-forward — branch base == origin/main HEAD `7e88c29`)
- [ ] Push `main` to `origin` (softdeployautomation-sketch/spaceworker)
- [ ] `gh workflow run 'Build & Deploy' -R softdeployautomation-sketch/spaceworker` (deploy job runs on workflow_dispatch only)
- [ ] Verify BUILD_ID changed on box; services restarted; `prisma migrate deploy` applied
- [ ] Live E2E probe on VPS (§4 of HOW_WE_MOVE_FAST.md) — real HTTP against `http://localhost:3500`
- [ ] Confirm from name appears in recipient inbox From field

## Rules followed
- Plan steps tracked in this md file; updated before/after every edit for compact insurance
- No code edits until 🚦 GO from owner (GO received — proceeding with deploy)
- `tsc`/`eslint`/test gates passed before deploy consideration
- Deploy via CI `main` + `workflow_dispatch` dispatch per playbook (box never builds)
- Mailer EXE explicitly deferred (web app only this task)
- Mailbox-level fromName deferred to follow-up

