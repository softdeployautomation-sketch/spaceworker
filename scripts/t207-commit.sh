#!/usr/bin/env bash
set -u
cd /Users/mikeolab/spaceworker
git add lib/device-tools.ts lib/device-onboarding.ts components/device-console.tsx tests/console-mesh-scope.test.ts tests/support-tickets.test.ts
cat > /tmp/t207-s1s2-msg.txt <<'MSGEOF'
TASK_207 (S1+S2): scoped mesh mint client + mobile new-tab console UX

S1 — scope=device customer path (the leak client half):
- lib/device-tools.ts: fetchMeshUrls appends ?scope=device and surfaces a loud
  console.error when Vantra answers scoped:false (never silent; scoped stays out
  of the return shape). adminFetchMeshUrls deliberately unchanged — admin breadth
  is TASK_147 by design (documented in-code).

S2 — mobile console acts like desktop (open new tab, owner decision):
- components/device-console.tsx: hydration-safe useIsMobileViewport hook
  (useSyncExternalStore, max-width 639px, server snapshot false). On mobile the
  console shows a launcher card — primary CTA opens the MeshCentral desktop UI in
  a new tab (noopener,noreferrer), secondary "view here instead" embeds the
  iframe for users who opt in. Desktop embed byte-unchanged; toolbar unaffected.
- tests/console-mesh-scope.test.ts: 5 source-contract tests (customer scope=yes,
  admin scope=no, loud fallback, new-tab URL hygiene + opt-out, hydration-safe hook).

Pre-existing errors TREATED (owner rule: none tolerated):
- device-onboarding.ts: OnboardingViewInput gains movedAt?: string | Date | null
  (type matched exactly to the TASK_206 branch) — fixes the tsc error at
  device-console.tsx:2034 left by the unmerged-but-deployed 206 work.
- device-tools.ts: removed dead getAdminSettings import (unused on origin/main too).
- support-tickets.test.ts:1409: replaced racy exact-equality cursor assertion with
  the real invariant (>= first — never backwards, per markTicketRead's contract,
  lib/support/tickets.ts:640-643); failed only under full-suite clock load.

Gates: tsc exit 0 · eslint exit 0 · FULL suite 1419 tests / 1418 pass / 0 fail /
1 known DB-gated skip.
MSGEOF
git commit -q -F /tmp/t207-s1s2-msg.txt
echo COMMIT_EXIT=$?
git --no-pager log --oneline -3
git --no-pager show --stat --format='%h %s' HEAD | head -18
