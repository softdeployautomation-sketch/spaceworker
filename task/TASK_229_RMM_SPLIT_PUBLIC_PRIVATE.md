# TASK 229 — RMM split: public staging RMM vs private production RMM

**Scoped by:** Senior Verification lane (analysis of the live box + both repos)
**Date:** 2026-10-18
**Status:** SCOPED — needs owner's option choice before any build.
**Deploys after:** TASK_228 (public-on-top / manual move) — already live.

---

## §1 Owner's directive (intent)

1. `instaweb.top` is **public only** — public install links, public domain, the public
   staging RMM. It must **never** appear in **private** agent traffic or in the web app.
2. A public device first lands on a **light / terminal-only RMM** (features don't matter).
3. Once verified there, we **install the private agent** onto the good RMM; once it's saved
   in private, we **delete the device from the public RMM** (public = disposable staging).
4. **Stable agent first.** User moves a device to private **manually, when it's stable and
   they can watch the movement.** No auto-move.
5. Devices that can't come back online: **stay public, sorted on top, never auto-moved.**
   *(This is already delivered by TASK_228 — see §2a.)*

---

## §2 Current architecture — VERIFIED on box (2026-10-18)

There is **one** TacticalRMM backend (one Django + one Postgres + one NATS) and **one**
MeshCentral. "Public vs private" today is only a **client/site grouping + a hostname swap**
on the agent's `BaseURL`/`ApiURL` — both hostnames proxy to the *same* backend.

| Concern | Env (Vantra `.env`) | Hostname | Public or Private |
|---|---|---|---|
| Agent API — public | `TRMM_PUBLIC_API_BASE_URL` | `agent.instaweb.top` | public |
| Agent API — private | `TRMM_PRIVATE_API_BASE_URL` | `agent.broks.beauty` | private ✅ clean |
| **Server→TRMM client** | `TRMM_API_BASE_URL` | **`api.instaweb.top`** | **SHARED — leak (web app)** |
| **MeshCentral** | `MESH_WSS_URL` | **`mesh.instaweb.top`** | **SHARED — leak (all agents)** |
| Vantra app | `APP_BASE_URL` | `vantra.spaceworker.top` | — |
| SpaceWorker app | `APP_BASE_URL` | `spaceworker.top` | — |
| Mesh frame origins | `MESH_FRAME_ORIGINS` | `mesh.spaceworker.top` | — |

TRMM `local_settings.py` `server_name`s (all front the ONE backend):
`agent.broks.beauty · agent.instaweb.top · api.instaweb.top · api.spaceworker.top · instaweb.top · mesh.instaweb.top`

**Confirmed leaks** (private sees `instaweb.top` today):
- **`mesh.instaweb.top`** — every agent's Mesh agent installs against it (no private variant).
- **`api.instaweb.top`** — Vantra's server-side TRMM client calls here (web-app code).
- (`agent.instaweb.top` is already avoided for private via the move's `BaseURL` rewrite.)

### §2a — What TASK_228 already delivers (do not rebuild)
Public devices sort **on top**, `Public` badge shown, **no quarantine, no auto-move**, one
manual **Move to private** button. Hide is the only automation (+60s, online-only). ✅ live.

---

## §3 The device-online reality (probed 2026-10-18)

- **WilkSF9 (private, PS-installed): ALIVE.** Mesh `conn:1, idle:29`; TRMM `last_seen
  18:45` (most recent of all). Its "disconnect"/tiny-image is a **Neko remote-viewer stream
  issue, not the agent** — see §5. The `TASK_221_…_STEPS.md` hunt doc is **absent from the
  tree** (referenced by `PROMPT_NEXT_AGENT.md` but never committed); only the cursor-hiding
  revert (`071cb84`) survived.
- **4 greenland devices (DRfEtb, svOP, TxMDkpruqOwZE, LMhKUieXI): DEAD on both channels.**
  TRMM `last_seen` 12:48–14:19 (hours stale); Mesh nodes present but **no `conn`**. Neither
  TRMM nor Mesh can reach them → **cannot be moved or recovered remotely.** They need the
  machine powered + agent restarted (physical/other access) or a reinstall. They now sit
  **public-on-top** per 228.


---

## §4 Options for the split

### Option B — Domain hygiene on the ONE instance (RECOMMEND as phase 1, fast)
Keep one TRMM + one MeshCentral; give private its **own hostname set**, public its own.
Private then never sees an `instaweb` hostname; the shared backend is **invisible** to it.
- Private: `agent.broks.beauty` (exists) + add `api.broks.beauty` + `mesh.broks.beauty`.
- Public: stays entirely on `instaweb.top`.
- Vantra: `TRMM_API_BASE_URL` → `api.broks.beauty`; `MESH_WSS_URL` → `mesh.broks.beauty`.
- Move path: extend the existing `BaseURL`/`ApiURL` rewrite to also set the **mesh server
  URL** (today it only rewrites the two API strings).
- **No second RMM to run/update. Closes all three leaks. Testable today.**
- Limit: no process/network isolation — same Django/Postgres/NATS behind both hostnames.

### Option A — Physical split: separate lightweight public RMM (owner's stated ideal)
A bare, terminal-only TRMM instance on `instaweb.top` for public staging; the existing
instance becomes private-only, fully rebranded off `instaweb.top`.
- Public install link → new public RMM. Move = **install private agent → verify → delete
  from public** (matches the owner's described flow; it is *not* a registry rewrite).
- Gives **real isolation**: public churn (install/die/expire) never touches the private RMM.
- Cost: a 2nd Django+Postgres to run + patch; "move" becomes reinstall rather than in-place.

**Recommendation:** ship **B** now (closes the leak, fast, testable), then **A** as a
follow-up build if/when the owner wants physical isolation — unless the owner prefers to go
straight to A.

---

## §5 Out of scope / MUST NOT touch
- **TASK_228 behaviour** (public-on-top, no auto-move, manual button, hide-only) — deployed.
- The Neko **tiny-screen / stream disconnect** hunt (`B1`) — separate task; Wilk's stream
  issue is independent of the RMM split. The `TASK_221_…_STEPS.md` source doc is missing and
  should be recovered/rewritten before that hunt resumes.
- `new-test` CF backfill, `.env` RESEND placeholder, security F2–F5 — unrelated, still open.

## §6 Owner decisions required before build
1. **Option B now, Option A now, or B-then-A?**
2. If B: confirm private hostnames (`api.broks.beauty` / `mesh.broks.beauty`) or pick others.
3. If A: where does the 2nd RMM live (same VPS separate ports/DB, or a second VPS)?
