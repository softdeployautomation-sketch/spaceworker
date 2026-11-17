# TASK_224 — Delete button for public install links (history rows)

**Status:** SCOPED 2026-10-19 — ready for the Task Agent.
**Branch:** `agent/task-224-install-link-delete` (from `main`).
**Owner decision (2026-10-19):** the CURRENT link is PROTECTED — no delete on
the row that matches `link.installUrl`; only older history rows (expired or
live) are removable. An expired current link stays until a new mint replaces it.
**Schema change:** NONE. Hard-delete of existing rows — no migration, additive
rules untouched. **Deploy:** NOT this agent's job — Senior Verification owns
ship after the 🚦 owner GO.

---

## 1. Why

The Add-a-device → Public device panel's **All links** list
(`components/device-list.tsx`, TASK_171 block ~L1225–1281) grows forever: every
public mint ever made lands one `VantraInstallLink` row. The owner's report:
**expired links "just laying there" with no way to remove them.** Today the row
offers Copy only.

## 2. Exact surface (already located — don't re-hunt)

| Piece | Where |
|---|---|
| Row UI + Copy button | `components/device-list.tsx` L1232–1281 (`link.installLinks.map`), Copy button L1274–1279 |
| Row index numbering | `#{link.installLinks.length - index}` (L1246) — renumbers after a delete, that's fine |
| Expiry chip | `formatInstallLinkCountdown(expiresMs, nowMs)` (L1269), off the existing 1-min `nowMs` tick — **add no new fetch/poll loop** |
| Data model | `prisma/schema.prisma` `VantraInstallLink` (~L2416): `id`, `userId`, `tokenHash @unique`, `publicUrl`, `expiresAt`, `installerUrl` (SERVER-ONLY), `installerPayloadJson` (SERVER-ONLY), `downloadCount` |
| List builder | `listInstallLinks()` in `lib/vantra-link.ts` L151 — select excludes `installerUrl`/`tokenHash`; keep it that way |
| Session | `getSession(): { userId } \| null` (`lib/session.ts`) — same as `app/api/assistant/vantra/install-link/route.ts` L98 |
| Themed confirm | `useConfirm()` — already imported in device-list.tsx (L18, used L205/L628). **Never `window.confirm`.** |
| Audit | `recordAgentActionAudit()` (`lib/devices.ts` L191), mint precedent: action `vantra_install_link_minted`, `detail: { orgId }` |
| Existing test harness | `tests/vantra-link-installer.test.ts` — fake `vantraInstallLink` delegate (L241 honours `select`), route module required at L756, TASK_171 tests from L1291 |

## 3. What to build

### 3a. API — `DELETE /api/assistant/vantra/install-link/[id]`

New file `app/api/assistant/vantra/install-link/[id]/route.ts`
(Next 16 — `params` is a Promise: `const { id } = await params;` — see
`app/api/hosting/links/[id]/route.ts` for the house pattern).

1. `getSession()` → 401 if null.
2. Load the row **scoped to the caller**: `findFirst({ where: { id, userId } })`
   → 404 if absent (another user's row must read as "not found", never
   "forbidden" — no existence oracle).
3. **Server-side current-link protection (the UI hiding the button is NOT the
   gate):** load `db.vantraLink.findUnique({ where: { userId } })`; if
   `row.tokenHash === link.installTokenHash` (equivalently
   `row.publicUrl === link.installUrl`) → **409 `{ error: "current_link" }`**.
   Owner rule from §top of this doc.
4. `db.vantraInstallLink.delete({ where: { id: row.id } })`.
5. Audit: `recordAgentActionAudit({ userId, action:
   "vantra_install_link_deleted", status: "executed", detail: { orgId } })`.
   **`detail` must NOT contain `publicUrl` or the token** — the URL *is* the
   raw token (`/link/vantra/<token>`); only `{ orgId }`, matching the mint.
6. Return the refreshed view (`toViewWithHistory` shape, like the POST does)
   so the client can replace `link` state in one round-trip — or
   `{ ok: true }` plus client-side row removal (see 3c). Either, but say which
   in the STEPS doc.

Deleting a row **must not** touch: `VantraLink` (pointer untouched — current
link is protected by construction), other history rows, `AgentActionAudit`,
devices, or the Vantra org. No `vantraFetch` call — deletion is local-only.

### 3b. Resolver safety (prove, don't assume — all three)

- `resolveInstallToken` (vantra-link.ts L985): deleted hash ⇒ `mint` null ⇒
  legacy lookup matches only `VantraLink.installTokenHash` = the CURRENT
  pointer, which by the 409 rule is never a deleted row ⇒ `null`. **A deleted
  link must 404 immediately** (`app/link/vantra/[token]/route.ts`).
