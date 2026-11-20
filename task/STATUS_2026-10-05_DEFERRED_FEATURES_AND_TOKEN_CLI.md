# Status — deferred features + the token CLI (2026-10-05)

Owner asked for a status read on Support Tickets and the Wallet before queuing the
next task. Deep detail for each lives elsewhere; this is the short version plus
the one new tool.

## 1. Status of the two deferred features — scoped 2026-10-05

Owner asked for a status read on both before queuing the next task. **Neither has
code.** Both are fully designed; that design is the deliverable, not a stub.

| | Support tickets (159) | Wallet (158) |
|---|---|---|
| Design | `PLAN_TASK_159_SUPPORT_TICKETS.md`, 327 lines | `PLAN_TASK_158_WALLET_BALANCE.md`, 413 lines |
| Code shipped | **Phase 1 backend — 6 routes, migration, 30/30 tests** | **none — zero files** |
| Migrated in prod | yes (`20261107000000_task159_support_tickets`) | no |
| UI | **none.** No page renders a ticket | none |
| Reachable by a user? | no — only `curl` | no |
| Blocked on the owner | rate-limit policy, retention | **O2, O3, O5, O6** (money policy) |

**Support tickets are ~70% built and invisible.** The hard part — the schema, the
ownership rules, credential redaction, the append-only log — is done and proven.
What remains is the part that makes it matter: a user composer + thread, then the
admin queue. It is the cheapest remaining work in the repo because the contract is
already fixed and tested; Phase 2 is rendering, not design.

**The wallet has never been started.** No `lib/wallet.ts`, no `balanceCents`
column, no `/api/wallet`. The design is unusually complete — the ledger, the
integer-cents rule, the guarded-update invariant and the D9 dual-provenance
migration are all decided — but four **money-policy** questions are still open
(O2 refunds, O3 minimum/maximum top-up, O5 replacement-EXE price, O6 supersede vs.
coexist). O5 and O6 are gates, not preferences: W6 cannot be built without them.
W1 can start immediately and depends on none of them.

**Ordering recommendation.** Support Phase 2 first: it is small, unblocked, and
converts already-shipped work into something a customer can use. Wallet W1 second
— it is the foundation phase, needs no policy answers, and everything else in the
wallet queues behind it. Do not start wallet W6 until O5/O6 are answered.

---

## 2. `scripts/set-platform-token.ts` — store a Cloudflare token without a browser

**Status: built and tested locally, NOT committed, NOT deployed.**

The Zones-token investigation concluded the write path is correct and the tokens
were simply never saved. A code fix cannot repair that. What *can* remove the
recurrence is taking the browser out of the loop: the owner runs one command, the
token arrives on **stdin** (never argv — argv is visible in `ps` and persists in
shell history), and the command prints the read-back proof itself.

It writes through the same `updatePlatformAccount()` the panel uses, so it
exercises the real guarantee instead of a parallel one, then re-reads and decrypts
in a **separate query** so the proof is independent of the writer's own return
value.

It also refuses the two inputs that caused this whole thread: a subdomain
(all-lowercase-with-hyphens) and a sentence. Verified against a scratch DB — see
the session log. The first version of that guard was wrong and the test caught it,
which is the argument for having driven the thing rather than reading it.

---
