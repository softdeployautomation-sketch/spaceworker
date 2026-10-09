# TASK_193 — Login page reachable only via referral links (abuse gate, part 1)

## Owner's words (2026-10-09, verbatim)

> "also we have a plan to make the spaceworker users login page not open easily
> like to the public, so users can only access the page through referrals from
> admin or from users, and they should be a link tree to show how each came.
> This is for the first part of the verification security we planned to have
> for abuse"

## Status: PLANNED ONLY — not started (owner ranked it behind TASK_191/192)

## Intent (to refine with the owner BEFORE any code)

1. `/login` (and probably `/signup`/`/verify`) stop serving anonymous public
   traffic; entry requires a referral token/link minted by (a) the admin or
   (b) an existing user.
2. **Link tree**: each account records WHO referred it (admin vs user → which
   user → chain), visible at least to the admin — "a link tree to show how
   each came".
3. First slice of a broader "verification security against abuse" plan.

## Pre-work questions for the owner (blockers before design)

- What happens to EXISTING bookmarked /login users — allowlist by cookie?
  magic back-link? admin-issued invite?
- Does the referral gate apply to the LOGIN step only or also signup?
- Link tree: admin panel tab? per-user? export?
- Relationship to existing invite/referral code in the codebase (if any) —
  must search before designing (grep `invite|referral|refer`).

## PROGRESS

