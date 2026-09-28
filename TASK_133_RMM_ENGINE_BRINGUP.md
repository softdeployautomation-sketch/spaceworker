# TASK_133 — Self-hosted Phase 4: SpaceWorker RMM Engine (bring-up + app)

**Status: OPEN. Assigned to Cline.** Phase 4 of
`/Users/mikeolab/.claude/plans/transient-moseying-tome.md` — the hardest,
most externally-uncertain phase of the whole self-hosted plan (its own words:
"expect this to be where timeline risk concentrates"). This task is scoped
to make that risk concrete and bounded rather than open-ended.

**Lives in a THIRD repo, not spaceworker or sw-rmm-core.** New private repo
`https://github.com/softdeployautomation-sketch/sw-rmm-engine`, cloned
locally at `/Users/mikeolab/sw-rmm-engine`, `main` branch, commit `6c91d26`
already pushed. Work there directly. This file just tracks the task in
`spaceworker` for continuity with TASK_129/130/131's numbering — nothing to
change in `spaceworker` itself except possibly TASK_130's wizard once a real
RMM Engine exists to test its "test connection" step against (not required
for this task to be considered done).

## Read first (mandatory)

- `sw-rmm-engine/README.md` and `sw-rmm-engine/installer/trmm-install.exp`'s
  own header comment — it documents a real, load-bearing finding (TRMM's
  installer IS automatable via `expect`, contradicting Phase 0's earlier
  "no non-interactive path exists" conclusion) and a real `expect` bug
  already found and fixed (its regex-to-glob "boost" pre-filter silently
  mishandles escaped parens/brackets — **never write a literal `(`, `)`,
  `[`, or `]`, escaped or not, in a new `-re` pattern in that file; use `.`
  in its place**, exactly as the existing patterns do).
- `installer/bringup.sh` — the 4-step bring-up script. Step 1 (TRMM) is
  implemented and locally verified (against a faithful mock, not the real
  installer yet — see §1 below). Steps 2-4 are stubs, this task's main job.

## §1 — Mandatory first checkpoint: run it against a REAL VM

