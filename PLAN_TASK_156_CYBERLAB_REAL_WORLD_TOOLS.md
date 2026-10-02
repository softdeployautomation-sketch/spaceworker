# PLAN — Task 156: Cyber Lab, real-world (attack + defense, inside the law)

**Status: RESEARCH / SCOPING — not started. Owner-requested 2026-10-01.**
**§12 (owner addendum 2026-10-02) is BINDING for what the lab must actually be** — the research gate,
the email/DNS/server classes, the on-your-own-VM customer shape, the easy-plus-powerful UX and the
Linux tooling charter. Read §12 before §5.
**Companion doc: `PLAN_TASK_155_WORKERS_AND_PAGES.md` — owner: *"the cyberlaw and
workers/pages features go hand in hand… the workers need to be ready so the Cyber Lab has
enough tools to use."* 155 is a **hard dependency** for the lab's simulation infrastructure
(payload/landing-page hosting over the engines in 155 §4).**

**Supersedes nothing, but must be read with:** `TASK_98_CYBER_LAB_STAFF_TRACK.md` (the
staff-track build spec, L1–L3) and `PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md` §CYBER LAB TRACK
(L1–L4) + **M5** (*"personal VMs + staff-badge full access, egress gate deferred for the
staff track, everything audited, panic switch"*). `PLAN_TASK_91_CYBER_LAB_RED_TEAM.md` is
**superseded — do not build from it.**

---

## 1. The owner's thesis, taken literally

> *"many cyber apps just say they teach and have tools for hacking and defence, but most of
> the cyber guys just learn simulation and never try real world attack… we will need to show
> users that ours is different, and our verification process is very good, and anyone using
> this for crime would be fished out immediately, but we won't reduce the features just
> because we are scared of people using it for crime — we would rather fight against crime."*

That is a **coherent product strategy**, not a contradiction, and it only works if three
things are true. This plan exists to make them true and to make them **demonstrable**:

| Claim we make | The mechanism that makes it true | How we prove it (not a slogan) |
|---|---|---|
| **"Not simulation."** You attack real machines, over real networks, with real TTPs. | Lab ranges are **real hosts on real networks** (owner's LAN + dedicated lab VPS), not containers talking to mocks. Targets are the user's **own attested assets** — which is exactly what the law requires. | A signed, timestamped `LabEpisode` containing **raw host telemetry** from the Vantra agent on the victim — packet/process/registry evidence, not a script's claim of success. |
| **"Our verification is very good."** We can prove what happened, and it was authorized. | Authorization = attested target inventory (`LabConsent`) checked against **every** target the run touches. Evidence = append-only `AgentActionAudit` + episode artifacts, hash-chained. | A retest tracker + ATT&CK coverage matrix that a CISO can hand to an auditor, exporting the evidence chain. |
| **"Criminals get found immediately."** Full power is *safe* because the platform watches. | An **abuse sentinel** on every run (§5): targets must resolve to attested inventory, egress is monitored, intent is classified, agent-reported anomalies go straight to the admin with an evidence bundle; one-tap freeze. | A **live demo**: aim a run at a non-attested target → it is refused, logged, reported, and the account is frozen, on camera. |

**And the honest part:** staff/development track (L1–L2) is deliberately **not** fenced to a
no-egress sandbox (M5, because real networks are the point). **Customer** track (L4) is
fenced: disposable no-egress ranges + allow-listed scenarios + attested targets + a
lawyer-reviewed AUP. **Nothing customer-facing ships from this plan until those fences
exist.** That ordering is the entire safety argument and it is not negotiable.

---

## 2. What exists today, and what we lack (measured 2026-10-01, not assumed)

**Exists — reuse it (verified by grep in this session):**

| Thing | Evidence |
|---|---|
| Device layer (heartbeat, capability, job, action, audit, relationship, power policy) | `prisma/schema.prisma:1438-1585` — `DeviceHeartbeat`, `DeviceCapability`, `DeviceJob`, `DeviceAction`, `DeviceAudit`, `DeviceRelationship`, `DevicePowerPolicy`; plus `DeviceQueuedCommand`, `DevicePinRequest`, `DeviceScreenshot`, `DeviceOnboarding` |
| Entitlements | `UserEntitlement` (`schema.prisma:1586`); `ENTITLEMENT_KEYS` **already contains `cyberlab`** (`lib/entitlements.ts:12`) |
| Product audit | `AgentActionAudit` (`schema.prisma:1610`) + `recordAgentActionAudit` (used by the clone pipeline) |
| **Panic switch** | **Real**: `app/api/devices/panic/route.ts`, `components/panic-button.tsx`, wired in `lib/devices.ts`, `lib/clone.ts`, `lib/resource-governor.ts` |
| Resource governor | `lib/resource-governor.ts` + `app/api/admin/governor` (queueing + premium priority) |
| Admin monitoring surfaces | 30+ routes under `app/api/admin/` (`devices`, `queue`, `screenshots`, `clone-limits`, `browser-sessions`, `ai-usage`, `users`, `payments`, `maintenance`, …) |
| Browser-clone pipeline (a worked example of a gated, audited, high-risk capability) | `lib/clone.ts`, `lib/clone-transport.ts`, action `"browser-clone"` in `AgentActionAudit` |

**Does NOT exist yet (each is a real chunk of work — do not hand-wave it):**

| Missing | Evidence |
|---|---|
| **Every `Lab*` model** | `grep '^model Lab' prisma/schema.prisma` → **no matches** |
| **`AgentPendingAction` kind `"lab-action"`** | only `"browser-clone"` appears in `lib/` |
| **Any detection / Sigma / YARA infrastructure** | `grep -l 'sigma\|yara\|DetectionPack' lib/ app/` → **no matches** |
| **Staff badge (plan M4)** | no staff-badge helper found in `lib/*.ts` by grep (only `admin`-named surfaces). **Treat M4 as unbuilt until verified**, not as an existing primitive. **Per §12.9 the owner has ruled C1 does NOT build it — the gate is the PREMIUM `cyberlab` entitlement** |
| **A lab host** | no Caldera anywhere; production VPS is explicitly excluded (§4) |
| **Security tooling on the VPS** | only **`tcpdump`** is installed. **MISSING**: `nmap`, `nuclei`, `masscan`, `tshark`, `suricata`, `zeek`, `clamscan`, `osqueryi`, `yara`, `hashcat`, `hydra`, `msfconsole`. (`nmap` is apt-installable — candidate `7.91`) |
| **AUP / `LabConsent` text** | not written |
| **Caldera orchestration code** | none |

**The honest conclusion:** the *safety* plumbing (gate, audit, panic, governor, admin visibility)
is genuinely built and is the hardest part to get right. The *lab* itself is **greenfield**, and
the *toolchain* is a deliberate install + policy decision, not merely a code change (§9).

---

## 3. The rails shared with Task 155 (why they are one product)

The lab is not a separate island. Both features need the *same* primitives, and the owner
explicitly wants the two to reinforce each other:

| Primitive | Used by 155 | Used by 156 | Consequence |
|---|---|---|---|
| **Hosting engines A/B/C** | host pages, redirects, files | **payload/landing-page hosting for simulation ranges** (a phishing-sim page, a redirect chain, a staged "malware" file inside a range) | build 155 first; the lab consumes it |
| **Template library** | landing pages | **simulation landing pages** (login-portal clones for training the *defender*, clearly watermarked + range-only) | one library, two consumers |
| **Audit (`AgentActionAudit`)** | every deploy | every lab action | one audit trail, one admin surface |
| **Approval gate (`AgentPendingAction`)** | agent-initiated deploys | **`kind: "lab-action"`** (already reserved in the plan §SCHEMA) | one gate, no second framework (CROSS-TRACK RULE 1) |
| **Panic switch** | kill asset/user | **freeze every range** | one switch (CROSS-TRACK RULE 6) |
| **Resource governor** | deploy/convert work | **lab VMs + Caldera** are the heaviest RAM consumers in the platform | `requestSlot()` is mandatory (TASK_105 rule) |
| **Entitlements (`cyberlab`)** | `hosting_module` | `cyberlab_module` | both keys, config-driven prices |

**The compounding effect the owner is after:** every lab episode produces a validated
detection (`DetectionPack`) that ships to **real** SpaceWorker users through the Assistant's
security toolbelt, and every hosted simulation exercises the very hosting rails customers pay
for. The lab is both a *product* and the *quality engine* for the defensive side.

---

## 4. Lab architecture — where the machines actually are

Measured facts (2026-10-01), not assumptions:

- **Production VPS `164.68.105.96`** — 23 GiB RAM (16 GiB free), **119 GB disk free**, runs the
  live app. **Caldera NEVER runs here** (Apache-2.0 project whose **own docs warn the UI is not
  internet-hardened**; it carries a past CVE — `PLAN_TASK_91` §2). Production is excluded by
  M2 and by plain sense.
- **A second VPS is already paid for and in use** (the **Vantra** host: separate repo
  `/Users/mikeolab/vantra`, separate service user, separate directory on the same box family).
  Service units already running include **`exit-node-us1` / `exit-node-us2`** (SOCKS exit-node
  proxies) — i.e. **multi-origin egress already exists as infrastructure**, which is exactly
  what makes telemetry/attack-origin realism testable.
- **Lab VMs on the owner's LAN** (`192.168.0.x`, e.g. `myrat@192.168.0.103`) — the M5 start
  point: victim VMs run the **Vantra agent**, so every attack is observed with **exactly the
  telemetry real customers emit**. This is the single most important design property in the
  whole plan: *what the lab teaches transfers directly to what we can detect for users.*

**Topology (staff track):**

```
  ┌────────────────────────┐        ┌─────────────────────────┐
  │ SpaceWorker (prod VPS) │        │  Lab orchestration host  │
  │  web app · agent · DB  │◀──────▶│  (second VPS / LAN box)  │
  │  audit · gate · panic  │  gated │   Caldera (isolated,     │
  └────────────────────────┘  REST  │   token auth, no public) │
                                    └───────────┬─────────────┘
                                                │ adversary emulation (allow-listed)
                                                ▼
                        ┌──────────────────────────────────────────────┐
                        │  Victim VMs (owner's LAN, Vantra agent on)   │
                        │  real host telemetry → LabEpisode evidence   │
                        └──────────────────────────────────────────────┘
```

**Rules that come from this topology:**
1. The prod app only ever talks to the lab host over a **gated, authenticated** interface
   (`WORKER_AUTH_TOKEN`-class server-to-server, like the existing internal routes). Caldera is
   never exposed to the internet and never reachable from a customer session.
2. A range is **created through the proposal gate** (agent or user initiates → human approves →
   one-time execution → audit row), even for staff, so the audit trail is unbroken.
3. Every scenario is **allow-listed** (scenario catalog, no free-form command surface outside
   disposable range VMs) and its **targets are validated against attested inventory before
   launch** (§5).
4. `LabRange` TTL default **24 h**, per-range credentials, **zero cross-user reachability**,
   scheduled teardown *and* a verified teardown check (a range that fails to tear down is an
   incident, not a TODO).

---

## 5. The workforce — real tools, and the sentinel that makes them safe

The owner's ask: *"we already have extractor, mailer, device, and others — need it enriched so
companies in cybersecurity would really need this."* The toolbelt is therefore organised as a
**professional capability matrix**, not a feature list. Each entry declares: **what it does,
where it runs, who may use it, its license, and what evidence it produces.**

### 5.1 Capability matrix (grouped; every tool is range/attested-target bound)

| Class | Tools | Runs on | Gate | Note |
|---|---|---|---|---|
| **Recon / surface** | `nmap`, `nuclei`, `httpx`, `testssl.sh`, `ffuf` | lab host → attested targets | staff now; pro later | `nmap` is apt-installable on this box (candidate 7.91) |
| **Email** (§12.2 — NEW 2026-10-02) | `checkdmarc`/`dkimpy`/`swaks` (auth+analysis); **GoPhish** (phishing-sim); `smtp-user-enum`/`hydra` (range only) | lab host + range mail VM | auth/analysis = all; campaign = staff→customer post-L4; SMTP attack = range+attested | the class the matrix under-served; every row carries a legal-basis note |
| **DNS** (§12.3 — NEW 2026-10-02) | `dnsrecon`, `fierce`, `dnsx` (recon); `dnscat2`-class (exfil demo, range only); resolver audit | lab host + range resolver | recon/audit = attested only; exfil demo = range only | DNS volume+entropy watched by the §5.2.2 egress sentinel |
| **Adversary emulation** | **MITRE Caldera** (Apache-2.0) + **Atomic Red Team** | lab host | staff | the engine; must stay isolated (its own docs warn the UI is not hardened) |
| **Exploitation** | Metasploit-class, Impacket, BloodHound/SharpHound, kerbrute | lab host | **range + attested only** | highest blast radius |
| **C2 / post-ex** | Sliver/Havoc-class frameworks | disposable range VMs | **staff-only, v1** | never customer-facing in v1 |
| **Credential** | hashcat/John, hydra, Rubeus-class | range VMs | **staff-only, v1** | cracking offline hashes from *your own* range |
| **Network defense** | `tcpdump` (**already installed**), Zeek, Suricata, tshark | victim VM / lab host | all (defense) | produces the episode's network evidence |
| **Host defense / detection** | **Sigma**, **YARA**, Sysmon, osquery, Velociraptor, Wazuh, Chainsaw, Hayabusa, Zircolite | victim VM (Vantra agent adjacent) | all | this is what becomes `DetectionPack` |
| **DFIR** | Volatility, Sleuth Kit/Autopsy, Ghidra/radare2, binwalk | lab host | staff/pro | post-incident analysis of range artifacts |
| **Vuln / supply chain** | Trivy, Grype, Syft, `osv` data, cosign/sigstore verify | server + range | all | ships as *checks*, not scans, to customers |
| **Compliance / hardening** | OpenSCAP, Lynis, CIS benchmarks | victim VM | all | MT-3's hardening checks become toolbelt entries |
| **Threat intel / case mgmt** | MISP, TheHive/IRIS | lab host | staff/pro | feeds reports + IOC packs |

> **Reading the "Gate" column (owner §12.9):** `staff` / `staff-only` here is an **audience/tier label**
> (*internal/operator, usable before the L4 customer fences*) — **not** a staff-role gate. SpaceWorker
> has no staff badge (only Vantra did); **C1 gates the Cyber Lab by the PREMIUM `cyberlab`
> entitlement**, and the customer rows still wait for the C6 L4 fences.

**Why this beats "simulation-only" products:** each tool run emits a **hash-chained evidence
artifact** into `LabEpisode`. The user gets an ATT&CK coverage matrix, a retest tracker, and an
exportable findings report — the deliverables a red team actually bills for. That is the
"verification process is very good" claim, made structural.

### 5.2 The abuse sentinel (the price of full power — and how we pay it)

Full capability is only acceptable because **every run is watched**. Seven concrete mechanisms,
all built into the schema in §6 and surfaced in the existing admin panel:

1. **Target allowlist, enforced pre-flight.** Every target resolves (hostname→IP→range) and must
   match a `LabTarget` row the user attested to. Cloud/CDN/third-party ranges are **refused by
   policy**, not by luck. Refusal is logged.
2. **Monitored egress.** Range traffic leaves through a logged proxy; destinations outside the
   scenario allowlist alert; repeated attempts **freeze the range automatically**.
3. **Intent classification before execution.** The agent classifies the *request* ("scan 8.8.8.8"
   vs "scan my lab subnet") and blocks non-attested intent at the prompt, before anything runs.
4. **Velocity / pattern anomalies.** Target counts, enumeration cadence, off-hours bursts, and
   repeated failures against non-attested space feed a simple, explainable scoring.
5. **Auto-report to the admin.** Findings create `LabAbuseReport` rows and notify the admin
   (existing Telegram plumbing) — the owner's *"the agent sees what everyone does and reports"*
   made real, with an **evidence bundle** attached.
6. **Immutable audit.** Append-only `AgentActionAudit`; episodes signed; `LabConsent` never
   updated, only superseded. There is no "delete history" code path, by design.
7. **One switch, and an appeal path.** Panic freezes everything; a frozen account can appeal to
   the admin for human review. We cooperate with lawful requests and say so in the AUP.

**Hard lines (not configurable, not per-tier):** no primitives that target third parties; no
spam/fraud tooling; no mass internet scanning; no ransomware-class destructive payloads outside
a disposable range; customer track is no-egress + allow-listed + attested, full stop.

---

## 6. Schema (draft — hand-written SQL, per HOW_WE_MOVE_FAST / MICHAEL_BRIEF rule 2)

**Measured 2026-10-01: none of the `Lab*` models exist yet.** `grep '^model Lab' prisma/schema.prisma`
returns **nothing**. What *does* exist and must be reused (verified by grep): `DeviceHeartbeat`,
`DeviceCapability`, `DeviceJob`, `DeviceAction`, `DeviceAudit`, `DeviceRelationship`,
`DevicePowerPolicy`, `UserEntitlement`, `AgentActionAudit` — plus 56 models total in the schema.

To add:

- `LabHost` — a machine we may run the engine on: `label`, `kind` (`caldera`|`victim`|`relay`),
  `address` (never public), `authRef`, `enabled`, `ramBudgetMb`, `tags`. **A `LabHost` row may
  never reference the production VPS** (constraint enforced in code *and* by an admin panel warning).
- `LabScenario` — allow-listed scenario: `slug`, `name`, `techniqueIds` (ATT&CK), `adversaryProfile`,
  `requiredCapabilities`, `blastRadius`, `cleanup`, `enabled`, `author` (`staff`|`michael`|`import`).
- `LabRange` — one run instance: `userId`, `scenarioId`, `state`
  (`pending`→`provisioning`→`active`→`tearing_down`→`torn_down`|`failed`), `ttlExpiresAt`,
  `consentId`, `credentialRef`, `queuedSlotId`, `teardownVerifiedAt`.
- `LabTarget` — **the attested inventory item**: `userId`, `rangeId`, `kind` (`host`|`network`|`url`),
  `value`, `attestedAt`, `attestationId`. **Every scenario target must match a `LabTarget` row for
  that user** — this single table is the legal spine of the product (§5).
- `LabEpisode` — the evidence bundle: `rangeId`, `startedAt`, `endedAt`, `timeline` (Json),
  `techniques` (Json), `telemetrySignatures` (Json), `outcome`, `evidenceManifest` (paths + SHA-256),
  `signedHash`.
- `LabFinding` — `episodeId`, `severity`, `title`, `detail`, `retestOf` (self-relation for retest
  tracking), `exportedAt`.
- `DetectionPack` — `version`, `rulesJson` (Sigma-class), `validatedByEpisodeId`, `shippedAt`,
  `audience` (`staff`|`pro`|`all`).
- `LabConsent` — `userId`, `termsVersion`, `scope`, `signedAt`, `ip`, `hash` (append-only; never
  updated, only superseded).
- `LabAbuseReport` — the sentinel's output: `userId`, `rangeId`, `reason`, `evidenceJson`,
  `severity`, `status` (`open`|`frozen`|`cleared`), `reviewedByAdminId`.

> **§12.9 note on the `staff` field values above** (`LabScenario.author`, `DetectionPack.audience`):
> `staff` is an **audience/tier label** meaning *internal/operator, usable before the L4 fences*, **not**
> a staff-role gate. **C1 does not build a staff badge** — the Cyber Lab panel is gated by the PREMIUM
> `cyberlab` entitlement. Keep the field values; read them as tier labels.

**Reuse, never duplicate** (CROSS-TRACK RULE 5): approval → `AgentPendingAction` (add kind
`"lab-action"` — **not implemented today**; only `"browser-clone"` exists), audit →
`AgentActionAudit`, entitlement → `UserEntitlement` key `cyberlab` (**already present in
`ENTITLEMENT_KEYS`**), limits → `AdminSetting`, queueing → the resource governor (TASK_105).

---

## 7. Phased delivery

Ordered so that **the safety net exists before the first real attack runs** — not after.

| Phase | What ships | Depends on |
|---|---|---|
| **C0** | **AUP + `LabConsent` text** (lawyer-reviewed, versioned), the "Authorized targets only" onboarding, the legal-boundary page. *Nothing runs before this exists.* | lawyer |
| **C1** | **Schema + gate**: all `Lab*` models, `AgentPendingAction` kind `"lab-action"`, **the PREMIUM `cyberlab` gate (§12.9 — NO staff badge; §10 Q2 resolved by the owner)**, lab limits as `AdminSetting` (CROSS-TRACK RULE 7), admin panel page with live counts | — |
| **C2** | **Lab host**: Caldera on a **non-production** host (isolated, token auth, never public), Vantra agent on victim VMs, one hard-coded smoke scenario end-to-end | C1 |
| **C3** | **Episode recorder + evidence chain**: `LabEpisode`/`LabFinding`, signed manifests, ATT&CK mapping, findings-report export | C2 |
| **C4** | **Abuse sentinel** (§5.2): target allowlist enforcement, egress monitor, intent classifier, `LabAbuseReport` → admin notify → auto-freeze. **Demo-able refusal test** (§8). | C3 |
| **C5** | **Detection pipeline** (L3): episode → Sigma-class candidate → validated against episode telemetry → `DetectionPack` → shipped to a test user's digest via the Assistant toolbelt | C3 |
| **C6** | **Customer track (L4) — gated hard**: disposable no-egress ranges, allow-listed scenarios, attestation, TTL teardown **verified**, `cyberlab_module` on sale. **Requires the AUP + lawyer sign-off.** | C4, C5, legal |

**Explicitly out of scope here:** model training (`TrainingExample` export is *stored for*, not
run — that is the LATER GPU plan); anything targeting third parties; free-form command surfaces
outside disposable range VMs.

---

## 8. Verification — how we *prove* "not simulation"

The product claim must be provable from raw evidence in a demo, or it is marketing. Each is an
acceptance test with an observable, non-simulatable output:

1. **Real-attack probe.** Aim one attestation-authorized attack at a lab VM; show the **raw host
   telemetry** the Vantra agent recorded (process/registry/network) alongside the episode — the
   artifact a simulator cannot produce.
2. **The refusal demo (the safety claim, on camera).** Point a run at a target **not** in the
   attested inventory → observe, in order: **refused → logged → `LabAbuseReport` → admin
   notified → account frozen**. *A guard that cannot fire is not a guard* — this one must be
   watched firing.
3. **Egress demo.** A range attempting a destination outside the allowlist → alert + auto-freeze.
4. **Detect-then-defend loop.** The technique that landed in (1) is caught by the derived
   `DetectionPack` on a second pass — i.e. the lab *taught* the product something.
5. **Teardown proof.** TTL expiry tears the range down and sets `teardownVerifiedAt`; a failed
   teardown raises an incident.

**Honest limits to state on the same page:** the staff track is deliberately not no-egress (M5);
the sentinel is heuristics + policy, **not a guarantee**; and every claim about what a
*customer-tier* range does must be re-verified **after** the L4 fences ship — never assumed from
the staff implementation.

---

## 9. Dependencies, toolchain decisions, and what we lack

| Decision | Options | Recommendation |
|---|---|---|
| **Where the engine runs** | prod VPS (❌ excluded) · second VPS · LAN box | **second VPS / LAN box**, isolated, never internet-facing |
| **Tool installation** | lab host only, or also prod | **lab host only**. Prod keeps `tcpdump`; add **defensive** tools (`clamscan`, `osqueryi`, `yara`) only if a feature needs them |
| **Which tools in v1** | everything at once vs a curated set | **curated**: `nmap`, `nuclei`, Caldera + Atomic, `tcpdump`/Zeek, Sigma/YARA, Trivy — prove the loop before breadth |
| **VM substrate** | manual VMs vs IaC (Terraform/Ansible) vs hypervisor API | **manual first, scripted second** — do not build an orchestrator before one range works |
| **Range isolation** | VLAN vs firewall rules vs separate hypervisor | whatever the LAN box supports; **verified by test**, not by config review |
| **Detection format** | Sigma vs custom JSON | **Sigma-class** (portable, recognised, sellable) |
| **Hosting for sim infra** | Task 155 engines | **155 P1/P2 first** (the owner's "workers must be ready") |

**Missing to start C2:** a lab-host decision (owner), `nmap`/Zeek/Suricata on it, Caldera
deployed, ≥2 victim VMs with the Vantra agent, and the C0 AUP text.

---

## 10. Open questions for the owner

1. **Lab host:** the second (Vantra) VPS, or a box on the LAN? (Caldera must not touch the
   production app host either way.)
2. **Staff badge (M4):** ✅ **RESOLVED 2026-10-02 PM — see §12.9.** SpaceWorker has no staff gate and
   will not get one in v1; **C1 gates by the PREMIUM `cyberlab` entitlement** instead. Do not build a
   staff badge. (The user-tier model is still under review as a separate question.)
3. **Customer track timing:** is the Cyber Lab sold at all before the L4 fences land, or
   staff-only until the AUP clears a lawyer?
4. **Credential/C2 tools:** acceptable for **staff-only** v1, or excluded until the customer
   fences exist? *(This plan assumes staff-only.)*
5. **Which lawyer** reviews the combined hosting + lab AUP (shared with Task 155 §13.5)?

---

## 11. Relationship to existing docs (what changes, what does not)

- **`TASK_98_CYBER_LAB_STAFF_TRACK.md`** stays the **build spec** for L1–L3 + the MT-2/MT-3
  contracts; this doc adds the **tooling matrix (§5)**, the **abuse sentinel (§5.2)**, the
  **schema deltas (§6)** and the phasing (§7). Where they disagree, **this doc wins for _what_ is
  built** and TASK_98 wins for *Michael's contract artefacts*.
- **`PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md`** §CYBER LAB TRACK + **M5** remain the governing
  product decisions (personal-VM start, live lab access, egress gate deferred for the internal tier,
  audited, panic switch; L4 fences for customers). **M4's staff badge is unbuilt (§2) and, per §12.9,
  is NOT built in C1** — the gate is the PREMIUM `cyberlab` entitlement instead.
- **`PLAN_TASK_91_CYBER_LAB_RED_TEAM.md`** stays **superseded**.
- **`PLAN_TASK_155_WORKERS_AND_PAGES.md`** is a **dependency**, not merely a related doc: build
  155's P1/P2 (files + redirects on our own metal) before the lab's simulation infrastructure.

---

## 12. Owner addendum 2026-10-02 — BINDING (what the lab must actually *be*)

Owner, verbatim: *"let me see what the cyberlab would be all about and be sure it meets todays hackers
world attack and not some stale tools, we need to be able to simulate all kind of emails, dns, server
attack, we need to make research and since we use a linux box, there should be enough hacking tools we
can add from there, and make it easy for users and powerful, a to end simulation on the users personal
vm =, we just create the attack simulation from spaceworker."*

**Eight** rulings follow (§12.1–§12.8 from the owner's addendum, plus **§12.9 — the access ruling,
added the same day**). They **refine** §5's matrix and add the classes it under-served (email + DNS);
they do **not** overturn §5.2 (the abuse sentinel), §4 (where the machines are) or §7 (the phasing).
**C0–C6 still gate everything.** The one addition is that C2+ now has a **required research step
(§12.1)** before a tool is offered, and the customer-facing shape is the **§12.5 on-your-own-VM**
model, not a shared range. **§12.9 is binding on C1: the gate is the PREMIUM entitlement, not a staff
badge.**

### 12.1 "Not stale tools" — a research gate, not a wishlist

*"be sure it meets todays hackers world attack and not some stale tools … we need to make research."*

A tool is **not** added because it is famous; it is added because it is **current**. The gate is a
repeatable, auditable artefact we own, not a vibe:

- **One row per capability in a `LabToolCatalog`** (C1 schema, §6) with: MITRE ATT&CK technique id(s),
  **last-reviewed date**, **upstream version + release date**, CVE history, licence, derivation
  (which real-world campaigns/APT reports used it in the last 12–18 months), and a **stale-after**
  date. A capability whose `staleAfter` has passed is **hidden from the UI automatically** and shows
  "refresh required" in admin — the exact opposite of a tool list that quietly rots.
- **A Research cadence** (a small scheduled job + an admin page): refresh ATT&CK (its releases are the
  versioned spine), pull the newest Sigma/YARA rule packs, newest `nuclei` templates, and the current
  Atomic Red Team atomics; record every pull with a diff + date, so "we are current" is a **timestamp
  we can show**, not a claim. This is *the* answer to "not stale".
- **Research is a lab capability, not a background chore:** the same page is where an operator notes
  *"this TTP is trending — add it"* and mints a `LabToolCatalog` draft. It is the research→tool→test
  loop the owner asked for.
- **Nothing in this gate runs an attack.** It reads public feeds and writes catalog rows.

> Provenance note: this is a **plan**, so the ATT&CK "current release" figure is asserted here, **not
> measured live in this session** — C1 must pin the actual current ATT&CK release when it builds the
> catalog, and record the date it did.

### 12.2 Email — the class the plan under-served (simulate **all kinds of emails**)

*"simulate all kind of emails."* The plan had a one-line mention of a "phishing-sim page"; that is not
enough. Email is now a **first-class class**, splitting into **defence training** (safe, runs anywhere,
→ a `DetectionPack`) and **attack emulation** (attested-target only, staff-first):

| Sub-class | What we simulate | Tools / how | Gate |
|---|---|---|---|
| **Deliverability / auth** | SPF · DKIM · DMARC · **BIMI** · MTA-STS · DANE: *why* a spoof fails vs lands | `checkdmarc`, `dkimpy`/`opendkim-testmsg`, `swaks`, our own header parser | **all tiers, on YOUR own domain** — pure analysis, no sending |
| **Header / phishing analysis** | parse a real `.eml`, score it, show the *exact* spoof tell | `mailspoof`-class checks, `emailhop`-class chain tracing, the 155 extractor rail | all tiers, **defensive** |
| **Phishing simulation (campaign)** | send a **watermarked, range-only** lure to **consenting** in-org addresses; track opens/clicks/reports | **GoPhish** (self-hosted on the lab host) for orchestration + the 155 template library for the landing page | **staff now; customer only post-L4 fences**; recipients must be attested `LabConsent` addresses |
| **SMTP/IMAP attack emulation** | relay abuse, auth brute, STARTTLS downgrade, header injection — **against a disposable range mail VM** | `swaks`, `smtp-user-enum`, `hydra` (**range only**), `openssl s_client` | **range + attested only** |
| **Email-borne payload hygiene** | does *this* attachment actually detonate? | ClamAV + **YARA** on the range VM (never a real inbox) | all tiers, sandboxed |

**Hard lines (§5.2, restated because email is abuse-prone):** we never send to a third party's inbox,
never spoof a domain we/the user do not control, never build spam/fraud tooling. A phishing
*simulation* targets **consenting, attested recipients of the tenant's own organisation**; anything
else is refused and reported. The `LabToolCatalog` row for a spoof-class tool must record the legal
basis and the allow-list check.

### 12.3 DNS — simulation we own, not a rented bypass

*"…dns… attack."* DNS is both an attack surface and *the* exfiltration channel, so it gets its own
class (§5.1's matrix had none):

| Sub-class | What we simulate | Tools / how | Gate |
|---|---|---|---|
| **Recon / zone discovery** | enumerate a name's records; find dangling records (takeover) | `dnsrecon`, `fierce`, `dig`/`dnsx`, our own resolver | **attested names only** |
| **DNS exfil / tunneling** | detect (and, in a range, demonstrate) covert exfil over DNS | `dnscat2`-class + **Zeek/Suricata DNS logs** to prove detection | **range + attested only**; the *demo* runs on our own lab domain |
| **Poisoning / rebinding (education)** | why rebinding/poisoning works, in a **closed range resolver** | a range-local resolver; **no real recursion** | **range only** |
| **Resolver / config audit** | open resolver, DNSSEC missing, weak NS — the *defensive* checklist | `dnsdiag`-class, `delv`, our own checks | all tiers, on **your** zones |

**Rule:** DNS offensive tooling may only resolve/query **domains in the attested inventory**, and the
egress sentinel (§5.2.2) watches DNS volume + entropy to catch exfil attempts even inside a range.

### 12.4 Server / host + network attack simulation

*"…server attack."* §5.1 already lists these tools; the ruling here is that they are organised as
**scenarios a user can run**, not a bag of binaries:

- **Reconnaissance → exploitation → post-ex → detection** as a **chain** (that is what a real attack
  is), each stage emitting its evidence into the one `LabEpisode` (§5, §8). Caldera + Atomic Red Team
  are the emulation engine; `nmap`/`nuclei`/`ffuf` are the surface stage; Metasploit/Impacket-class is
  the exploitation stage; Sliver-class C2 is **staff-only v1** (§5.1).
- **Server attacks are run against a range VM or an attested host, never a third party** — the §5.2.1
  pre-flight allowlist is the gate, and the §8.2 refusal demo proves it fires.
- **Network-layer evidence is mandatory** (`tcpdump` already on the box; Zeek/Suricata to add) so a
  "landed" claim is backed by packets, not by the tool's own output.

### 12.5 End-to-end on the **user's own VM** — SpaceWorker authors, the VM executes

*"a to end simulation on the users personal vm =, we just create the attack simulation from
spaceworker."* This is the **customer-facing shape** and it is deliberately different from the staff
lab range:

```
  ┌────────────────────────┐   author + gate    ┌──────────────────────────────┐
  │ SpaceWorker (prod VPS) │──────────────────▶ │  USER'S OWN VM (their RAM)    │
  │  author the simulation │  AgentPendingAction │   - Vantra agent installed    │
  │  scenario catalog·audit │  signed, one-time   │   - runs the scenario         │
  │  landing pages (155)   │◀────────────────── │   - streams telemetry back    │
  └────────────────────────┘   LabEpisode evid.  └──────────────────────────────┘
```

- **We create the simulation; their VM is the execution substrate.** The heavy RAM (VMs, C2, cracking)
  lives **on the user's machine**, not on our box — which is exactly the owner's A8 "monitor the load"
  story: the governor (§16.6 of 155) sees a *signed job*, not a VM on our metal.
- **Delivery is the same gated primitive as everything else:** an `AgentPendingAction` kind
  `"lab-action"` → human approves → the Vantra agent **pulls** the scenario (outbound, no inbound
  port) → runs it in the user's sandbox → streams `LabEpisode` evidence back → we audit + map to ATT&CK.
- **Their VM is their attestation.** Onboarding the VM = the user attesting *"this machine is mine and
  I authorise simulations on it"* (`LabConsent`, scoped to that device id). That single act is what
  makes firing at it lawful **and** keeps us from ever touching a third party.
- **Still gated at C6 for customers** (L4 fences + AUP + lawyer) — the personal-VM model does **not**
  replace the AUP; it makes the customer track *implementable* without us hosting attack VMs.
- **Honest limit:** "end-to-end on your VM" is the **target customer model**; v1 (staff) may still use
  owner-LAN VMs (§4). Do not claim the customer path works until C6 is built and a real
  user-authored→user-VM→evidence loop is watched end-to-end (§8).

### 12.6 "Easy for users and powerful" — the UX contract

*"make it easy for users, and powerful."* Power with a wall of flags is not a product. The contract:

- **One sentence in, a scenario out.** The Assistant (Task 155's agent rail) turns *"simulate a
  credential-phishing email against my office and show me what a defender would see"* into a **draft
  scenario**: chosen class (email/DNS/server), chosen tools, chosen targets, expected evidence. The
  user reviews and approves; nothing runs from chat directly.
- **Scenario cards, not a terminal.** Each card shows: class, what it does, **which attested targets it
  will touch**, the caps it consumes, and the evidence it will produce. "Powerful" = the full
  capability matrix; "easy" = the catalog + the card + the assistant do the selection.
- **Every run ends with a report a human can act on**: an **ATT&CK coverage matrix**, the raw evidence
  chain, and a **retest** button (§8). That report is the payoff that makes the power legible.
- **Guardrails are part of the UX, not hidden:** a refused target shows *why* (not attested) in plain
  language, with the one action that would make it lawful (add it to your inventory). This is §5.2.3's
  intent classification made visible.

### 12.7 The Linux box — the tooling charter

*"since we use a linux box, there should be enough hacking tools we can add from there."* True, and it
is a **charter**, not a free-for-all:

- **Where tools go (unchanged, §4/§9):** the **lab host** (second VPS / LAN box) and the **user's own
  VM** (§12.5) — **never the production app host**. Prod keeps `tcpdump` and (optionally) purely
  **defensive** tools.
- **Every install is a catalog row** (§12.1) with licence + version + ATT&CK mapping + a `staleAfter`
  date. No tool appears in the UI without one.
- **Packaging:** prefer distro packages / pinned containers over curl-pipe-bash; the lab host is
  isolated and token-auth only (§4). A tool that cannot be versioned cannot be catalogued, and is
  therefore not added.
- **The governor is watching (A8).** Nothing here is built to run two heavy things at once; the lab
  inherits the same single-slot/queue discipline as hosting (155 §16.6) and `requestSlot()` remains the
  single admission authority (TASK_105 rule).

### 12.8 Effect on the phasing (§7) — what actually changes

- **C1** gains the **`LabToolCatalog`** table + `staleAfter`/last-reviewed columns and the **Research
  admin page** (read-only feeds; no attack), and gates the panel by the **PREMIUM `cyberlab`
  entitlement (no staff badge — §12.9)**. This is additive to §6.
- **C2** is unchanged in shape (Caldera on a non-production host, one smoke scenario) but the smoke
  scenario must be a **documented catalog row**, and a **Zeek/Suricata** capture must be part of its
  evidence.
- **C3** (episode + evidence chain) is where the **email/DNS/server** classes first produce a real
  report; email-auth and DNS-audit (the *defensive* rows) can ship **before** any offensive row.
- **C4–C6** unchanged: sentinel → detection pipeline → gated customer track. §12.5's personal-VM model
  is what C6 *is* for customers.
- **Unchanged absolute:** nothing customer-facing until C0's AUP + lawyer sign-off. §12 expands *what*
  the lab can do; it does not move the fences.

### 12.9 Access ruling (owner, 2026-10-02 PM) — **PREMIUM-gated, no staff gate in v1** — BINDING

Owner, verbatim: *"we dont have staff gate in spaceworker yet, so just build it premium gated … we
are still going to evaluate how the users tier work instead and decide whether to add the staff gate
to spaceworker; we only had it in vantra. lets not make this a blocker."*

This **resolves §10 Q2** and **supersedes the "staff badge (M4)" deliverable in C1** (§7). It is an
access-gating decision, so it binds C1 directly:

- **SpaceWorker has no staff badge and no staff-role gate today.** Confirmed by grep: no staff-badge
  helper exists in `lib/*.ts` (only `admin`-named surfaces). The "staff track" was a **Vantra** concept;
  SpaceWorker never inherited it. **Do not build a staff badge, and do not block C1 on one.**
- **C1 gates the Cyber Lab by the PREMIUM entitlement.** The key is **`cyberlab`, already in
  `ENTITLEMENT_KEYS`** (`lib/entitlements.ts`) and already flowing through the `UserEntitlement` path —
  the *same* gate the `hosting` module uses. The panel is reachable by a **premium / granted** user (and
  by anyone holding a `UserEntitlement` grant of key `cyberlab`); a non-entitled user is refused
  server-side. No second role, no second gate.
- **Wherever this doc — or §5 — says "staff"** (the tool-audience column, "staff-only v1", "staff now;
  pro later"), read it as the **audience label** = *internal / operator tier, usable before the L4
  fences exist*, **not** a code-level staff gate. `LabScenario.author`, `DetectionPack.audience` and the
  tool-matrix "Gate" column keep their **field values**, but their meaning is **audience/tier**, not an
  authorization role.
- **The user-tier model is under review.** Whether SpaceWorker ever needs its own staff gate is a
  **later** owner decision. The deferred **L4 customer fences** (heavier AUP, lawyer sign-off,
  disposable no-egress ranges) are unchanged and still gate the **customer** track — §12.9 changes
  *how C1 opens the door*, not *what the fence is*.
- **Honest limit:** premium gating is **authorization hygiene**, not a legal fence. It does **not**
  replace the C0 AUP/consent, the §5.2 abuse sentinel, or the C6 L4 work.

---

**What this addendum explicitly does NOT authorise:** targeting third parties, mass internet scanning,
spam/fraud tooling, spoofing domains the tenant does not control, or any customer-facing offensive run
before C0/C4/C6. Those are §5.2 "hard lines" and remain non-configurable.