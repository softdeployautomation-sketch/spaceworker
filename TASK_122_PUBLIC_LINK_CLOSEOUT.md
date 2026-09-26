# TASK_122 — PUBLIC LINK CLOSEOUT: the ZIP that never mints, and the host that has no DNS

Bit **B11** · **RECORDED 2026-09-26 — for pick-up** · owner decisions below are final

> Two owner-reported symptoms on 2026-09-26. They look unrelated and are the same
> shape: **the client half shipped, the server half did not.**
>
> 1. *"no button to click to generate the zip link after the renaming"*
> 2. *"the public link still generates with spaceworker.top instead of instaweb"*

---

## 1. What is actually true (measured 2026-09-26, not inferred)

| Fact | Evidence |
|---|---|
| Production runs a **hybrid** — new client, **old server** | The TASK_121 naming UI **is** live in the built bundle (`.next/static/chunks/1er4e1wmj_czg.js`, mtime `03:39:59`, `BUILD_ID` `03:40:11`, referenced in `.next/diagnostics/route-bundle-stats.json`). But `/opt/spaceworker/lib/vantra-link.ts` has **0** occurrences of `installerUrl`, `mintInstallLink` is still `(userId, kind)` (lines 214-217), and `app/api/assistant/vantra/install-link/route.ts` has **0** references to `installer`. |
| The **database is already correct** — nothing to wait for | `sudo -u trmm npx prisma migrate status` → **`Database schema is up to date!`** (49 migrations). `20261003000000_task121_installer_zip_names` is **applied**; all three columns are nullable, so old code simply ignores them. |
| The client **sends** the names; the server **drops them silently** | `components/device-list.tsx:208` POSTs `{ kind, names: { zipName, updateLinkName, innerFolder } }`. The deployed route ignores `names` and mints the **legacy exe** link → 200, no error, no ZIP. That is the whole "no zip link" symptom. |
| The user sees no **"Generate link"** button | `link.installUrl` is already set, so the panel renders the else-branch (`Copy link` / `New link`). The naming card has **no action of its own** — the fields a user just filled in have no adjacent button. |
| `spaceworker.instaweb.top` **does not exist** | `curl https://spaceworker.instaweb.top/` → **`http=000`** (no IP returned). For contrast: `instaweb.top` → 520, `dl.instaweb.top` → 404, **`agent.instaweb.top` → 200**, `spaceworker.top` → 200 — all on `164.68.105.96`. |
| The link host is welded to **`APP_BASE_URL`** | `lib/vantra-link.ts:346` (`const publicUrl = env.appBaseUrl…`) and `:352` (`${publicUrl}/link/vantra/${token}`). `APP_BASE_URL` is `https://spaceworker.top` today and feeds **11** call sites (PIN callback, campaign links, licence links, setup-bundle base). |

**Consequences.** The ZIP cannot mint until `main`'s server half is deployed. And the link
**cannot** simply be moved to `spaceworker.instaweb.top`, because that name does not resolve —
a link pointing there is a dead link.

---

## 2. Owner decisions — do not re-litigate

- **D1 — never point the link at a host that does not answer.** Moving the link host is
  **gated** on DNS + vhost existing first (§7, D4). No exceptions.
- **D2 — the public-link host must be independently configurable.** Add
  `PUBLIC_LINK_BASE_URL` (default = `env.appBaseUrl`). The link host must be movable
  **without** touching the other ten `appBaseUrl` call sites.
- **D3 — names must never drop silently.** The link view must carry the artifact kind, so the
  console can show *this link is a ZIP named X*. A silent fallback to the legacy exe **is** the bug.
- **D4 — OWNER GATE (not code):** if the link should live on an instaweb host,
  `spaceworker.instaweb.top` needs **DNS → 164.68.105.96 + an nginx vhost + TLS** before any
  switch. Until then the link stays on `spaceworker.top`, which is live and correct.

---

## 3. PATH A — Claude (the bigger half): server truth + link host + console affordance

**Files — exactly these.**
`lib/vantra-link.ts` · `lib/env.ts` · `components/device-list.tsx` · `tests/vantra-link-installer.test.ts`

**A1 — expose the artifact kind on the view.** In `lib/vantra-link.ts`, extend
`VantraLinkView` (line 57) and `toView` (line 77) with:

```ts
installerKind: "zip" | "exe" | null;                                  // from VantraLink.installerKind
installerNames: { zipName?: string; updateLinkName?: string; innerFolder?: string } | null;
```

`installerNames` parses `installerNamesJson` **defensively** — malformed JSON => `null`, never a
throw (a bad row must not break the panel). `toView` is the **only** shape that leaves the server:
**`installerUrl` must NOT be added to it** (existing rule, TASK_121 §6.4 — the raw URL is
server-side only and appears in no response, log or audit row).

