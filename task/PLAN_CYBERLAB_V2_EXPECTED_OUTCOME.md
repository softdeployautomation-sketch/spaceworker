# PLAN — CyberLab V2: Revised Expected Outcome

Status: **DRAFT — supersedes the S7/tool-bridge plan as the active direction. Owner to confirm the gates in §6.**
Written 2026-10-14 after UI-1 deployed (`3765ab4`, gates green). Playbook: `HOW_WE_MOVE_FAST.md`. Prior: `TASK_156B_CYBERLAB_STANDALONE_UI_STEPS.md`, `PLAN_CYBERLAB_NEXT_S7_REPLAY_AND_TOOL_BRIDGE.md` (S7/tool-bridge remain valid *later* slices — see §5).

---

## 0. The expected outcome (owner's words, verbatim intent)

> "the initial plan is to be able to run scans, look for vulnerabilities first before we can then use the agent as a simulation to a malware to see how easy it is to break into, then we learn to protect better"

CyberLab is a **learn-to-defend lab**, not a device-locked attack toy. The intended journey:

1. **Scan / recon first** — no agent, no device ownership needed. Scan a host, an IP range, WiFi, etc. to *find* attack surface.
2. **Find vulnerabilities** — surface what a real attacker would find.
3. **Then (optionally) simulate the agent as malware** — show how easy it is to get in *if* a machine is exposed.
4. **Learn to protect better** — the payoff: what to fix.