- `resolveVbsInstallToken` (L937): row gone ⇒ `null`. Same 404.
- **No zombie via the legacy path:** the pre-TASK_171 pointer was overwritten
  each mint, so a *deleted history* token can never equal the current
  `installTokenHash`. Pin this with a test, not prose (§4).

### 3c. UI — Delete button per row (`components/device-list.tsx`)

- In the row (next to Copy, L1274): a **Delete** button, styled like the
  existing border buttons but `text-red-600` affordance on hover — follow the
  console's danger styling, no new deps.
- **Hidden entirely** (not disabled) when `item.installUrl === link.installUrl`
  — the current-link row. Owner decision.
- Click → themed `confirm({ … confirmVariant: "danger" })`. Copy must state the
  consequence plainly, e.g. title `Delete this link?`, description:
  - expired row: *"This link has already expired — deleting it only removes it
    from your list. Nothing stops working."*
  - live (non-current) row: *"Anyone using this link will no longer be able to
    download the installer. This can't be undone."*
- Busy state: reuse a `deletingId` string state (mirror `removingId` L659–690);
  the row's button shows `Deleting…` and disables; **do not block other rows**.
- On success: `setLink(prev => prev ? { ...prev, installLinks:
  prev.installLinks.filter(x => x.id !== item.id) } : prev)` — instant removal
  (same pattern as `removeDeviceRow` L685). On failure: `setError(...)` with
  the server message; row stays. 409 `current_link` should be unreachable via
  UI, but if it arrives, show the error — never silently drop the row.
- Count label `All links (N)` (L1235) and `#N` numbering update automatically
  from state — verify, don't special-case.
- The top current-link card, Generate/Regenerate/New link, PS/VBS mints,
  copy-PDF, method dropdown: **all untouched.**

## 4. Required tests (`tests/vantra-link-installer.test.ts`, node:test + assert)

1. **Delete removes the row** — mint twice, DELETE row 2 via route with session
   → 200; `listInstallLinks` returns only row 1; row count in fake delegate −1.
2. **Current link protected** — DELETE the row whose `tokenHash` equals the
   `VantraLink.installTokenHash` → 409 `current_link`; row still present; the
   link STILL resolves (regression pin for the owner rule).
3. **Cross-user isolation** — session A cannot delete session B's row → 404,
   B's row intact.
4. **401 without session.**
5. **Zombie-pin** — after deleting a non-current history row,
   `resolveInstallToken(<that token>)` → `null` AND
   `resolveVbsInstallToken(<that token>)` → `null` (vbs-kind row).
6. **Expired rows are deletable** — expired row deletes with the same code path
   (no `expiresAt` branch anywhere in the handler).
7. **Audit written** with action `vantra_install_link_deleted` and a `detail`
   that does NOT match `/link\/vantra\//` or contain the token (blunt-negative
   lesson from HOW_WE_MOVE_FAST: forbid the CLAIM, not the word).

Fake delegate note (HOW_WE_MOVE_FAST test lessons): the fake
`vantraInstallLink` currently implements `findMany`/`create`/`update` — adding
`delete`/`findFirst` is a **real change to the stub**; a delete that 404s
because the stub lacks the method must not be read as "green" (a test passing
because it bails early passes for the wrong reason — L1272 lesson).

## 5. MAY TOUCH / MUST NOT TOUCH

**MAY:** `components/device-list.tsx` (All-links block + one handler),
`app/api/assistant/vantra/install-link/[id]/route.ts` (new),
`lib/vantra-link.ts` (only if a `deleteInstallLink()` helper keeps the route
thin — preferred: all ownership/409 logic in the lib so the test hits the same
code as prod), `tests/vantra-link-installer.test.ts`, this file +
`TASK_224_PUBLIC_LINK_DELETE_STEPS.md` (create as you go).

**MUST NOT:** `prisma/schema.prisma` / any migration, `.env`, `proxy.ts`,
deploy scripts, `app/link/**` resolvers (prove them, don't edit them), the
current-link card & mint functions, other tasks' branches/files, Vantra repo.
No new dependencies. No new poll interval.

## 6. Gates (run yourself; paste outputs into `_STEPS.md`)

```bash
npx tsc --noEmit -p .          # 0 errors
npm test                       # floor: 1663 pass / 1662? pass, 0 fail, 1 skip
                               # (record exact counts; suite floor is in PROMPT_* docs)
npm run test:vantra            # the touched suite, in isolation
```

## 7. Handoff

Create `TASK_224_PUBLIC_LINK_DELETE_STEPS.md` with per-step checkboxes +
evidence, ending in `## HANDOFF → VERIFICATION AGENT` covering: the 7 tests
above, exact gate counts, and an explicit note that **nothing was deployed**
(Senior Verification ships via CI after 🚦 GO; the branch must be merged to
`main` in the same session it ships — playbook "merged-to-main is deployed").
Report in the exact format of `PROMPT_NEXT_AGENT.md` §7.

