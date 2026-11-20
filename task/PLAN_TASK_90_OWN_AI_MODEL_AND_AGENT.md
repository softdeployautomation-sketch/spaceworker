# PLAN — Task 90: Our Own AI Model + Agent (self-hosted cyber LLM, trained on our infra)

> **⚠️ SUPERSEDED 2026-09-22 — deferred to `PLAN_LATER_OWN_AI_GPU_TRAINING.md`
> (funded phase; GPU pay-as-you-go + training). Router/eval architecture
> notes remain valid there. Do not build from this file.**

**Status: draft for owner review — not started.**
**Date drafted: 2026-09-22.**
**Owner's one-line version:** fork the best open-source cybersecurity model and
the best agent framework, keep training them on our own server, so AI cost
stops bleeding to Groq/Channelry (which stays as premium fallback).

**Companion plans:** `PLAN_TASK_89_DEVICE_AI_AGENT.md` (device agent — the
biggest future *consumer* of this model), `PLAN_TASK_91_CYBER_LAB_RED_TEAM.md`
(the attack lab — the biggest future *producer* of training data for it).

---

## 1. Why

- Channelry/Groq works (Task 31) but is metered, capped (`$50/day` admin cap),
  and every SpaceWorker agent turn (digests, replies, proposals) burns real
  money that scales linearly with users.
- General models are only okay at cybersecurity; a tuned open model beats them
  per-dollar on our specific tasks (CTI summaries, log triage, playbook
  proposals) and never leaks customer context to a third party.
- Owning weights = owning the roadmap: fine-tune on our VM-lab episodes
  (Task 91) into a detection/defense capability no competitor can copy.

## 2. What exists today (constraints that shape this plan)

- `lib/agent.ts runAgentTurn` — the single user-facing AI call site; OpenAI-
  compatible relay to Channelry; real cost attribution into `AiUsageLog`
  (hundredths-of-a-cent units), per-user daily caps (Task 40).
- `AgentPendingAction` gate (Task 37), threads (Task 41), credits (Task 43).
- Infra reality: the production VPS is a **24 GB RAM CPU-only box** already
  running two Next apps + TRMM + nginx. It cannot train anything and can only
  serve a tiny quantized model on CPU (slow). This plan is honest about that.

## 3. Target architecture (the "two brains + router")

```
                 [ lib/agent.ts router  (one code path, many backends) ]
                    |                     |                      |
        local/default (vLLM,        premium fallback       frontier/complex
        OpenAI-compatible)          (Channelry->Groq)      (Channelry big model)
             our weights               today's path          cost-capped
```

- **Router rule (v1):** cheap/high-volume roles (digests, classification,
  summarization, tool-arg filling) -> local model. Long-horizon reasoning,
  unfamiliar tasks, or when local confidence is low -> Channelry. Route +
  cost logged per turn (extend `AiUsageLog` with a `route` field).
- The local backend speaks the **same OpenAI-compatible API** (vLLM), so the
  swap is a config change, not a rewrite. Channelry stays for premium; if it
  dies, we degrade to local-only instead of losing the agent.
- Governance unchanged: every mutating action still goes through
  `AgentPendingAction`. The model is swappable; the gate is not.

## 4. Model fork decision matrix (researched 2026-09-22, re-scan before buying)

| Candidate | Size | License | Verdict for us |
|---|---|---|---|
| **Qwen3-8B / 14B / 32B** | 8–32B | Apache-2.0 | **RECOMMENDED BASE.** Permissive, tool-calling + thinking modes, runs on one 24 GB GPU (QLoRA-trainable), huge fine-tune ecosystem |
| **RedSage-Qwen3-8B-DPO** (ICLR 2026) | 8B | ⚠️ "research & educational purposes only" per Responsible Use | **Recipe + dataset donor, NOT product weights** unless HF license says otherwise (verify). Its value: the full training recipe (CPT->SFT->DPO w/ Axolotl) + public corpora: RedSage-CFW (~11.7B tok cyber-filtered), RedSage-Seed (28.6k curated docs), RedSage-Conv (265k validated cyber dialogues), RedSage-Bench (30k MCQ eval) |
| **Kimi K3** (Moonshot) | 2.8T MoE | custom "Kimi K3 License"; ~1.4 TB even at MXFP4 | **Not self-hostable on our hardware; license needs legal review.** Skip as fork base; fine as API fallback later |
| **DeepSeek-R1-family** | 671B MoE | MIT | Excellent reasoning but far beyond our hardware; distill its *outputs* into our 8B/32B later |
| **GLM-4.x open** | varies | MIT | Backup base candidate if Qwen3 disappoints on our evals |

