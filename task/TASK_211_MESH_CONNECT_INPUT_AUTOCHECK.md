# TASK_211 — MeshCentral connect must NOT auto-check "Input": connect connects, the user decides

Status: READY — scoped by the senior verification agent 2026-10-15 from the owner's report.
Priority: owner-declared "the most important bug right now we need to fix first".
Repo: spaceworker (artifacts only — the fix itself is box-side; see §3).
Box: root@164.68.105.96 (tacticalrmm_vps key). Parallel-safe with TASK_210: this task
touches ONLY the nginx mesh vhosts + repo verify script — never the Next.js app, its
deploy chain, or Vantra.

---

## 1. What the owner reported (verbatim intent)

- "when you fixed the mobile view for the mesh central, you have made the connect button
  of mesh central auto add input, so when a user clicks the connect in the mesh console
  even without clicking the input check, its still auto checks it when you connect, and
  I don't want that, I want the connect button to connect and user decides to check the
  input."
- Also observed on the mobile device-console new tab (TASK_207 launcher card →
  `window.open(mesh.control)`): "no place to check or uncheck input, I am sure that also
  is auto checked." — same root cause, same fix (the new tab loads the SAME MeshCentral
  page on the SAME vhost; §4 covers it automatically).

Acceptance in one line: after Connect, the session comes up with **input OFF**; the
"Input" checkbox is present, enabled, and the user checks it themselves; once they check
it, their choice persists (MeshCentral's own `putstore`) — we only change the DEFAULT
for a fresh browser.

## 2. Root cause (proven from primary sources on the box, 2026-10-15 — not a guess)

The checkbox is MeshCentral's own `DeskControl` ("Toggle mouse and keyboard input"):

- `/meshcentral/node_modules/meshcentral/views/default.handlebars:853` — the checkbox:
  `<input id="DeskControl" type="checkbox" … onclick="toggleKvmControl()" />Input`
- `:1859` — **the bug**: `Q('DeskControl').checked = (getstore('DeskControl', 1) == 1);`
  → localStorage lookup with **default = 1 = CHECKED** for any browser that never
  toggled it.
- `:9591` — re-applies the same default when the share's rights are known
  (`rights & 8` = input right present → `getstore('DeskControl', 1)` again).
- `:10885` — `toggleKvmControl()` → `putstore('DeskControl', …)` — the user's toggle is
  persisted by MeshCentral itself. We must NOT break this.

The box runs `minify: 1` (`/meshcentral/meshcentral-data/config.json`), so the live page
is compiled from `default-min.handlebars` (866 KB, checked on disk): it contains exactly
**2 × `getstore("DeskControl",1)`** — the minified twins of :1859 and :9591.

Why it LOOKS like our TASK_207 change caused it: the default predates TASK_207 (it is
upstream MeshCentral behavior), but TASK_207 switched the customer console from TRMM's
group `login=` URLs to Vantra's per-device **guest share** URLs
(`/opt/vantra/lib/meshcentral-api.ts` → `createDeviceShareLink`, `viewOnly: false`,
`appBits` 7 = desktop|terminal|files, `consent: 0`, `expire: 0`), and that guest page
surfaces the Input checkbox right next to Connect — so the pre-checked default became
visible and consequential. The mint is CORRECT and must stay `viewOnly: false`:
view-only would strip the input right entirely (lines 9592–9593 then disable the box)
and the owner explicitly wants the user to be ABLE to check input.

Verified NOT to be our repo's doing: `/Users/mikeolab/spaceworker/lib/device-tools.ts`
(`fetchMeshUrls`, lines 119–196) only rewrites the hostname
`mesh.instaweb.top → mesh.spaceworker.top` and appends `?scope=device`; no input/view
params are ever added client-side.

## 3. Fix plan (primary = A; B and C are fallbacks)

### Option A — nginx `sub_filter` on the mesh vhosts (RECOMMENDED)

Rewrite the two occurrences ON THE WIRE in the HTML MeshCentral serves. Entirely
nginx-side: survives MeshCentral self-updates/npm reinstalls (it is a transform, not a
file patch), needs NO MeshCentral restart, and is reversible by deleting a marked block.

Edit `/etc/nginx/sites-enabled/mesh.spaceworker.top.conf` (the SSL `server` block, the
one whose `location /` proxies to `http://127.0.0.1:4430/` — NOT the :80 redirect
block). Insert after its `server_name` line:

```nginx
    # >>> TASK_211 — fresh browsers must land with MeshCentral "Input" UNCHECKED.
    # MeshCentral's own default is getstore("DeskControl",1) (=checked); the owner
    # rule: connect connects, the user decides on input. The user's toggle still
    # persists via MeshCentral's putstore — only the default changes.
    # Delete this marked block + `nginx -t && systemctl reload nginx` to revert.
    sub_filter 'getstore("DeskControl",1)' 'getstore("DeskControl",0)';
    sub_filter_once off;                       # both occurrences, not just the first
    proxy_set_header Accept-Encoding "";       # sub_filter cannot match compressed bodies
    gzip on;                                   # re-compress after the rewrite (866 KB page)
    gzip_comp_level 5;
    # <<< TASK_211
```

Notes: `sub_filter` context is http/server/location — server-level is valid, and
`proxy_set_header` is valid there too. Websocket-upgraded connections are unaffected
(sub_filter applies to the text/html page only). Apply the SAME block to
`/etc/nginx/sites-enabled/meshcentral.conf` (`mesh.instaweb.top`) so the admin path
(TASK_147) behaves identically — the owner's rule is universal, and this is cosmetic
there (operator just sees an unchecked box).

Procedure (idempotent, guarded — package as `scripts/t211-mesh-input-default.sh`):
1. `nginx -t` must pass BEFORE any change (pre-flight).
2. Backup each conf to `<conf>.bak-t211` (skip if backup exists — idempotent re-runs).
3. If the `# >>> TASK_211` marker is already present in a conf, SKIP that conf.
4. Insert the marked block after the `server_name` line of the SSL server block
   (grep-driven; fail loudly if the anchor or the `proxy_pass http://127.0.0.1:4430/`
   target can't be found — never guess an insertion point).
5. `nginx -t` again — on failure, restore the backup(s) and EXIT NONZERO (rollback).
6. `systemctl reload nginx` (NOT restart; no other vhost disruption).
7. Never touch: `/opt/spaceworker` (the app), `spaceworker.service`, `meshcentral.service`,
   `/opt/vantra`, any git push.

### Option B — seed-shim page (fallback, only if A cannot match — e.g. upstream serves
pre-compressed bodies that `Accept-Encoding ""` fails to neutralize): a static
`/swseed` page on the mesh vhost that does
`if (localStorage.getItem('DeskControl') === null) localStorage.setItem('DeskControl','0');
location.replace(TARGET)` with `TARGET` passed encoded, and both console entry points
(`device-console.tsx` iframe src + new-tab open) wrapped to it. Touches app code —
deploy-coupled, so use only if A is proven impossible.

### Option C — patch `default-min.handlebars` (2 × → `,0`) + restart meshcentral
(LAST RESORT): wiped by any MeshCentral npm/self-update, requires a service restart
(riskier to the live box). Not preferred; documented only for completeness.

## 4. Why A covers every surface the owner listed

All customer paths load the SAME page on the SAME vhost:
in-page iframe (`device-console.tsx:3858` `src={mesh.control}`), mobile new-tab
(`device-console.tsx:3843` `window.open(mesh.control)` — the TASK_207 launcher card),
and the admin path (second vhost). One wire-level rewrite
fixes all of them. In the new tab the toolbar/input checkbox is MeshCentral's own UI —
after this fix it renders unchecked.

## 5. Verification battery (run from the box AND a fresh browser)

Pre-change (must show the bug):
1. `curl -sk --resolve mesh.spaceworker.top:443:164.68.105.96 https://mesh.spaceworker.top/ |
   grep -o 'getstore("DeskControl",1)' | wc -l` → **2** (ground truth on the LIVE page —
   a bare 127.0.0.1 curl gets no SNI/Host match; use --resolve or -H 'Host:').
Post-change:
2. Same curl → `…"DeskControl",0` count **2**, `…"DeskControl",1` count **0**.
3. `nginx -t` clean; `grep -c '>>> TASK_211' <both confs>` → 1 each; backups exist.
4. `systemctl is-active nginx meshcentral spaceworker` → all `active`; the app was never
   touched: `ls -la --time-style=+%m-%d_%H:%M /opt/spaceworker/.next/BUILD_ID` unchanged.
5. Functional (real browser, fresh profile / private window, phone + desktop):
   a. Console → Connect → session comes up; **Input checkbox is UNCHECKED**; moving the
      mouse/typing does nothing yet (input truly off).
   b. Check Input → mouse+keyboard work immediately.
   c. Reload the MeshCentral page → checkbox stays CHECKED (user's persisted choice —
      putstore path intact; proves we changed the default, not the capability).
   d. Uncheck → input off again; persists too.
   e. Mobile launcher card → "Open remote console" new tab → same behavior in the tab.
   f. Both hosts: mesh.spaceworker.top (customer) and mesh.instaweb.top (admin) pages
      render (200) and MeshCentral websockets still connect (console usable end-to-end).
6. Negative: an OLD browser that had previously checked Input still comes up checked
   (we must not clobber stored user state — sub_filter only touches the default literal).

## 6. Coordination protocol (owner rule: parallel work, zero interference)

- Branch in `/Users/mikeolab/spaceworker`: `agent/task-211-mesh-input` off current `main`.
- Deliverables: this doc + `scripts/t211-mesh-input-default.sh` (apply, idempotent,
  rollback-safe) + `scripts/t211-mesh-input-verify.sh` (the §5 curl/grep/nginx assertions,
  machine-readable PASS/FAIL per line).
- Commit LOCALLY only, and ONLY when the senior agent instructs. NO push. NO deploy.
  The senior agent reviews the scripts, runs them on the box, and owns the nginx reload.
- If anything deviates from §3's assumptions (anchor line missing, upstream body already
  compressed in a way sub_filter can't match, marker conflicts), STOP and report — do not
  improvise on the live box.

## 7. Explicit non-goals (do not creep)

- Do NOT change the Vantra mint (`viewOnly`, `appBits`, `consent`, `expire` stay as-is).
- Do NOT touch the SpaceWorker app code, its deploy chain, or `/opt/spaceworker`.
- Do NOT disable MeshCentral's `putstore` persistence (user choice must survive reload).
- The mobile mouse-controller / landscape-portrait / new-tab-with-tools work is a
  SEPARATE task (TASK_212, to be scoped next) — not this one.



