# Task — MainStreet Shield: Linux OS VM + Standalone CyberLab App (NEW REPO)

**Status: BUILD COMPLETE — GitHub repo public, homepage + signup rework done, awaiting owner GO for VPS deploy**  
**Plan doc:** `PLAN_CYBERLAB_LINUX_OS_AND_STANDALONE.md` (source of truth)  
**Lab name:** MainStreet Shield  
**Domain:** `mainstreetmint.click` (already owned)  
**Repo:** `/Users/mikeolab/mainstreet-shield` (parallel to `/Users/mikeolab/spaceworker`; do NOT mix with spaceworker)  
**App:** NEW Next.js app redesign — MainStreet Shield is the primary product  
**VPS:** `root@207.244.224.57` (`/opt/spaceworker`, `User=trmm`, NO git on box — rsync deploys)  
**Task-agent branch convention:** `agent/task-mainstreet-shield-*` (uncommitted until senior gate + owner GO)  
**Playbook:** `HOW_WE_MOVE_FAST.md` (binding: CI-only deploy, ask-owner-before-deploy, additive migrations, no secrets in commits)

---

## Goal

Build two connected capabilities inside the new MainStreet Shield app (new repo, separate from spaceworker):

---

## Read first (mandatory, task agent)

- **`HOW_WE_MOVE_FAST.md`** §0–§3 — CI-only deploy reality, deploy paths, worktree topology, `.env`/`.next`/`static` never touched by deploy tar, all operations via script files.
- **`PROMPT_NEXT_AGENT.md`** — current queue + build order; task-agent pattern = build uncommitted on `agent/task-NNN-*` branches, senior lane reviews/gates/commits, ships after owner's 🚦 GO.
- **`PROMPT_SENIOR_VERIFICATION_AGENT.md`** §1 — deploy paths, ASK-OWNER-BEFORE-DEPLOY rule, worktree topology, never ship from unmerged branch.
- **`PLAN_CYBERLAB_LINUX_OS_AND_STANDALONE.md`** — the full architecture & phase plan (this task's source of truth).
- VPS has no git — `/opt/spaceworker` is an rsync target. Deploy = push to `main` → GitHub Actions "Build & Deploy" → owner triggers `workflow_dispatch`.
- **NEW REPO**: All code goes into `/Users/mikeolab/mainstreet-shield` (new repo, separate from spaceworker). Do NOT edit `/Users/mikeolab/spaceworker` for this task.

1. **A real Linux OS VM with GUI** running on the VPS (QEMU/KVM + libvirt, Ubuntu Desktop, hard RAM/CPU/disk caps so it cannot shut down the server), startable and stoppable from buttons inside `/shield`, with an admin shutdown button, live VM status visible to admin, and Cline SDK agent access to the VM (SSH + human tool-approval gate).

---

## Deliverables

| # | Deliverable | Phase |
|---|---|---|
| D1 | VM infra on VPS: qemu-kvm + libvirt + websockify + novnc; Ubuntu Desktop VM `shield-lab` (4 GB RAM, 2 vCPU, 60 GB qcow2, VNC :5901); systemd unit `mainstreet-shield-vm.service`; nginx VNC proxy | Phase 1 |
| D2 | Prisma `ShieldLinuxVM` model + `prisma db push` (new repo DB); API routes `POST /api/shield/linux-vm/start|stop`, `GET /api/shield/linux-vm/status|vnc-proxy-url`; wired to `ShieldKillSwitch` + resource-governor `labRanges` | Phase 2 |
| D3 | UI: Shield VM panel (status badge, Start button, admin-gated Shutdown button, noVNC iframe); mounted in new app `/shield`; admin panel VM row + stop control; idle auto-stop | Phase 3 |
| D4 | Cline agent → VM: SSH keypair server-side; Cline agent `startLabVmSession` targeting VM over SSH; destructive-command tool-approval gate; context-doc recording | Phase 4 |
| D5 | Standalone domain: nginx vhost `mainstreetmint.click` → `127.0.0.1:3000`; Next.js middleware `Host` == mainstreetmint.click → `/` → `/shield`; `/signup`; admin-invite token → `shield` entitlement grant | Phase 5 |
| D6 | Deploy + live verify on VPS (gated on owner 🚦 GO) — new repo | Phase 6 |

---

## Plan (before edits) — task agent follows this order

The task agent works **uncommitted** on branch `agent/task-mainstreet-shield-1` until the senior lane gates and the owner gives 🚦 GO. No code is pushed or deployed without owner approval.

- [ ] **0. Plan file.** Confirm `PLAN_CYBERLAB_LINUX_OS_AND_STANDALONE.md` reflects new app/repo/domain. Update after each phase.
- [ ] **1. Confirm VPS headroom.** `free -m`, `nproc`, `df -h` on `207.244.224.57` to confirm 4 GB RAM / 2 vCPU / 60 GB headroom for the VM.
- [ ] **2. Create new repo.** `mkdir -p /Users/mikeolab/mainstreet-shield`, `git init`, remote to `softdeploy/mainstreet-shield` on GitHub.
- [ ] **3. Phase 1 — VM infra (box-side, no app code).** Write and run a box script: install `qemu-kvm libvirt-daemon-system virtinst websockify novnc`; create Ubuntu Desktop VM `shield-lab` (4 GB / 2 vCPU / 60 GB qcow2, VNC :5901); create systemd unit `mainstreet-shield-vm.service`; nginx + websockify VNC proxy; verify `virsh list`, noVNC loads in browser, host unaffected.
- [ ] **4. Phase 2 — Schema + API (new repo).** Add `ShieldLinuxVM` Prisma model (additive); `prisma db push` on new repo DB; create API routes under new app; wire `ShieldKillSwitch` + `resource-governor.labRanges`; `npx tsc --noEmit` clean + test suite green.
- [ ] **5. Phase 3 — Shield UI.** Create VM panel component; mount in new app `/shield`; add admin panel VM row + stop control; idle auto-stop.
- [ ] **6. Phase 4 — Cline → VM.** Server-side SSH keypair (never committed); extend Cline agent with `startLabVmSession` targeting VM over SSH; destructive-command tool-approval gate; context-doc recording.
- [ ] **7. Phase 5 — Standalone domain.** nginx vhost for `mainstreetmint.click`; Next.js middleware `mainstreetmint.click` → `/` → `/shield`, hide dashboard nav; `/signup`; admin-invite token → `shield` entitlement.
- [ ] **8. Phase 6 — Deploy + verify.** Commit on `main` via new repo worktree (never unmerged branch); state readiness + ETA; wait for owner 🚦 GO; push → `gh workflow run 'Build & Deploy'`; owner triggers `workflow_dispatch`; live verify on VPS (start VM → noVNC → Cline SSH → stop VM → RAM caps hold → `spaceworker.service` active).
2. **A standalone MainStreet Shield website** on `mainstreetmint.click` served from the new Next.js app via a separate nginx vhost, Shield-first entry (`/` → `/shield`), with signup and/or admin-invite flow, connected to all tools (mailer, extractor, devices).

---

## Playbook rules the task agent MUST follow (non-negotiable)

| Rule | Requirement |
|---|---|
| **Uncommitted branch** | Build on `agent/task-mainstreet-shield-*`, do NOT commit/push until senior gate + owner GO. |
| **ASK-OWNER-BEFORE-DEPLOY** | Before any deploy that restarts `spaceworker`, state readiness + ETA and wait for explicit owner GO. Never deploy un-asked. |
| **CI-only deploy** | Push to `main` → GitHub Actions "Build & Deploy"; deploy job runs only on `workflow_dispatch`. Box never builds. |
| **Additive migrations only** | New Prisma model via `prisma db push`; no `migrate deploy`; never delete columns/tables. |
| **No secrets in commits/scripts** | SSH keys, VNC passwords never committed or printed; read via `grep -m1` pattern only. |
| **All operations via script files** | VM setup, deploy, start/stop scripts written with editor, `bash -n`, run, read logs. No long interactive terminal sessions. |
| **Never ship from unmerged branch** | Verify with `git merge-base --is-ancestor`; all code lands on `main` via new repo worktree. |
| **Worktree topology** | Primary `/Users/mikeolab/mainstreet-shield`; `main` checkout = same repo; commit/push from `/Users/mikeolab/mainstreet-shield`. |
| **`.env` / `.next` / `static` untouched** | Deploy tar never includes `.env`, `.next/`, `static/`; VM config lives outside `.env`; nginx config on box, not in tar. |
| **Plan file insurance** | Before and after every edit, update the plan md file (`PLAN_CYBERLAB_LINUX_OS_AND_STANDALONE.md`) as compact insurance. |

---

## Acceptance / verification (what "done" looks like)

| Check | Evidence |
|---|---|
| VM starts from Shield button | `virsh list` shows `shield-lab` running; API returns `state: running` |
| noVNC opens in browser | `mainstreetmint.click/shield/vnc/` shows desktop |
| Cline connects via SSH | Cline session runs `whoami`/`uname -a` on VM |
| RAM cap enforced | Host `free -m` shows VM within budget; governor refuses over-budget starts |
| Admin stop kills VM | Admin Shutdown → `virsh destroy` → VM `shut off` |
| Kill switch works | `ShieldKillSwitch` frozen → VM stops, Cline session terminated |
| Standalone domain works | `curl -I https://mainstreetmint.click/` → 200, MainStreet Shield layout |
| No host starvation | `spaceworker.service` stays `active` throughout VM start/stop |
| Code quality | `npx tsc --noEmit` → 0 errors; eslint clean; test suite green |

---

## Open questions (task agent should NOT assume; owner to answer)

1. **VM size:** RAM/CPU/disk? (suggested: 4 GB / 2 vCPU / 60 GB)
2. **Linux distro:** Ubuntu Desktop, Debian XFCE, or lightweight? (suggested: Ubuntu Desktop)
3. **Cline access:** SSH-only for commands, or also VNC desktop control? (suggested: SSH first)
4. **Signup flow:** Separate `/signup` for MainStreet Shield, or `/shield` landing creating an account with `shield` entitlement?
5. **Admin invites:** Admin invite codes, or auto-approve mainstreetmint.click signups?
6. **VNC password:** Random per-session or fixed? (suggested: random, via `/status` API to owner + admin)

## Handoff → senior verification agent

When all phases are complete and code is on `main`:

1. Task agent reports completion with evidence (tsc 0, tests green, deploy run ID, BUILD_ID).
2. Senior lane reviews diff, gates, commits with attribution, merges to `main` in the new MainStreet Shield repo.
3. Senior agent asks owner for 🚦 GO, then runs `gh workflow run 'Build & Deploy'` in the new repo.
4. After CI green, owner triggers deploy job (`workflow_dispatch`).
5. Verification agent runs live probes on the VPS (all acceptance checks above) and updates the task's `_STEPS.md` before reporting.

---

**Task agent: do not start editing until you have read `PLAN_CYBERLAB_LINUX_OS_AND_STANDALONE.md` (Phase 0 deliverable), confirmed VPS headroom (step 1), and confirmed the new repo location (step 2). All edits are uncommitted until the senior lane + owner gate. Do NOT edit `/Users/mikeolab/spaceworker` — this is a new repo.**