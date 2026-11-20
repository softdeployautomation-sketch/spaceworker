# Cyber Lab — REAL EGRESS (Slice: live attacks against your own equipment)

> Owner directive (2026-10-14): "no protection against abuse — that's why it's off
> Premium Plus; only my granted workers use it; everyone goes through tough
> verification; reduce the security friction to zero so we can have a good test,
> see what can be done, run smoothly on every range, and film the ad video that
> sells businesses on protecting themselves with CyberLab wired into their cyber
> team's app." This plan scopes that. **DRAFT — awaiting owner sign-off on the
> posture below before any live-egress code is written.**

## 0. What this changes (and what it does NOT)

TODAY every run is **synthetic** (`generateReconTelemetry` / `generateSmokeTelemetry`
emit `synthetic:true` artefacts; `mode:"dry-run"`; the UI says "SIMULATION"). No
packet leaves the VPS. This plan makes CyberLab fire **real packets** so you can
actually break into your own VM from SpaceWorker (and from an on-site agent for
LAN/wifi), record the real intrusion, and film it.

**The engine seam already exists** — `lib/lab/engine.ts` ~line 215:
`isRecon ? generateReconTelemetry : generateSmokeTelemetry`. Real egress is a THIRD
runner behind a master switch, selected the same way. Nothing about the gate, range
lifecycle, governor, episode signing or teardown changes — those are the product and
they stay.

## 1. The posture you asked for (owner policy, not hardcoded)

Every safety knob becomes an **AdminSetting dial that defaults OPEN** (friction = 0),
so the posture is YOUR decision and re-tightenable per-range without a rebuild:

| Dial (AdminSetting, new) | Default | What it does when tightened |
| --- | --- | --- |
| `cyberlabLiveEgressEnabled` | `false` (ship dark, flip on) | The ONE master switch for real packets. Off = today's dry-run. |
| `cyberlabEgressRequireOwnershipProof` | `false` (0 friction) | If true, a public server-egress target must carry a DNS-TXT challenge token first (anti-proxy). Off for the closed beta. |
| `cyberlabEgressScopeGuard` | `false` (0 friction) | If true, re-applies the /24 breadth guard on declared scopes. Off so you can scan however you like. |
| `cyberlabEgressAllowList` | empty = allow all | If set, egress restricted to listed CIDRs/hosts. Empty = no allow-list. |

**What I keep (because it IS the product you're selling, not friction):**
1. **Audit trail** (`LabAbuseReport`, episode signing, victim sensor). Your ad's whole
   pitch is tamper-evident proof of the intrusion. Deleting it guts the sell. Stays.
2. **Honest labelling.** The moment packets are real, "SIMULATION" becomes a false
   claim that would destroy the credibility of the video. So the UI watermark flips
   to **"AUTHORIZED TEST · YOUR EQUIPMENT"** and every artefact is labelled truthfully
   (`synthetic:false`, `mode:"live"`, a `live:true` flag on the episode). This protects
   your pitch; it is not friction.
3. **Consent checkbox** — a ToS acceptance, one click, part of the legal spine. Stays.

## 2. Two egress paths (your "Both" choice)

**A · Server egress** — the VPS fires real packets at a **public** target you name.
- Reaches your VM only if the VM has a public IP (or you port-forward / DNAT to it).
- Cannot see LAN (`192.168/10/172.16`) or wifi — a cloud box has no route and no radio.
- Friction = 0 by default (ownership-proof dial OFF). Rate still bounded by the
  existing governor + daily cap so a run can't wedge the VPS.

**B · Agent / on-site egress** — packets sent by **your tacticalrmm agent running on
your network**; SpaceWorker orchestrates + collects the signed result.
- The ONLY path that reaches a LAN VM or scans wifi. Matches the victim-sensor
  pattern (`lib/lab/victim-sensor.ts`): the agent is on your metal, so there's no
  proxy-abuse surface and the evidence is "what your own device recorded," not the
  attacker's claim.
- Reuses the existing DeviceHeartbeat/DeviceJob/DeviceAction rows + agent command path.

## 3. Scoped build slices (smallest safe increments)

- **E1 · The runner seam + dial + honest relabel.** New `lib/lab/live-runner.ts`
  (interface only, still returns synthetic until E2), `AdminSetting` dials above,
  and the UI watermark → "AUTHORIZED TEST · YOUR EQUIPMENT" with `synthetic:false`
  labelling wired. Ships as a no-op switch. **Tests: dry-run still dry when off.**
- **E2 · Server egress (public targets).** Real TCP/port/service probe via `node:net`
  against a declared public target, real timeline + real artefacts. Friction dials
  respected. **Tests: a real probe of a target you name returns real open/closed.**
- **E3 · Agent/on-site egress (LAN + wifi).** The agent command + signed collection
  path. **Tests: a run against your VM via the agent records real device-side rows.**
- **E4 · Ad-video packaging.** The S7 replay player (PLAN_CYBERLAB_NEXT) pointed at a
  **live** episode so the radar/rail/feed play back the real recorded intrusion.

## 4. Owner gates before E1 is built

1. **Posture sign-off** — dials default OPEN (friction 0) as tabled in §1, with audit
   + honest-labelling + consent KEPT. Approve, or do you want any dial tightened?
2. **Labelling word** — "AUTHORIZED TEST · YOUR EQUIPMENT" for live runs (vs keeping
   "SIMULATION" for dry and a new word for live). Approve the exact wording.
3. **Ship dark** — `cyberlabLiveEgressEnabled` ships `false` and you flip it in admin
   when ready to film. Agreed?
4. **Which first** — E2 (server egress, fastest to a public VM) or E3 (agent, the one
   that hits LAN/wifi)?

## 5. Honest limits (stated up front, not discovered later)

- This is a real offensive capability. Friction 0 means a granted user can point it at
  any reachable host. For a grant-only, verification-gated, off-Premium closed beta
  that's your stated intent — but it is the opposite of the §5.2 "no third-party
  scanning" discipline the dry-run enforced. Recording that this plan deliberately
  relaxes it at your instruction.
- Real egress from a cloud VPS to your LAN is impossible; E3 (agent) is not optional if
  you want LAN/wifi. Server egress alone will never see your `192.168.x` VM.

