# Final acceptance checklist — before handing SpaceWorker to its first customer

**Run this only after Batch 1, Batch 2 (Vantra), and Batch 3 are all reported done and independently reviewed.** This is the owner's own pre-launch gate, not a task for Cline to run unsupervised — hand this to whoever (Cline or a human) does the final pass, but the owner should be the one who signs off on the result before a real customer sees the product.

This checklist has two parts: (A) a fast regression sweep confirming every fix from Batches 1–3 is still correct together, not just individually verified in isolation; (B) a full, real user-journey walkthrough of SpaceWorker's licensing and free-trial-to-premium flows specifically, since those are what a first customer will actually experience.

## Part A — regression sweep (confirm nothing in Batch 3 broke Batch 1/2's fixes)

Each of these was already verified live once, in isolation, when its own task shipped. Re-check them together now because Batch 3's work (new admin tabs, schema changes for Task 55, export route changes for Task 54) touches some of the same files/routes:

- [ ] `npx tsc --noEmit -p .` clean on the full repo, both SpaceWorker and Vantra.
- [ ] SpaceWorker: `127.0.0.1:587` mailbox test-connection → still rejected (Task 51 guard, plus confirm the send path guard in `transporterForMailbox` is still `await`ed everywhere — `grep -rn "transporterForMailbox(" app lib` should show every call site using `await`).
- [ ] SpaceWorker: `trial-ping` and no-session `billing/submit` still rate-limited (Task 52) — a quick burst test, confirm the 429 still trips at the documented thresholds.
- [ ] SpaceWorker: external `curl https://spaceworker.instaweb.top/api/internal/dispatch` → still `403` at nginx (Task 53) — confirm the nginx block survived any subsequent deploy/reload.
- [ ] SpaceWorker: `auto-bind` with a bare `confirmTransfer: true` (no code) → still rejected (Task 49) — this is the one that was *silently* broken once already this session; worth a direct re-check, not just trusting it's still fine.
- [ ] Vantra: whatever Batch 2 shipped (Tasks 45–47) — spot-check each per its own task file's "Verification expected" section.
- [ ] Both repos: `git log --oneline -20` reads as a coherent history with no force-pushes, reverts, or "fix the fix" commits that suggest something regressed silently.

## Part B — full user-journey walkthrough

Two separate journeys — SpaceWorker has two independent premium/access systems (the desktop EXE's own license system, and the web app's `tier`/premium system from Task 55) and a first customer might go through either or both. Walk through BOTH.

### B1 — EXE: fresh install → trial → buy → activate

Use a clean machine or a fully-uninstalled+reinstalled EXE (per `HOW_WE_MOVE_FAST.md` §5 — this needs the real Windows install, not just the local dev-server shortcut, since the trial-timer/gate UI itself is what's under test here).

1. [ ] Fresh install, first launch — dashboard opens immediately, no gate (silent 24h trial).
2. [ ] `POST /api/exe-license/status` reports `inTrial: true` with a real `trialHoursLeft`.
3. [ ] Confirm the trial ping landed: check the admin's "Active trials" tab (built this session) shows this device.
4. [ ] Force the trial to appear expired (edit the local `exe-license-state.json`'s `trialStartedAt` back >24h, or wait it out) — relaunch, confirm the activation gate now shows (License key / Email + password / Buy now tabs).
5. [ ] **Buy now tab**: pick a term (1 month / 6 months / 1 year), confirm the price shown matches `calculateExePrice` (base price × term/180, exactly) for each. Submit a real or test payment. Confirm the payment lands in the admin Payments queue.
6. [ ] Approve the payment (admin action, or let a real on-chain auto-verify run if using a real BTC/USDT test tx).
7. [ ] Back in the EXE, click "Reload license binding" — confirm it picks up the newly-issued license automatically and the dashboard unlocks, with NO manual key entry needed.
8. [ ] Confirm the device now shows in the admin Licenses tab (bound, correct product, correct expiry for the term purchased) and has DROPPED OFF the Active Trials tab (Task 55's "leaves after they get binded" behavior... actually this is the EXE trial-visibility feature from earlier in the session, not Task 55 — don't confuse the two).
9. [ ] Uninstall + reinstall the EXE fresh (simulating a new machine). Use the **Email + password tab** this time (the password being whatever they set via the welcome email's claim link, or the admin-visible one if this is a test account) — confirm sign-in finds the existing license and binds it here.
10. [ ] With the license still active on the first "device" (or simulate this — the important thing is the SAME license, two machine attempts), confirm attempting to activate the SAME license key on a third context triggers the Task 49 confirmation-code flow: a 6-digit code is genuinely emailed, a wrong code is rejected, the right code completes the transfer, and the ORIGINAL device holder gets a "your license moved" email too (`exeTransferCompletedEmailHtml`).
11. [ ] Confirm a Telegram alert fired for at least: the trial-ping (if that's alerted — check), the bind, and the transfer.

### B2 — Web: free/trial user → admin-granted premium (Task 55) → real payment path

1. [ ] Sign up a fresh test account on the web app — confirm they land at `tier: 1` (trial).
2. [ ] Admin grants them premium via the new Task 55 UI — confirm `tier` flips to `5` and a real `premiumExpiresAt` ~30 days out is set.
3. [ ] Confirm they now have full premium feature access, indistinguishable from a real paying customer — no separate "comp" code path visibly treats them differently anywhere in the dashboard.
4. [ ] Admin extends them again before expiry — confirm the expiry STACKS (moves further out, doesn't reset to a fresh 30 days from today).
5. [ ] Backdate their `premiumExpiresAt` (test-only DB edit) to the past — confirm the next session read correctly reverts them to `tier: 1`, not stuck at 5 forever.
6. [ ] Confirm a genuinely pre-existing (pre-Task-55) `tier: 5` user with `premiumExpiresAt: null` is completely unaffected — still full access, no surprise downgrade.
7. [ ] If Task 55 wired `bumpWebTier` to `extendPremium` too: run a real (or test) web-subscription payment end to end, confirm it now sets a real expiry rather than permanent access, and confirm this was flagged clearly in Batch 3's final report so it's a known, deliberate change rather than a surprise.

## Sign-off

Only after every box above is checked against the LIVE deployed server (not local dev, not a mock) — report back a clear pass/fail per section, with any failures called out as blocking before customer handoff. If anything fails, fix it and re-run the relevant section, not the whole checklist from scratch.