**Decision (D1): "fork the best model" = fork the *recipe + data*, train our
own weights on the Apache-2.0 Qwen3 base.** We inherit RedSage's published
curriculum instead of inheriting its license problem. If its HF weights turn
out to be permissively licensed, starting from RedSage-DPO directly is a
fast-path shortcut worth re-evaluating.

## 5. Agent framework decision (D2)

| Candidate | License | Status | Role for us |
|---|---|---|---|
| **CAI** (Alias Robotics) | MIT core + proprietary extras | **ARCHIVED 2026-08-28** (read-only, 9.8k★, 18 papers, 30+ CVEs, #1 CTF rankings) | **Pattern source, not a fork base.** Harvest its agent-role taxonomy (recon/exploit/report agents), prompt designs, and benchmark culture. Proprietary extras make wholesale embedding a no |
| **OpenHands-class open coding agent** | MIT-class | actively developed | Adopt its runtime *model* for SpaceWorker's future coding-project tasks: sandboxed exec, repo navigation, test-loop. Integrate patterns into our own loop rather than shipping a second agent product |
| **CALDERA** (now under Apache org) | Apache-2.0 | active (v5.1.0+) | Not an LLM agent — the **attack engine** for Task 91's lab; REST-driven by our agent |
| **SpaceWorker's own loop** (lib/agent.ts + tasks 37/39/41) | ours | live | **Remains the product agent.** Extend it with a model router + cyber tool roles. Shipping a second agent framework doubles maintenance for zero user value |

**Decision (D2): no wholesale fork of any agent framework.** SpaceWorker's
agent loop is already the differentiator (gated proposals). We absorb
patterns: CAI's cyber agent roles, OpenHands-style sandboxed coding for
developer tasks, CALDERA as the lab engine.

## 6. Task handling scope (what our model must be good at)

Roles the local model serves, mapped to existing/future SpaceWorker surfaces:

1. **Digests & summaries** (Task 89 Phase A): rollup -> "what was done today".
   High volume, low difficulty — first thing routed locally.
2. **Email reply drafting** (Task 89 Phase C): tone + intent + mailbox context.
3. **Proposal generation for the gate** (Task 37): plan cards, risk notes.
4. **Project management agent tasks**: plan decomposition, task breakdown,
   status rollups, standup-style summaries over `AgentThread` history.
5. **Coding-project tasks** (new, Phase C2 below): repo Q&A, small PRs, test
   fixing inside a sandboxed runner (OpenHands-style), reviewed by a human
   before anything lands.
6. **Cyber roles** (feeds from Task 91): log triage, CTI summarization,
   detection-writing (Sigma rules), lab episode narration -> defensive playbooks.

**Capability gates before a role routes locally (v1 policy):** pass rate on
its eval slice >= the Channelry baseline minus 5%, and zero hard failures
(crashes, unsafe tool args) in a 200-call canary. Router defaults to premium
on any doubt — cost is still lower than an incident.

## 7. Training scope (how we keep training on our server)

- **Method:** QLoRA SFT -> (later) DPO. Full RFT/RL is out of scope until
  Phase D; distillation from Channelry/frontier outputs is the cheap
  intermediate (teacher labels our prompts, student learns offline).
- **Data engine (the real asset):** every gated proposal + approval/edit/
  rejection (Task 37) and every lab episode (Task 91) is already an
  instruction-tuning example with human preference labels. Build
  `TrainingExample` export: prompt/completion/pair + consent flag. PII
  scrubbing pass before anything enters a training set.
- **Initial mix:** RedSage public corpora (license-checked per-dataset) +
  our own task data + general replay (to avoid catastrophic forgetting).
- **Cadence:** monthly fine-tune candidates; each candidate faces RedSage-Bench
  (30k MCQs) + our task evals; promote behind the router only on win.

## 8. Infrastructure scope (the honest part)

| Phase | Hardware | What runs | Cost shape |
|---|---|---|---|
| 0 (now) | existing 24GB VPS | nothing local; router ships premium-only | $0 |
| 1 | rent 1× 24GB GPU (RTX 4090/3090 class, ~$0.4–0.7/hr) | serve Qwen3-8B AWQ via vLLM; QLoRA runs | ~$300–500/mo if left running; cheaper: serve-on-demand |
| 2 | same GPU box | +32B AWQ for hard roles; batch offline jobs | same box, more VRAM juggling |
| 3 | 2× 24GB or 1× 48GB+ | DPO rounds, bigger student, lab-scale data flywheel | scaling decision by evidence |

- Serving stays **isolated from the production VPS**: GPU box runs vLLM +
  the training jobs; production talks to it over a private tunnel (WireGuard)
  with an API token; if the GPU box dies, router falls back to Channelry
  automatically (circuit breaker).
- Train data + weights never leave our infra; scratch on encrypted volumes.

## 9. Phased delivery

### Phase A - Router + premium hardening (no GPU needed) 
- A1: `lib/ai-router.ts`: backend registry, health/circuit-breaker, per-role
  route table; `AiUsageLog.route` column (hand-written SQL migration).
- A2: Canary dashboards: local-vs-premium quality sampling, cost curve.
- **Exit:** architecture ready; zero behavior change for users.

### Phase B - First local model ( rented GPU )
- B1: vLLM + Qwen3-8B-Instruct AWQ on the GPU box behind WireGuard.
- B2: Route digests + classification locally; canary 5% -> 50% -> 100%.
- B3: Baseline evals recorded (RedSage-Bench slice + our task evals).
- **Exit:** real AI-cost reduction with quality gates enforced.

### Phase C - Our tuned weights
- C1: QLoRA SFT v1 (RedSage corpus + our task data + general replay).
- C2: Sandboxed coding-project runner (OpenHands-pattern) for dev tasks; all
  outputs land as gated proposals, never direct pushes.
- C3: DPO v1 from approval/rejection pairs (the Task 37 flywheel).
- **Exit:** "our model" exists, measurable, improving monthly.

### Phase D - Flywheel + scale decision
- D1: Lab episodes (Task 91) -> SFT/DPO cycles for cyber roles.
- D2: Distill frontier outputs where contracts allow; publish nothing externally
  without owner sign-off.
- D3: Hardware re-plan from real serving economics.

## 10. Security & policy gates

1. Model server is **agent-infra**: private network, token auth, never public
   DNS, never on the web-cert path (consistent with Task 85 end-state rule).
2. Customer data used for training only with per-user consent flag; scrubbed;
   admin-auditable export.
3. Router failure mode = premium fallback, never user-visible breakage.
4. Every role change re-runs the canary gates (section 6).
5. License hygiene: per-dataset license check recorded in the training manifest
   (RedSage corpora are only usable if their terms permit commercial training).

## 11. Open questions for the owner

- Q1: Budget envelope for the GPU box (rent-to-start ~$300–500/mo vs buy a
  4090/5090 rig one-off ~$2.5–4k + power)?
- Q2: Is "research-only" data (RedSage) acceptable if we only use *datasets*
  (not weights) and our training outputs are our own weights? Owner call;
  legal review recommended before Phase C.
- Q3: Coding-project agent: which repos in scope first (spaceworker itself?)
  and is auto-PR-with-human-merge the right ceiling?
- Q4: Do we keep Channelry as the sole premium path, or add one more
  (e.g. direct Groq/OpenRouter key) for redundancy?

## 12. Suggested first slice

Phase A only: the router + usage-log `route` field + canary scaffolding. No
GPU spend, no model download, fully reversible — and it is a prerequisite for
every later phase. Phase B starts only after Q1 (budget) is answered.

