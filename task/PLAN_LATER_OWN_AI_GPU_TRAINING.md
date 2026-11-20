# PLAN (LATER — funded phase) — Own AI model + GPU + training + pay-as-you-go GPU lab

**Status: DRAFT — parked until funding lands. Nothing in PLAN_NOW depends on it.**
**Date: 2026-09-22. Consolidated from old PLAN_TASK_90 (own model + agent) and
the funded parts of old PLAN_TASK_91 (lab hardware, customer tiers).**
**Companion: `PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md` builds the tools and data
pipelines this plan will consume when money arrives.**

---

## 1. Why later, and why it's still worth scoping now

- Channelry (Groq) works today and stays the brain in the NOW plan; owning
  weights + serving removes the per-turn meter and the third-party dependency.
- The NOW plan's products (Assistant, Cyber Lab) are already generating the
  two assets this plan needs: labeled preference data (approvals/rejections)
  and structured attack episodes. Parking only the *hardware + training*,
  not the data collection.

## 2. What transfers from the research (2026-09-22, re-scan when funded)

- **Base model:** Qwen3-8B/32B (Apache-2.0) — recommended; runs + trains on a
  single 24 GB GPU. Kimi K3 (2.8T, custom license) and DeepSeek-R1 (671B) are
  out of reach for self-hosting; GLM-4.x open as backup base.
- **Recipe donor:** RedSage (ICLR 2026) — CPT→SFT→DPO curriculum + public
  corpora (~11.7B-token cyber-filtered corpus, 265k dialogues, 30k-MCQ
  benchmark). Weights are "research/educational" — **use datasets/recipe,
  train our own weights**; re-verify per-dataset terms before use.
- **Agent patterns:** CAI (archived, MIT core) for cyber agent roles; our own
  `lib/agent.ts` loop remains the product agent; CALDERA (Apache-2.0) already
  the lab engine in the NOW plan.

## 3. Architecture (unchanged in shape from old Task 90)

```
              [ lib/ai-router.ts  (built in NOW plan Phase A) ]
                 |                    |                     |
       local/default (vLLM       premium fallback        frontier/complex
       OpenAI-compatible)        (Channelry)             (cost-capped)
            our weights             today's path
```

- Router + `AiUsageLog.route` land in the NOW plan as pure architecture (no
  GPU), so this plan's activation is: point routes at the new vLLM endpoint,
  run canaries, promote roles.
- **Pay-as-you-go GPU activation (owner directive):** when funds arrive we
  rent an external pay-as-you-go GPU; **users trigger GPU jobs and pay per
  usage; payments top up our GPU account** — the lab/GPU becomes
  revenue-covered, not a cost center.

## 4. What gets built when funded (in order)

### F1 — GPU host + serving
- Rent pay-as-you-go 24 GB GPU (4090/3090 class, ~$0.4–0.7/hr); vLLM serving
  Qwen3-8B AWQ behind WireGuard + token auth; never public DNS; circuit
  breaker falls back to Channelry automatically.
- Customer lab tiers, if live by then, run their disposable ranges on the
  same pay-per-use host — users pay per run, payments top up the account.

### F2 — First local routing (cost win)
- Route digests + classification + lab narration locally; canary 5→50→100%
  per role with quality gates (within 5% of Channelry baseline, zero unsafe
  tool args in 200-call canary).

### F3 — Our tuned weights (training begins)
- QLoRA SFT v1: RedSage datasets (license-checked) + NOW-plan data
  (gated proposals, approvals/rejections, lab episodes) + general replay.
- DPO v1 from approval/rejection pairs. Monthly candidates; each faces
  RedSage-Bench + our task evals; promote only on win.

### F4 — Scale + productize
- 32B AWQ for hard roles; bigger box if economics say so; user-triggered
  GPU billing surfaces (per-run pricing, prepaid GPU credits in SpaceWorker).

## 5. Guards that carry over (unchanged)

1. Model server is agent-infra: private, token-authed, never public.
2. Training data: consent flag + PII scrub before any example enters a set.
3. Router failure = premium fallback, never user-visible breakage.
4. License manifest per dataset/weights, re-verified at use time.
5. Customer-facing lab tiers only behind the L4 fences (isolation,
   attestation, allow-listed scenarios, lawyer-reviewed AUP).

## 6. Open items (owner, when funded)

- Budget envelope (rent-to-start vs buy rig), pay-as-you-go provider choice,
  per-usage pricing model for user-triggered jobs, and whether customer lab
  tiers launch together with the GPU or after.