Plus product-level changes: a **light/dark toggle** (it's stuck dark today), an in-app **"how to use it" guide**, a **guide + user-access picker in admin**, and CyberLab becomes **its own subscription** (no longer bundled in Premium Plus) with a **request-access flow** like every other product.

## 1. What is live today (the honest baseline)

- Standalone `/cyberlab` Operation Console: stage rail · radar · live feed; `SIMULATION · YOUR EQUIPMENT` watermark; signed episodes; SSE replay. Gates: tsc 0, eslint 0, test:lab 51/51.
- **It is dry-run only.** The single scenario (`smoke-network-baseline`, `lib/lab/scenarios.ts`) generates SYNTHETIC telemetry; no packet leaves the platform.
- **A run requires an attested target first** (`components/cyberlab-ops-console.tsx`: "Pick at least one attested target for the run"). This is the opposite of scan-first — it's the biggest divergence from the vision.
- **Access = Premium Plus.** `lib/entitlements.ts`: tier-5 premium is a catch-all that currently includes the `cyberlab` key. No dedicated CyberLab product/request/grant-UI exists.

## 2. Confirmed codebase facts (real greps, 2026-10-14)

- **Theme:** app toggles a `.dark` class on `<html>` from `localStorage["spaceworker-theme"]` (dark-by-default) — `app/layout.tsx` inline script + `components/theme-toggle.tsx`. The lab's `.lab-ops` block in `app/globals.css` hard-codes dark vars and does NOT respond to `.dark`, so the lab is permanently dark. Fix = dual-variant palette (`.lab-ops` light, `.dark .lab-ops` dark) + drop the existing `ThemeToggle` into the lab header. Reuses the house toggle — no new infra.
- **Entitlements:** `lib/entitlements.ts` `ENTITLEMENT_KEYS = [extractor, mailer, assistant, devices, cyberlab, hosting, browser]`; `hasEntitlement` returns `premium | grant | xdevice | none | expired`. `UserEntitlement` (schema:2165) already models per-user grants: `{userId, key, source: "module"|"admin_grant"|"trial", expiresAt?, revokedAt?}` with `@@unique([userId,key])`. **Admin-granting cyberlab is already representable** — only a UI + a product/request flow are missing.
- **Request flow:** the house "request access" pattern is ticket-based — `app/dashboard/billing/page.tsx` `PremiumRequestCard` submits a request that an admin turns into an invoice/grant (web_subscription | xdevice today). CyberLab's own request card mirrors this exactly.

## 3. Slices (recommended order)

- **Slice 1 — Theme + guide (BUILDING NOW, safe).** Make `.lab-ops` follow the app light/dark toggle; add `ThemeToggle` to the lab header; add an honest in-console "How Cyber Lab works" guide (the 8-stage kill chain, the scan→simulate→protect journey, and today's dry-run reality). No behavior/security change.
- **Slice 2 — Scan-first recon (GATED, security-model change).** New recon scenarios that run WITHOUT an attested target (host/range/WiFi scan), producing findings. Restructure so attestation gates only the *agent-simulation* phase, not scanning. This deliberately relaxes the current "attest before run" line — needs explicit owner sign-off (gate 2).
- **Slice 3 — Agent-as-malware simulation (GATED, builds on Slice 2).** After recon finds an exposed surface, optionally run the agent sim to demonstrate ingress, then the protect/defend payoff.
- **Slice 4 — Standalone subscription + request access (GATED, shared-file risk).** Remove `cyberlab` from the Premium Plus catch-all; add a CyberLab product + request card (mirror `PremiumRequestCard`); admin grants via the existing `UserEntitlement` (`source:"admin_grant"`). Touches `lib/premium.ts`/`entitlements.ts`/`products.ts`/billing — coordinate with the other agent.
- **Slice 5 — Admin guide + user-access picker (GATED, builds on Slice 4).** An admin CyberLab page: the owner's guide ("how to understand and test this") + a picker to grant/revoke cyberlab per user.
- **Slice 6 — S7 Episode Replay + tool bridge (LATER).** From `PLAN_CYBERLAB_NEXT_...md`, unchanged — the "video-ad factory" and mailer/extractor/RMM deep-links. Not superseded; simply deprioritized behind the learn-to-defend core.

## 4. Hard lines (unchanged, carried through every slice)

- Nothing on screen moves unless a real event moved it. Rings are layout, not latency.
- `signatureValid` is always server-recomputed from the stored row; the client never trusts or fabricates it.
- `SIMULATION · YOUR EQUIPMENT` watermark on every panel.
- **Scan-first safety:** recon (Slice 2) must be non-invasive and within attested/authorized scope; the moment anything touches a real host it re-enters the attested-target + verified-teardown discipline. No unscoped scanning of third parties.
- Local commit on `main` only; **no push / no deploy** without the deploy owner's word. Zero file overlap with the other agent's `spaceworker` hosting work — EXCEPT Slice 4, which deliberately touches shared entitlement/premium/billing files and must be sequenced with them.

## 5. Deprioritized-but-alive

S7 Episode Replay + tool bridge (mailer/extractor/RMM deep-links) remain the "sales/ad" layer. They come after the learn-to-defend core (Slices 2–3) is real, because a replay of a scan→exploit→defend chain is far more compelling than a replay of today's dry-run.

## 6. Owner gates (needed before the gated slices build)

1. **Slice 1 theme approach OK?** Lab follows the SAME app-wide light/dark toggle (dark stays the default, matching the rest of the product) — rather than a lab-only theme. *(Confirm; building now on this assumption.)*
2. **Slice 2 — relax "attest before run"?** Approve that pure recon/scanning can run without a pre-attested device, gated only by entitlement + a safe-scope check, with agent-simulation still requiring attestation. This is the core of scan-first.
3. **Slice 4 — pull CyberLab off Premium Plus?** Existing Premium Plus users today get CyberLab via the catch-all. Removing it means current premium users LOSE access unless separately granted/subscribed. Approve this (and whether to grandfather current users for a grace period).
4. **Slice 4 — billing/entitlement files are shared with the hosting agent's area.** Sequence CyberLab subscription work after their in-flight task, or accept a coordinated merge?
5. **Slice 5 — admin guide location:** a dedicated `/admin/.../cyberlab` page (guide + user picker) — confirm.

## 7. This turn's build (Slice 1 only)

- `app/globals.css` — split `.lab-ops` into light + `.dark .lab-ops` dark variants; keep the SOC feel but readable in light mode. Remove the "always-dark regardless of toggle" claim.
- `app/cyberlab/layout.tsx` — stop forcing dark; let it inherit the `.dark` class.
- `components/cyberlab-ops-console.tsx` — add the house `ThemeToggle` to the header; add a "How Cyber Lab works" guide panel (collapsible) explaining the scan→simulate→protect journey + today's dry-run status, honest about what is and isn't live yet.
- `tests/lab-ui1.test.ts` — extend copy guards: guide present, toggle present, theme vars resolve in both modes.
- Gates: `tsc --noEmit` 0 · eslint 0 · `npm run test:lab` green. Local commit only.