Before touching anything else, prove `installer/bringup.sh`'s step 1
actually works against the REAL upstream `install.sh`, not just the mock it
was verified against locally. Use a fresh, disposable Ubuntu 22.04 VM/VPS
(ask the owner for one if none is available — do not reuse the production
VPS or the Cyber Lab track's lab host without asking, per
`project_cyberlab_track` memory's separation). Run `installer/bringup.sh`
as-is (steps 2-4 will just log "NOT YET IMPLEMENTED" and exit) and confirm:

- Every prompt in `trmm-install.exp` matches the real script's real text
  (word for word — upstream may have drifted since 2026-09-28's read).
- TRMM actually comes up: `systemctl status` its services, confirm the
  Django admin login works with the generated username/password (read them
  from the script's own stdout before it exits — they are NOT stored
  anywhere by design), confirm its MeshCentral instance is reachable.
- If a prompt doesn't match, **re-fetch and re-read** the real current
  `install.sh` (`curl -fsSL https://raw.githubusercontent.com/amidaware/tacticalrmm/master/install.sh`)
  rather than guessing — update the `-re` pattern to match reality, keeping
  the "no literal parens/brackets" rule above.
- Once it passes, pin `TRMM_INSTALL_SH_REF` in `bringup.sh` to the exact
  commit SHA you verified against (`git ls-remote` the upstream repo, or
  note the SHA from GitHub's raw URL history) — do not leave it tracking
  `master` indefinitely, since upstream changing wording later would
  silently break this without warning otherwise.

**Do not proceed to §2-§5 until this passes on a real VM.** Everything after
this point assumes TRMM bring-up genuinely works; building WSL2/Windows
orchestration on top of an unverified assumption here is how the plan's own
risk section predicted this phase could go sideways.

## §2 — Steps 2-4 of `bringup.sh`

Fill in the three stubbed steps (exact TODOs already marked in the script):

- **Step 2 (MeshCentral fork swap)**: `npm install` our fork
  (`softdeployautomation-sketch/MeshCentral`, pinned tag `1.2.4` — matching
  what's live in production per `PLAN_MESH_FORK.md` in the `vantra` repo,
  read that file first) over whatever MeshCentral TRMM's installer
  provisioned. Restart the meshcentral service. Do NOT regenerate TRMM's
  MeshCentral config/login credentials — TRMM's own DB row for its
  MeshCentral integration must survive the swap untouched; only the
  application code changes. Verify: MeshCentral still answers, TRMM's own
  device check-in (install a test agent if convenient) still works after
  the swap.
- **Step 3 (sw-rmm-core deployment)**: clone
  `softdeployautomation-sketch/sw-rmm-core` (`main`, already TASK_131-complete
  — 17 routes, full test/build verified), `npm ci`, `npx prisma migrate
  deploy` against a **fresh, separate** Postgres DB/role (never TRMM's
  Django DB, never share credentials) — see that repo's README for exact env
  vars (`DATABASE_URL`, `SW_INTERNAL_TOKEN`, `TRMM_API_BASE_URL`,
  `TRMM_API_KEY`, `TRMM_PUBLIC_API_BASE_URL`, `TRMM_PRIVATE_API_BASE_URL`).
  `TRMM_API_KEY` needs a real API key minted against the just-installed TRMM
  (its own admin UI or Django shell — check `sw-rmm-core`'s
  `lib/trmm.ts` for the exact auth header shape it expects, don't guess).
  **Bind sw-rmm-core to `0.0.0.0`, not `127.0.0.1`** — this is the classic
  WSL2 failure mode identified in Phase 0's findings: a service bound to
  loopback-only is invisible to the Windows host even though WSL2's NAT
  networking auto-forwards ports that ARE bound to `0.0.0.0`. Run it as a
  systemd service (or equivalent) so it survives a WSL2 distro restart.
- **Step 4**: already implemented (token generation + summary) — just
  confirm the printed connection URL is actually reachable once steps 2-3
  are real (not just the placeholder text).

## §3 — Windows orchestration (the Tauri app itself, not started)

New sibling Tauri app inside `sw-rmm-engine` (mirror `spaceworker`'s
`src-tauri/` conventions — read `spaceworker/src-tauri/Cargo.toml` and
`src-tauri/src/main.rs` first for the house style, license header,
windows_subsystem attribute, etc., but this app is much simpler: **no
bundled Next.js runtime, no Node sidecar** — just a native Rust binary with
a plain HTML/CSS/JS status page loaded via Tauri's webview, since this is
"a status/tray-style UI, not the full SpaceWorker dashboard" per the plan).

Rust responsibilities (`src-tauri/src/main.rs` + Tauri commands the status
page calls):

1. **Platform branch**: Linux → run `installer/bringup.sh` directly (as a
   privileged/sudo-capable process — figure out the right elevation story,
   likely `pkexec` or a one-time sudoers entry the app sets up, not silently
   running as root). Windows → the WSL2 path below.
2. **WSL2 detection/provisioning** (Windows only): `wsl --status` to check
   presence; if absent, walk the user through Windows' own `wsl --install`
   (may require a restart — detect this case, show clear "please restart and
   reopen" messaging, and resume cleanly on relaunch rather than hanging or
   silently failing — this exact failure mode is called out in the plan as
   a "don't hide, surface it" requirement). Provision a dedicated Ubuntu
   distro for this purpose (not the user's own default WSL distro, if any).
3. **Run the installer inside WSL2**: `wsl -d <distro> -- bash bringup.sh`,
   capturing stdout/stderr to a log file the status UI can tail (never print
   upstream's raw install.sh output directly in the polished status UI —
   summarize progress from it instead; the raw log is available on request
   for troubleshooting).
4. **LAN reachability — do NOT assume WSL2's auto-forwarding covers this.**
   Phase 0 found WSL2's automatic port-forwarding is Windows-host-only
   (`localhost` on the SAME Windows machine) — it does NOT publish anything
   to the LAN, and WSL2's internal IP changes on every reboot. If SpaceWorker's
   own app might run on a different machine than the RMM Engine (a real,
   named use case in the plan), this Rust code must also:
   - Query the current WSL2 distro's IP (`wsl -d <distro> -- hostname -I`).
   - Set up `netsh interface portproxy add v4tov4` rules forwarding the
     Windows host's LAN-visible IP:port to that WSL2 IP:port, for whichever
     port `sw-rmm-core` (and TRMM's own reverse-proxied port, if the raw TRMM
     web UI ever needs to be reached) listens on.
   - Add the matching Windows Firewall inbound rule.
   - **Redo this on every app launch** (not just first bring-up) — the WSL2
     IP is not stable across reboots, so a stale portproxy rule silently
     breaks reachability until refreshed. Make this idempotent (delete-then-
     recreate, or check-then-skip) rather than erroring on a rule that
     already exists.
5. **Windows hosts-file entries**: `bringup.sh` uses placeholder domains
   (`api.spaceworker.local` etc., see its `RMM_DOMAIN`/`FRONTEND_DOMAIN`/
   `MESH_DOMAIN`/`ROOT_DOMAIN` vars) so TRMM's own nginx vhost config inside
   the Linux box resolves correctly via the `/etc/hosts` entries `install.sh`
   itself already writes there. For the WINDOWS side (and SpaceWorker's own
   app, wherever it runs) to reach these by the SAME hostnames — needed
   because nginx vhost routing matches on the `Host` header, so hitting a
   raw IP:port without the right Host header may hit the wrong vhost or
   fail — add matching entries to `C:\Windows\System32\drivers\etc\hosts`
   pointing each domain at `127.0.0.1` (requires admin elevation, same as
   the portproxy step). Document this clearly in the status UI's own
   copy ("these domains were added to your hosts file") rather than doing
   it silently — this is exactly the kind of setup change the self-hosted
   plan wants deliberately visible, not silent auto-configuration.
6. **Status UI**: shows bring-up progress (a simple step list: WSL2 check →
   distro provisioning → TRMM install → MeshCentral swap → sw-rmm-core
   deploy → done), the final connection URL + token (to paste into
   SpaceWorker's own setup wizard, TASK_130 §2 step 3), and a "view full log"
   option. Keep it honest about elevation prompts the user will see (UAC for
   portproxy/firewall/hosts-file changes) — explain what's about to happen
   before triggering it, not after.

## §4 — Native Linux path

Simpler than Windows: run `bringup.sh` directly on the host (no WSL2 layer
needed at all — Phase 0 confirmed the installer itself targets Ubuntu
natively). The Tauri app's Linux build still shows the same status UI and
still needs an elevation story for the parts of `bringup.sh` requiring root
(apt installs, systemd units, port binds < 1024 if any — check whether
nginx's ports 80/443 need that). LAN reachability is simpler here too: no
WSL2 NAT layer to work around at all, so §3 item 4's portproxy dance is
Windows-only; a native Linux install just needs its own firewall (ufw/
iptables) opened for the relevant ports if SpaceWorker's own app runs on a
different LAN machine.

## §5 — Honest caveats to surface in-product (per the plan, not optional)

- WSL2 requires Windows 10 2004+/11 and virtualization enabled in firmware —
  not guaranteed on every machine (locked-down corporate hardware). Detect
  this and fail with a clear explanation + point at a manual-Linux-VM
  fallback, rather than a confusing crash.
- State a minimum-spec recommendation (8GB+ RAM) up front — the full stack
  (TRMM + Postgres + nginx + MeshCentral + sw-rmm-core) inside WSL2 has real
  overhead on top of whatever else that Windows machine is doing.

## Verification

- §1's real-VM checkpoint (mandatory, see above) — do this FIRST.
- `tsc`/`cargo build`/`cargo clippy` clean for whatever Rust code lands.
- A full real bring-up on an actual Windows machine with WSL2 (the existing
  `myrat@192.168.0.104` VM per `HOW_WE_MOVE_FAST.md`, or ask the owner) —
  confirm the status UI reaches "done" and the printed connection URL/token
  actually works when pasted into a real SpaceWorker self-hosted install's
  setup wizard (TASK_130).
- A full real bring-up on a real (or fresh VM) native Ubuntu box too.
- **Exit-code warning** (this project's standing lesson): never check a
  command's exit code through a pipe ending in `tail`/`head`/`grep`.

## Deferred / explicitly out of scope for this task

- Phase 5 (flexible-term/admin-cancelable license) and Phase 6 (CI build
  pipeline producing installable `.exe`/`.deb` artifacts for both apps) —
  separate tasks. This task is "does bring-up genuinely work end-to-end
  when run by hand", not "is it packaged for distribution" yet.
- The TRMM commercial-licensing/white-labeling approval question (Phase 0
  finding, folded into the plan) — out of scope while this stays
  personal-use only, per the owner's 2026-09-27 decision.
