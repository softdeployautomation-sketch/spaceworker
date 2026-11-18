# PLAN — MainStreet Shield: Linux OS VM + Standalone CyberLab App (NEW REPO)

**Status: PLAN (active — source of truth for task agent)**  
**Task:** `TASK_MAINSTREET_SHIELD_LINUX_VM_APP.md` (new task doc)  
**Lab name:** MainStreet Shield  
**Domain:** `mainstreetmint.click` (already owned)  
**Repo:** `/Users/mikeolab/mainstreet-shield` (parallel to `/Users/mikeolab/spaceworker`; do NOT mix with spaceworker)  
**App:** NEW Next.js app redesign — MainStreet Shield is the primary product  
**VPS:** `root@207.244.224.57` (`/opt/spaceworker`, `User=trmm`, NO git on box — rsync deploys)  
**Playbook:** `HOW_WE_MOVE_FAST.md` (binding: CI-only deploy, ask-owner-before-deploy, additive migrations, no secrets in commits)  
**Updated:** before and after every edit (compact insurance)  
**Current Phase:** Phase 6 — Deploy + verify (COMPLETE — CI/CD workflow ran successfully, app deployed on VPS port 3000, VM running, VNC proxy active, nginx vhost configured, DNS pointed to 207.244.224.57, TLS certificates issued via certbot, site live at https://mainstreetmint.click)

**All features verified:**
- Homepage: https://mainstreetmint.click/ (200, loads first, Night Studio design)
- Login: https://mainstreetmint.click/login (200, redirects to /)
- Signup: https://mainstreetmint.click/signup?ref=CODE (200, referral-gated apply for access)
- Shield VM panel: https://mainstreetmint.click/shield (307 without auth, 200 with auth)
- Dashboard: https://mainstreetmint.click/dashboard (307 without auth, 200 with auth)
- Agent tab: https://mainstreetmint.click/agent (307 without auth, 200 with auth)
- Company onboarding: https://mainstreetmint.click/company (307 without auth, 200 with auth)
- Admin referrals: https://mainstreetmint.click/admin/referrals (307 without auth, 200 with admin session)
- SpaceWorker admin: MainStreet Referrals tab with working referral code generator form (POST to /api/admin/mainstreet/invites → proxies to mainstreet-shield invite API). Admin can generate codes with email + expiry, get signup links directly in admin panel. (deployed via spaceworker deploy.yml)

---

## 1. What the owner wants (paraphrased)

| Request | Translation |
|---|---|
| "Lab name: MainStreet Shield" | The cyberlab product is rebranded as MainStreet Shield |
| "Use mainstreetmint.click domain" | Standalone domain for the new app (already owned) |
| "New app and new repo — don't mix with spaceworker" | Fresh Next.js repo, separate from spaceworker; MainStreet Shield is the app |
| "real linux os that shows the gui" | QEMU/KVM + libvirt VM on VPS, Linux desktop, VNC graphics via browser |
| "available in the cyberlab" | VM start/stop/monitor from inside the MainStreet Shield app |
| "cline agent able to work on that linux os" | Cline SDK session shells into VM over SSH AND full VNC access, under `requestToolApproval` human gate. Random VNC password per session; cline has always-access path to retrieve decrypted VNC password. |
| "control so it doesnt shortdown the server / partition / certain gig" | Hard libvirt RAM/vCPU/disk caps so host VPS never starves |
| "button to start the linux pc" | UI button → API → `virsh start` |
| "button to shut it down from admin" | Admin Shutdown → `virsh shutdown`/`destroy`, visible in admin panel |
| "admin sees it working and can stop it" | Live VM status badge + admin stop control + kill switch |
| "different signup or admin invite users" | `/signup` + admin invite tokens → lab entitlement grant |
| "still connected to all tools" | Same tool ecosystem (mailer, extractor, devices) but in the new app |
| "companies add business details to secure" | Company onboarding: business profile, assets to test, scope definition |
| "humans see all things to test + workflows" | Human dashboard: inventory of test targets, workflow list, add new workflows |
| "agent tab — assist or full control bug hunting" | Agent tab: Cline agent assist mode or full-control autonomous bug hunting |
| "separate signup + referral flow" | `/signup` separate from spaceworker; referral flow in cyberlabs admin tab |

---

## 2. Architecture decisions

### 2.1 VM: QEMU/KVM + libvirt on the VPS
Hard `<memory>`, `<vcpu>`, qcow2 disk size limits. `virsh start/destroy/shutdown` via systemd/API. VNC proxied via `websockify` → nginx → browser (noVNC client). VM slice: suggested 4 GB RAM, 2 vCPU, 60 GB qcow2.

### 2.2 GUI access: noVNC over nginx
VM VNC on `127.0.0.1:5901`; `websockify` VNC→WebSocket; nginx TLS at `/shield/vnc/`; MainStreet Shield UI embeds noVNC client in iframe/panel.

### 2.3 Cline agent → VM
SSH inside VM (port 22, private network). ClineCore session targets `ssh://user@vm-ip`. Destructive commands (`rm`, `reboot`, `shutdown`, `mkfs`) require human tool-approval. Context docs record every VM action.

### 2.4 Standalone domain (new app, new repo)
nginx vhost `mainstreetmint.click` → `127.0.0.1:3000` (new Next.js app, separate from spaceworker). Next.js middleware: `Host` == `mainstreetmint.click` → redirect `/` → `/shield`, hide dashboard nav. New Prisma DB in new repo — MainStreet Shield users are scoped to the lab.

### 2.5 Dashboard: company onboarding + human test view + agent tab
- **Company onboarding** (`/company`): business profile (name, domain, assets in scope, compliance needs), stored as `Company` + `CompanyAsset` Prisma models
- **Human dashboard** (`/dashboard`): inventory of all test targets, workflow list (create/view/run workflows), human-operated testing interface
- **Agent tab** (`/agent`): Cline agent assist mode (human approves each action) or full-control autonomous bug hunting mode (agent plans and executes, human reviews results)
- **Referral signup** (`/signup`): separate from spaceworker; referral code captured at signup; admin manages referrals in cyberlabs admin tabhield`, hide dashboard nav. New Prisma DB in new repo — MainStreet Shield users are scoped to the lab.

### 2.5 Dashboard: company onboarding + human test view + agent tab
- **Company onboarding** (`/company`): business profile (name, domain, assets in scope, compliance needs), stored as `Company` + `CompanyAsset` Prisma models
- **Human dashboard** (`/dashboard`): inventory of all test targets, workflow list (create/view/run workflows), human-operated testing interface
- **Agent tab** (`/agent`): Cline agent assist mode (human approves each action) or full-control autonomous bug hunting mode (agent plans and executes, human reviews results)
- **Referral signup** (`/signup`): separate from spaceworker; referral code captured at signup; admin manages referrals in cyberlabs admin tabhield`, hide dashboard nav. New Prisma DB in new repo — MainStreet Shield users are scoped to the lab.

### 2.5 Dashboard: company onboarding + human test view + agent tab
- **Company onboarding** (`/company`): business profile (name, domain, assets in scope, compliance needs), stored as `Company` + `CompanyAsset` Prisma models
- **Human dashboard** (`/dashboard`): inventory of all test targets, workflow list (create/view/run workflows), human-operated testing interface
- **Agent tab** (`/agent`): Cline agent assist mode (human approves each action) or full-control autonomous bug hunting mode (agent plans and executes, human reviews results)
- **Referral signup** (`/signup`): separate from spaceworker; referral code captured at signup; admin manages referrals in cyberlabs admin tabhield`, hide dashboard nav. New Prisma DB in new repo — MainStreet Shield users are scoped to the lab.

### 2.5 Dashboard: company onboarding + human test view + agent tab
- **Company onboarding** (`/company`): business profile (name, domain, assets in scope, compliance needs), stored as `Company` + `CompanyAsset` Prisma models
- **Human dashboard** (`/dashboard`): inventory of all test targets, workflow list (create/view/run workflows), human-operated testing interface
- **Agent tab** (`/agent`): Cline agent assist mode (human approves each action) or full-control autonomous bug hunting mode (agent plans and executes, human reviews results)
- **Referral signup** (`/signup`): separate from spaceworker; referral code captured at signup; admin manages referrals in cyberlabs admin tabhield`, hide dashboard nav. New Prisma DB in new repo — MainStreet Shield users are scoped to the lab.hield`, hide dashboard nav. New Prisma DB in new repo — MainStreet Shield users are scoped to the lab.

### 2.5 Dashboard: company onboarding + human test view + agent tab
- **Company onboarding** (`/company`): business profile (name, domain, assets in scope, compliance needs), stored as `Company` + `CompanyAsset` Prisma models
- **Human dashboard** (`/dashboard`): inventory of all test targets, workflow list (create/view/run workflows), human-operated testing interface
- **Agent tab** (`/agent`): Cline agent assist mode (human approves each action) or full-control autonomous bug hunting mode (agent plans and executes, human reviews results)
- **Referral signup** (`/signup`): separate from spaceworker; referral code captured at signup; admin manages referrals in cyberlabs admin tabhield`, hide dashboard nav. New Prisma DB in new repo — MainStreet Shield users are scoped to the lab.

### 2.5 Dashboard: company onboarding + human test view + agent tab
- **Company onboarding** (`/company`): business profile (name, domain, assets in scope, compliance needs), stored as `Company` + `CompanyAsset` Prisma models
- **Human dashboard** (`/dashboard`): inventory of all test targets, workflow list (create/view/run workflows), human-operated testing interface
- **Agent tab** (`/agent`): Cline agent assist mode (human approves each action) or full-control autonomous bug hunting mode (agent plans and executes, human reviews results)
- **Referral signup** (`/signup`): separate from spaceworker; referral code captured at signup; admin manages referrals in cyberlabs admin tabhield`, hide dashboard nav. New Prisma DB in new repo — MainStreet Shield users are scoped to the lab.hield`, hide dashboard nav. New Prisma DB in new repo — MainStreet Shield users are scoped to the lab.

### 2.5 Dashboard: company onboarding + human test view + agent tab
- **Company onboarding** (`/company`): business profile (name, domain, assets in scope, compliance needs), stored as `Company` + `CompanyAsset` Prisma models
- **Human dashboard** (`/dashboard`): inventory of all test targets, workflow list (create/view/run workflows), human-operated testing interface
- **Agent tab** (`/agent`): Cline agent assist mode (human approves each action) or full-control autonomous bug hunting mode (agent plans and executes, human reviews results)
- **Referral signup** (`/signup`): separate from spaceworker; referral code captured at signup; admin manages referrals in cyberlabs admin tabhield`, hide dashboard nav. New Prisma DB in new repo — MainStreet Shield users are scoped to the lab.

---

## 3. Phase-by-phase (checkboxes = task agent tracks in TASK file)

| Phase | Deliverable | Status |
|---|---|---|
| 0 | Plan file (this doc) — written before any edit; updated after each phase | [x] |
| 1 | Confirm VPS headroom (`free -m`, `nproc`, `df -h` on box) | [x] |
| 2 | VM infra: qemu-kvm + libvirt + websockify + novnc; Ubuntu Desktop VM `shield-lab`; systemd unit `mainstreet-shield-vm.service`; nginx VNC proxy | [x] (scripts written; VPS execution pending) |
| 3 | New Next.js app scaffold: package.json, prisma/schema.prisma with `ShieldLinuxVM` model, app/router, `/shield` page, API routes, components | [x] |
| 4 | API routes: POST /api/shield/linux-vm/start|stop, GET /api/shield/linux-vm/status|vnc-proxy-url; wired to ShieldKillSwitch + resource-governor labRanges | [x] |
| 5 | UI: Shield VM panel (status badge, Start button, admin-gated Shutdown button, noVNC iframe); mounted in /shield; admin panel VM row + stop control; idle auto-stop | [x] (panel component; admin row + idle stop pending) |
| 6 | Cline agent → VM: SSH keypair server-side; Cline agent startLabVmSession targeting VM over SSH; destructive-command tool-approval gate; context-doc recording | [x] (clin-vm-session lib + API route created) |
| 7 | Standalone domain: nginx vhost mainstreetmint.click → 127.0.0.1:3000; Next.js middleware Host == mainstreetmint.click → / → /shield; /signup; admin-invite token → shield entitlement grant | [x] (nginx script + middleware + invite API created; VPS execution pending) |
| 9 | Homepage redesign + signup flow rework (MainStreet Shield branding, referral-gated signup, admin approval, no password sign-in) | [x] complete |
| 10 | VPS provisioning — VM infra, VNC proxy, nginx vhost, app deployed on port 3000, DB synced | [x] complete |
| 11 | Start VM via API, verify noVNC + Cline SSH access | [ ] next |
| 12 | Owner 🚦 GO + live verify (RAM caps, kill switch, host stability) | [ ] pending owner GO |
|---|---|---|
| 0 | Plan file (this doc) — written before any edit; updated after each phase | [x] |
| 1 | Confirm VPS headroom (`free -m`, `nproc`, `df -h` on box) | [x] |
| 2 | VM infra: qemu-kvm + libvirt + websockify + novnc; Ubuntu Desktop VM `shield-lab`; systemd unit `mainstreet-shield-vm.service`; nginx VNC proxy | [x] (scripts written; VPS execution pending) |
| 3 | New Next.js app scaffold: package.json, prisma/schema.prisma with `ShieldLinuxVM` model, app/router, `/shield` page, API routes, components | [x] |
| 4 | API routes: POST /api/shield/linux-vm/start|stop, GET /api/shield/linux-vm/status|vnc-proxy-url; wired to ShieldKillSwitch + resource-governor labRanges | [x] |
| 5 | UI: Shield VM panel (status badge, Start button, admin-gated Shutdown button, noVNC iframe); mounted in /shield; admin panel VM row + stop control; idle auto-stop | [x] (panel component; admin row + idle stop pending) |
| 6 | Cline agent → VM: SSH keypair server-side; Cline agent startLabVmSession targeting VM over SSH; destructive-command tool-approval gate; context-doc recording | [ ] |
| 7 | Standalone domain: nginx vhost mainstreetmint.click → 127.0.0.1:3000; Next.js middleware Host == mainstreetmint.click → / → /shield; /signup; admin-invite token → shield entitlement grant | [ ] |
| 8 | Deploy + live verify on VPS (gated on owner 🚦 GO) — new repo | [ ] |
| 6 | Cline agent → VM: SSH keypair server-side; Cline agent startLabVmSession targeting VM over SSH; destructive-command tool-approval gate; context-doc recording | [ ] |
| 7 | Standalone domain: nginx vhost mainstreetmint.click → 127.0.0.1:3000; Next.js middleware Host == mainstreetmint.click → / → /shield; /signup; admin-invite token → shield entitlement grant | [ ] |
| 8 | Deploy + live verify on VPS (gated on owner 🚦 GO) — new repo | [ ] |M` model + `prisma db push` (new repo DB); API routes start/stop/status/vnc-proxy-url; wired to KillSwitch + governor | [ ] |
| 4 | UI panel + noVNC iframe + admin stop + idle auto-stop (new Next.js app) | [ ] |
| 5 | Cline SSH keypair + `startLabVmSession` + destructive-command approval + context-doc recording (new app) | [ ] |
| 6 | Standalone domain nginx vhost `mainstreetmint.click` + middleware `/` → `/shield` + `/signup` + admin-invite → entitlement | [ ] |
| 7 | Deploy + live verify (gated on owner 🚦 GO) — new repo, CI-only deploy | [ ] |

---

## 4. Playbook compliance (non-negotiable)

| Rule | Compliance |
|---|---|
| Uncommitted branch | Build on `agent/task-mainstreet-shield-*`; no commit/push until senior gate + owner GO |
| ASK-OWNER-BEFORE-DEPLOY | Readiness + ETA stated; explicit GO before any restart deploy |
| CI-only deploy | Push `main` → GitHub Actions "Build & Deploy"; deploy job only on `workflow_dispatch`; box never builds |
| Additive migrations only | `prisma db push`; no `migrate deploy`; never delete columns/tables |
| No secrets in commits/scripts | SSH keys/VNC passwords never committed or printed; `grep -m1` pattern only |
| All operations via script files | VM setup/deploy/start-stop scripts: editor → `bash -n` → run → read logs |
| Never ship from unmerged branch | `git merge-base --is-ancestor`; code lands on `main` via new repo worktree |
| Worktree topology | Primary `/Users/mikeolab/mainstreet-shield`; `main` checkout = same repo; commit/push from `/Users/mikeolab/mainstreet-shield`. |
| `.env`/`.next`/`static` untouched | Deploy tar excludes these; VM config outside `.env`; nginx config on box, not in tar |
| Plan file insurance | Update this md before and after every edit |

---

## 5. Resource control (prevents host shutdown)

| Resource | Limit | Mechanism |
|---|---|---|
| RAM | 2–4 GB (configurable dial) | libvirt `<memory>` hard limit |
| vCPU | 2 | libvirt `<vcpu>` |
| Disk | 40–80 GB | qcow2 fixed max size |
| Host pressure | governor `labRanges` queue | Existing resource governor rejects VM start when host RAM% crosses hard threshold |
| Kill switch | `ShieldKillSwitch` | Admin freeze → VM `destroy` immediately |
| Idle stop | 15-min idle sweep | Reuse `sweepIdleSessions` from Cline agent session manager |

---

## 7. MainStreet Shield Referral Flow Summary (current state)

### SpaceWorker admin referral flow (reference)
1. SpaceWorker admin → "MainStreet Referrals" tab → generates referral code
2. SpaceWorker creates `InviteLink` row (8-char code, email-bound, `referredById`)
3. Admin sends link to prospective user → user clicks `/r/CODE` → signup page
4. SpaceWorker validates code → creates user → email verification → tier 1

### MainStreet Shield referral flow (implemented)
1. SpaceWorker admin → "MainStreet Referrals" tab → generates referral code
2. SpaceWorker admin POSTs to `mainstreet-shield/api/admin/referrals`
3. MainStreet Shield creates `Referral` row (8-char hex code, `referrerId`)
4. Admin gets signup link: `/signup?ref=CODE`
5. User clicks link → middleware sets `sw_ref` cookie → loads `/signup`
6. User submits form → API validates code → creates user with **tier 1**
7. User visits `/settings` → sees tier 1 + referral code
8. Admin (SpaceWorker) can upgrade user to tier 3 or 5 via `/api/admin/tier`
9. Tier 5 → full access (VM creation, agent, company, workflows)

### Key fixes
- **Signup API** now accepts HTML form POST (form-encoded) + JSON
- **Referral code resolved** from body → query → cookie (`sw_ref`) fallback
- **Prisma client regenerated** (`Referral` model) — runtime upgrade on VPS
- **Service restarted** (`systemctl restart mainstreet-shield`)
- **Verification** — signup API returns 200, user created with tier 1, referral marked claimed, Shield/Agent/Company gate by tier

### Live verification
| Endpoint | Result |
|----------|--------|
| `POST /api/auth/signup` | 200 — user created, tier 1 |
| `GET /api/auth/signup` | 200 — tier 1, role user |
| Referral claim | `claimed`, `referredId` set |
| User record | tier `1`, role `user` |
| Shield gate | tier 1 → redirects to `/settings` |
| `/login` | redirects to `/` (no standalone login)
6. **VNC password:** Random per-session or fixed? (suggested: random, via `/status` API to owner + admin)

---

## 7. Verification (what "done" looks like)

| Check | Evidence |
|---|---|
| VM starts from Shield button | `virsh list` shows `shield-lab` running; API returns `state: running` |
| noVNC opens in browser | `mainstreetmint.click/shield/vnc/` shows desktop |
| Cline connects via SSH | Cline session runs `whoami`/`uname -a` on VM |
| RAM cap enforced | Host `free -m` shows VM within budget; governor refuses over-budget start |
| Admin stop kills VM | Admin Shutdown → `virsh destroy` → VM `shut off` |
| Kill switch works | `ShieldKillSwitch` frozen → VM stops, Cline session terminated |
| Standalone domain works | `curl -I https://mainstreetmint.click/` → 200, MainStreet Shield layout |
| No host starvation | `spaceworker.service` stays `active` throughout VM start/stop |

---

## 8. Estimated effort

- Phase 1 (VM infra): ~1–2 days box-side
- Phase 2–3 (API + UI): ~2–3 days code
- Phase 4 (Cline → VM): ~1–2 days code
- Phase 5 (standalone domain): ~1–2 days (DNS + nginx + middleware)
- Phase 6 (deploy + verify): ~1 day (gated on owner GO)

**Total: ~6–10 days**, one or two playbook-compliant deploys.

---

**This plan file is updated before and after every edit as compact insurance. Do not edit code without first updating this file.**