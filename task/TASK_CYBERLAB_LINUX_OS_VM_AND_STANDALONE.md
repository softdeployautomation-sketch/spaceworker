# Task — Cyber Lab Linux OS VM + Standalone CyberLab Website

**Status: READY FOR TASK AGENT (plan phase)**  
**Plan doc:** `PLAN_CYBERLAB_LINUX_OS_AND_STANDALONE.md` (to be written in repo)  
**Repo:** `/Users/mikeolab/spaceworker` (primary tree), `main` in `/Users/mikeolab/sw-vbsfix`  
**VPS:** `root@207.244.224.57` (`/opt/spaceworker`, `User=trmm`, NO git on box — rsync deploys)  
**Task-agent branch convention:** `agent/task-cyberlab-linux-vm-standalone-*` (uncommitted until senior gate + owner GO)  
**Playbook:** `HOW_WE_MOVE_FAST.md` (binding: CI-only deploy, ask-owner-before-deploy, additive migrations, no secrets in commits)

---

## Goal

Build two connected capabilities inside the Cyber Lab:

1. **A real Linux OS VM with GUI** running on the VPS (QEMU/KVM + libvirt, Ubuntu Desktop, hard RAM/CPU/disk caps so it cannot shut down the server), startable and stoppable from buttons inside `/cyberlab`, with an admin shutdown button, live VM status visible to admin, and Cline SDK agent access to the VM (SSH + human tool-approval gate).
2. **A standalone CyberLab website** on its own domain (`cyberlabsecurity.help` or `.sbs`, owner's choice) served from the same Next.js app via a separate nginx vhost, CyberLab-first entry (`/` → `/cyberlab`), with optional separate signup and/or admin-invite flow, still connected to all existing tools (mailer, extractor, devices, CyberLab API).

---

## Read first (mandatory, task agent)

- **`HOW_WE_MOVE_FAST.md`** §0–§3 — CI-only deploy reality, deploy paths, worktree topology, `.env`/`.next`/`static` never touched by deploy tar, all operations via script files.
- **`PROMPT_NEXT_AGENT.md`** — current queue + build order; task-agent pattern = build uncommitted on `agent/task-NNN-*` branches, senior lane reviews/gates/commits, ships after owner's 🚦 GO.
- **`PROMPT_SENIOR_VERIFICATION_AGENT.md`** §1 — deploy paths, ASK-OWNER-BEFORE-DEPLOY rule, worktree topology, never ship from unmerged branch.
- **`PLAN_CYBERLAB_LINUX_OS_AND_STANDALONE.md`** — the full architecture & phase plan (this task's source of truth).
- Existing CyberLab code to reuse: `lib/lab/cline-agent.ts` (ClineCore session lifecycle, `sweepIdleSessions`, `requestToolApproval`), `lib/lab/engine.ts` (`startLabRun`), `lib/resource-governor.ts` (`labRanges` feature), `lib/lab/gate.ts` (`cyberLabGate`), `app/api/cyberlab/*` routes, `components/cyberlab-agent-console.tsx`, `components/cyberlab-ops-console.tsx`, `app/cyberlab/page.tsx`, Prisma models `LabHost`, `LabRange`, `CyberLabKillSwitch`, `CyberLabAgentSession`, `AdminSetting.cyberlab*` dials.

---

## Deliverables

| # | Deliverable | Phase |
|---|---|---|
| D1 | VM infra on VPS: qemu-kvm + libvirt + websockify + novnc; Ubuntu Desktop VM `ubuntu-lab` (4 GB RAM, 2 vCPU, 60 GB qcow2, VNC :5901); systemd unit `spaceworker-cyberlab-vm.service`; nginx VNC proxy | Phase 1 |
| D2 | Prisma model `CyberLabLinuxVM` + additive migration (`prisma db push`); API routes `POST /api/cyberlab/linux-vm/start|stop`, `GET /api/cyberlab/linux-vm/status|vnc-proxy-url`; wired to `CyberLabKillSwitch` + resource-governor `labRanges` | Phase 2 |
| D3 | UI: `components/cyberlab-linux-vm-panel.tsx` (status badge, Start button, admin-gated Shutdown button, noVNC iframe); mounted in `app/cyberlab/page.tsx`; admin panel VM row + stop control; idle auto-stop | Phase 3 |
| D4 | Cline agent → VM: SSH keypair server-side; `cline-agent.ts` `startLabVmSession` targeting VM over SSH; destructive-command tool-approval gate; context-doc recording via `CyberLabContextDocStep` | Phase 4 |
| D5 | Standalone domain: nginx vhost `cyberlabsecurity.help` → `127.0.0.1:3500`; Next.js middleware cyberlab-domain detection → `/` → `/cyberlab`; `/cyberlab/signup` (CyberLab-only tier); admin-invite token flow → `cyberlab` entitlement grant | Phase 5 |
| D6 | Deploy + live verify on VPS (gated on owner 🚦 GO) | Phase 6 |

---

## Playbook rules the task agent MUST follow (non-negotiable)

| Rule | Requirement |
|---|---|
| **Uncommitted branch** | Build on `agent/task-cyberlab-linux-vm-standalone-*`, do NOT commit/push until senior gate + owner GO. |
| **ASK-OWNER-BEFORE-DEPLOY** | Before any deploy that restarts `spaceworker`, state readiness + ETA and wait for explicit owner GO. Never deploy un-asked. |
| **CI-only deploy** | Push to `main` → GitHub Actions "Build & Deploy"; deploy job runs only on `workflow_dispatch`. Box never builds. |
| **Additive migrations only** | New Prisma model via `prisma db push`; no `migrate deploy`; never delete columns/tables. |
| **No secrets in commits/scripts** | SSH keys, VNC passwords never committed or printed; read via `grep -m1` pattern only. |
| **All operations via script files** | VM setup, deploy, start/stop scripts written with editor, `bash -n`, run, read logs. No long interactive terminal sessions. |
| **Never ship from unmerged branch** | Verify with `git merge-base --is-ancestor`; all code lands on `main` via `sw-vbsfix`. |
| **Worktree topology** | Primary = `/Users/mikeolab/spaceworker`; `main` checkout = `/Users/mikeolab/sw-vbsfix`; commit/push from `sw-vbsfix`. |
| **`.env` / `.next` / `static` untouched** | Deploy tar never includes `.env`, `.next/`, `static/`; VM config lives outside `.env`; nginx config on box, not in tar. |
| **Plan file insurance** | Before and after every edit, update the plan md file (`PLAN_CYBERLAB_LINUX_OS_AND_STANDALONE.md`) as compact insurance. |

---

## Acceptance / verification (what "done" looks like)

| Check | Evidence |
|---|---|
| VM starts from CyberLab button | `virsh list` shows `ubuntu-lab` running; API returns `state: running` |
| noVNC opens in browser | `cyberlabsecurity.help/cyberlab/vnc/` (or spaceworker.top equivalent) shows desktop |
| Cline connects via SSH | Cline session runs `whoami`/`uname -a` on VM successfully |
| RAM cap enforced | Host `free -m` shows VM within allocated budget; governor refuses over-budget starts |
| Admin stop kills VM | Admin Shutdown → `virsh destroy` → VM state `shut off` |
| Kill switch works | `CyberLabKillSwitch` frozen → VM stops, Cline session terminated |
| Standalone domain works | `curl -I https://cyberlabsecurity.help/` → 200, serves CyberLab layout |
| No host starvation | `spaceworker.service` stays `active` throughout VM start/stop |
| Code quality | `npx tsc --noEmit` → 0 errors; eslint clean; lab test suite green |

---

## Open questions (task agent should NOT assume; owner to answer)

1. **Domain:** `cyberlabsecurity.help` vs `.sbs` vs other? Already owned or needs purchase?
2. **VM size:** RAM/CPU/disk? (suggested: 4 GB / 2 vCPU / 60 GB)
3. **Linux distro:** Ubuntu Desktop, Debian XFCE, or lightweight? (suggested: Ubuntu Desktop)
4. **Cline access:** SSH-only for commands, or also VNC-level desktop control? (suggested: SSH first)
5. **CyberLab-only signup:** Separate sign-up flow, or `/cyberlab` landing creating a normal SpaceWorker account with `cyberlab` entitlement?
6. **Admin invites:** Admin generates invite codes, or auto-approve cyberlab-domain signups?
7. **VNC password:** Random per-session or fixed?

---

## Handoff → senior verification agent

When all phases are complete and code is on `main`:

1. Task agent reports completion with evidence (tsc 0, tests green, deploy run ID, BUILD_ID).
2. Senior lane reviews diff, gates, commits with attribution, merges to `main`.
3. Senior agent asks owner for 🚦 GO, then runs `gh workflow run 'Build & Deploy' -R softdeployautomation-sketch/spaceworker`.
4. After CI green, owner triggers deploy job (`workflow_dispatch`).
5. Verification agent runs live probes on the VPS (all acceptance checks above) and updates the task's `_STEPS.md` before reporting.

---

**Task agent: do not start editing until you have read `PLAN_CYBERLAB_LINUX_OS_AND_STANDALONE.md` (Phase 0 deliverable) and confirmed VPS headroom (step 1). All edits are uncommitted until the senior lane + owner gate.**

---

## Plan (before edits) — task agent follows this order

The task agent works **uncommitted** on branch `agent/task-cyberlab-linux-vm-standalone-1` until the senior lane gates and the owner gives 🚦 GO. No code is pushed or deployed without owner approval.

- [ ] **0. Plan file.** Write `PLAN_CYBERLAB_LINUX_OS_AND_STANDALONE.md` in repo root (insurance before editing). Update after each phase.
- [ ] **1. Confirm VPS headroom.** `free -m`, `nproc`, `df -h` on `207.244.224.57` to confirm 4 GB RAM / 2 vCPU / 60 GB headroom for the VM.
- [ ] **2. Phase 1 — VM infra (box-side, no app code).** Write and run a box script: install `qemu-kvm libvirt-daemon-system virtinst websockify novnc`; create Ubuntu Desktop VM `ubuntu-lab` (4 GB / 2 vCPU / 60 GB qcow2, VNC :5901); create systemd unit `spaceworker-cyberlab-vm.service`; nginx + websockify VNC proxy; verify `virsh list`, noVNC loads in browser, host unaffected.
- [ ] **3. Phase 2 — Schema + API.** Add `CyberLabLinuxVM` Prisma model (additive); `prisma db push` on dev DB; create API routes under `app/api/cyberlab/linux-vm/`; wire `CyberLabKillSwitch` + `resource-governor.labRanges`; `npx tsc --noEmit` clean + lab test suite green.
- [ ] **4. Phase 3 — CyberLab UI.** Create `components/cyberlab-linux-vm-panel.tsx`; mount in `app/cyberlab/page.tsx`; add admin panel VM row + stop control; idle auto-stop reuse `sweepIdleSessions` pattern.
- [ ] **5. Phase 4 — Cline → VM.** Server-side SSH keypair (never committed); extend `cline-agent.ts` with `startLabVmSession` targeting VM over SSH; destructive-command tool-approval gate; context-doc recording.
- [ ] **6. Phase 5 — Standalone domain.** nginx vhost for `cyberlabsecurity.help` (owner picks domain); Next.js middleware cyberlab-domain → `/` → `/cyberlab`, hide dashboard nav; `/cyberlab/signup`; admin-invite token → `cyberlab` entitlement.
- [ ] **7. Phase 6 — Deploy + verify.** Commit on `main` via `sw-vbsfix` (never unmerged branch); state readiness + ETA; wait for owner 🚦 GO; push → `gh workflow run 'Build & Deploy'`; owner triggers `workflow_dispatch`; live verify on VPS (start VM → noVNC → Cline SSH → stop VM → RAM caps hold → `spaceworker.service` active).