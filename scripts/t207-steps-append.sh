#!/usr/bin/env bash
set -u
F=/Users/mikeolab/spaceworker/TASK_207_STEPS.md
cat >> "$F" <<'EOF'

## Progress — 2026-10-15 S1+S2 COMPLETE: scope threading + new-tab UX, gate GREEN (zero-tolerance)

### New standing rule from the owner (supersedes earlier convention)
- Previous convention "pre-existing errors: split out by owner" is **REVOKED**.
  Owner directive: **no pre-existing errors tolerated — treat them, don't annotate.**
  Any future gate report must be fixed green, never split out.

### S1 done — `scope=device` customer path (`lib/device-tools.ts`)
- `fetchMeshUrls` appends `?scope=device` (GET path-string param through `vantraFetch`;
  Vantra route already reads searchParams — no body plumbing needed).
  Reads `scoped` from the response: `scoped === false` → LOUD `console.error`
  (never silent) and NOT added to the return shape (vantra's own loud log is the trace).
- `adminFetchMeshUrls` deliberately UNCHANGED — admin breadth is TASK_147 by design;
  reason documented in code comment + task doc.
- Editor-insert defect caught by read-back (line 186 opened `"` closed with backtick →
  would be syntax error / non-interpolating `${}`). FIXED. Lesson: read back every
  editor insert on long template strings.

### S2 done — mobile new-tab UX (`components/device-console.tsx`)
- react import += `useSyncExternalStore`; lucide += `ExternalLink`.
- `useIsMobileViewport()` (module level, placement mirrors useTaskBarClock):
  useSyncExternalStore + matchMedia "(max-width: 639px)" (Tailwind sm cascade),
  server snapshot `false` → hydration-safe, mobile-only re-render.
- `ControlTab`: `isMobileViewport` + `embedInPage` opt-out.
  Mobile & !embedInPage → launcher card: bg-emerald-600 CTA
  `window.open(mesh.control, "_blank", "noopener,noreferrer")` + "or view here instead"
  secondary → embed. Desktop embed byte-unchanged (`h-[70dvh] sm:h-[480px]`),
  toolbar (disconnect/PIN/maintenance) above card always.
- In-code honesty note: cross-origin wall — the 208 touch module CANNOT inject into
  the MeshCentral tab; MeshCentral's native full-screen toolbar covers touch modes;
  node-tree leak dies server-side via V1 scoped mint (planned CSS tree-hide dropped
  as redundant — a scoped share has no tree to hide).
- New `tests/console-mesh-scope.test.ts` — 5 source-contract tests (customer scope=yes,
  admin scope=no, loud fallback, new-tab+noopener+opt-out, hydration-safe hook).

### Pre-existing errors TREATED under the new rule (3 of 3, none split out)
1. tsc `device-console.tsx(2034) 'movedAt' not in OnboardingViewInput` — branch base
   (origin/main a1704b4) lacks TASK_206 (unmerged but deployed on the box).
   Fix: `movedAt?: string | Date | null` added to `OnboardingViewInput`
   (lib/device-onboarding.ts:136-141), type MATCHED to the 206 branch field
   (206 lib line 190) so the eventual merge has zero drift. No behavior change here.
2. eslint warning `getAdminSettings unused` (device-tools.ts:7) — proven dead on
   origin/main too (grep count=1 = import line only; diff grep =
   NO_GETADMINSETTINGS_IN_MY_DIFF). Fix: dead import removed.
3. Full-suite FAIL `support-tickets.test.ts:1409 TASK_166 cursor FORWARDS` (±1ms) —
   PROVEN racy TEST, not code: `markTicketRead` (lib/support/tickets.ts:640-643)
   stores `now` when the stored cursor is stale, so exact equality with `first`
   only holds inside one ms; full-suite load ticks the clock. Isolated run = 57/57.
   Fix: assertion now tests the real invariant (`after >= first` — "never backwards"),
   comment cites the route lines that define the contract.

### GATE (scripts/t207-s2-gate.sh → /tmp/t207-gate-*) — ALL GREEN
- `tsc --noEmit` exit **0**
- eslint (device-console, device-tools, device-onboarding, console-mesh-scope) exit **0**
- **FULL suite `tests/*.test.ts`: 1419 tests · 1418 pass · 0 fail · 1 skipped**
  (known DB-gated mailbox test)
- Gate upgraded per the new rule: full suite replaces the 3-file subset;
  device-onboarding.ts added to the lint list.

### NEXT (in order)
1. Commit S1+S2: lib/device-tools.ts, lib/device-onboarding.ts,
   components/device-console.tsx, tests/console-mesh-scope.test.ts,
   tests/support-tickets.test.ts. (Gate scripts + TASK_*.md stay untracked per
   repo precedent.)
2. **S3 deploy order is hard: VANTRA FIRST, THEN SPACEWORKER.** The scoped mint
   (`agent/task-207-mesh-scoped-mint`, commit `0f31097`) deploy status is
   UNVERIFIED — check it. If the old Vantra route is still live it IGNORES the
   `scope` param and silently returns the broad token, which makes our
   `scoped:false` backstop dead code. Sequence: deploy Vantra route → deploy
   spaceworker → curl-verify scope=yes (customer) / broad+loud (admin).
3. Live phone/tree verify deferred — device offline.
EOF
wc -l < "$F"
echo '=== git ==='
cd /Users/mikeolab/spaceworker
git status --short | head -15
git branch --show-current