**A2 — decouple the link host.** In `lib/env.ts` add `publicLinkBaseUrl`
(`process.env.PUBLIC_LINK_BASE_URL`, default `appBaseUrl`, trailing slash stripped once), and use it
at `lib/vantra-link.ts:346`. **Change nothing else that reads `appBaseUrl`** — the other ten call
sites must be byte-identical.

**A3 — the console affordance (`components/device-list.tsx`).** The naming card gets its **own
primary action**, so the fields always have an adjacent button:

- no link yet → **`Generate link`** (as today);
- a link exists → **`Regenerate with these names`** (today's `New link` keeps its place beside the
  URL for "just give me another one");
- the URL row shows the **artifact kind** — `ZIP · <zipName>` vs `legacy exe` — driven by
  `link.installerKind`, so a silent drop is impossible to miss. When `installerKind === "exe"`
  **and** the user has typed names, say so plainly rather than pretending the names applied.

**A4 — extend `tests/vantra-link-installer.test.ts`** (24 checks today, keep them all passing):
the view exposes `installerKind`/`installerNames`; malformed `installerNamesJson` → `null`; the
link base honours `PUBLIC_LINK_BASE_URL` and falls back to `appBaseUrl`; a names-less mint is still
byte-identical to today (`{}`); the view still has **no** `installerUrl` key.

**Do not touch** the launcher files (`lib/device-tools.ts`, the launcher routes,
`components/device-console.tsx`) — those are already built and awaiting deploy.

---

## 4. PATH B — Cline: the ops closeout (merge + deploy + verify)

No new product code. This is the half that actually makes the owner's complaint go away.

1. **Push `agent/task-104-launcher-backend`** — it is **local-only** today (backend + 2 routes).
2. **Merge to `main`**, in order: `agent/task-104-launcher-backend`, then
   `agent/task-103-104-console-ui`. `main` already carries `agent/task-119a-live-session` and
   `agent/task-121b-public-link-zip`.
3. **Deploy `main`** — this is what ends the hybrid: it ships the TASK_121 **server** half
   (`lib/vantra-link.ts` + the install-link route) so `names` are honoured and the ZIP mints, and
   it ships the launcher (backend routes + Session-menu search UI + TASK_103's
   iframe/fullscreen/tab-persistence amendment).
   `scripts/deploy-vps.sh` does **not** run migrations — run `prisma migrate deploy` explicitly
   first (already applied, so a no-op, but it must not be skipped), then `prisma generate`, build,
   restart.
4. **Verify live:** a names-carrying mint returns a ZIP artifact; the launcher routes answer on the
   device; the console shows the Session-menu **Launch app…** entry; the naming card shows the kind.
5. **Device verification (owner, `Sc` only — never `WilkSF9`).**

---

## 5. Acceptance

**PATH A**
1. `npm run test:vantra` passes, including the new view/base-URL checks and all 24 existing ones.
2. `npx tsc --noEmit` clean; `npx eslint` on changed files — no **new** findings.
3. `installerUrl` appears in **no** view, response, log or audit row (assert it).
4. A names-less mint is **byte-identical** to today — this is the rollback guarantee.
5. With `PUBLIC_LINK_BASE_URL` unset the link base is exactly `appBaseUrl` — i.e. **no behaviour
   change** until the owner flips it.

**PATH B**
6. The deployed `lib/vantra-link.ts` matches `main`'s md5 (the hybrid is over).
7. A mint with names produces a **ZIP** artifact, proven on `Sc`.
8. The launcher is reachable and launches a discovered app on `Sc`.
9. `spaceworker.top` 200; all services active; no new errors in the journal.

---

## 6. Deploy order and rollback

**Order:** PATH A merged → **PATH B** (push launcher A, merge both launcher branches, deploy,
verify). PATH A alone changes **nothing** observable until `PUBLIC_LINK_BASE_URL` is set, so it is
safe to land first.

**Rollback:** unset `PUBLIC_LINK_BASE_URL` (link returns to `appBaseUrl`); for the ZIP, stop sending
`names` (the server falls back to the exe branch, byte-identical to pre-TASK_121). Rows already
handed out keep their remembered ZIP URL — re-mint or revoke to go back.

---

## 7. Owner gate — the only thing that cannot be done in code

**D4.** If the public link should be on an instaweb host, someone must first create
`spaceworker.instaweb.top` → `164.68.105.96` + an nginx vhost + TLS. **Then** set
`PUBLIC_LINK_BASE_URL=https://spaceworker.instaweb.top`.

Verified today, so nobody re-checks it: `spaceworker.instaweb.top` **does not resolve**
(`http=000`). `agent.instaweb.top` and `spaceworker.top` both answer 200 from our VPS.
