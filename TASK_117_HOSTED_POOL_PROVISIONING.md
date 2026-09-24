# Task 117 (bit B7) — Hosted PC pool: provision the machine our clones actually run on

**Repo:** `spaceworker` (+ `vantra` if the agent/identity path needs it).
**Written:** 2026-09-24. **Status: SCOPED — awaiting the three decisions at the end.**
**Pipeline:** `PIPELINE_CONSOLE_BROWSER_CLONE.md` (bit **B7**; unblocks B4's
`no_hosted_clone_device` for every account, including one-PC users).

> ## AGENT CONTRACT
> This file is the DEPLOYABLE RULEBOOK for the hosted pool. It exists because the
> previous guidance was wrong in a way that risked a customer's machine.

## Owner's directive (2026-09-24) — the misreading this task corrects

> "i dont understand the connection of wilk to sc. they are different devices, sc
> is for testing and wilk is a customer we cant just run test that could trigger
> a popup.. it has to be perfect before doing that.. the design is to clone a
> device browser and open it on our app with the proxy routing through the device"

Three things were being conflated, and two prior documents (`TASK_114`,
`TASK_116`) had already sent the owner down the wrong path:

1. `Sc` is the **test VM**. `WilkSF9` is a **customer's** PC.
2. A **customer device must never** be used as clone infrastructure, a test
   target, or a fallback — a clone action can raise a visible popup on their
   screen. This is now a hard rule, not a preference.
3. The **clone host is OURS.** The design was never "run the copied browser on
   the customer's second PC".

## The design, restated — and confirmed against the code

| Role | Who owns it | Device row | What runs there |
| --- | --- | --- | --- |
| **Device A — work PC** | the customer | `deviceKind "workstation"` | interactive browser `capture` (cookies/keys, DPAPI-decrypted locally); the **relay** (`cmd/relay`, `--addr 127.0.0.1:8118`) so egress is **their IP** |
| **Device B — hosted PC** | **SpaceWorker** | `deviceKind "hosted"` | `receive` → `inject` → `launch`: the copied browser runs **here**, and is streamed into the SpaceWorker UI |

So: the profile is captured on the customer's machine, the relay stays on the
customer's machine (that is what makes the IP theirs), and the **browser itself
runs on our pooled hosted PC**. "Open it on our app with the proxy routing
through the device" — exactly.

Evidence this is the intent, already in the repo:

- `prisma/schema.prisma` — Device A `deviceKind "workstation"` is documented as
  the clone **source** and Device B `deviceKind "hosted"` as the clone
  **destination**.
- `DESIGN_BROWSER_CLONE_UI_AND_FLOW.md` §7 — "**Hosted PC: pooled** (not
  one-per-user) for now — the host is a shared resource. Admin sets the pool cap."
- `PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md` — "hosted clone PCs are **dedicated
  hosted devices**".
- `lib/clone-settings.ts` — `hostedPoolSize` (default **1**), an `AdminSetting`.

## Why the pool is empty (the actual gap)

1. **`deviceKind` is only ever read.** `Device.deviceKind = "hosted"` appears in
   exactly one place, `app/api/admin/clone-limits/route.ts` (a count). Something
   writes it **nowhere**, so `pooledHosts` is permanently 0 and `hostedPoolSize`
   is a dial nothing acts on.
2. **The transport expects an *agent* on the host.** `runCloneReceive` /
   `runCloneLaunch` address the destination by its `vantraAgentId`, which today
   can only come from a customer-side install.
3. **The only installer we shipped is customer-facing and Windows-only.**
   `install-hosted.ps1` is exposed through the per-device "Set up as clone host"
   button — which is precisely how `Sc` came to be marked a clone host, and how
   the "set up a second PC" copy got invented.

**Corollary already true in code and NOT to be "fixed":** a clone can never run
on the machine it captures from (`pickHostedCloneDevice` excludes the source;
`same_device` is refused). That is a permanent rule, not a bug.

## Technical feasibility — checked, not assumed

The earlier claim "a VPS cannot be the clone host (needs a visible desktop
session)" is **false**, and the engine says so itself:

- `runPreflight` documents an explicit branch for "**POSIX hosted servers**
  isolate by ownership and mode (root-owned, 0700…)".
- `pkg/browser/detect.go` resolves the browser from **`PATH` first** ("POSIX dev
  hosts, Chrome for Testing installs") and only then Windows install paths.
- Non-Windows builds exist: `pkg/crypto/dpapi_other.go`,
  `pkg/injection/disk_free_unix.go`, `pkg/injection/injector_posix_test.go`.
- `DESIGN_…` §5: "use **headless clone** on the hosted PC (the engine **already
  launches headless for validation**)".
- And the customer-visible surface already works this way: the existing
  private-browser runs Chromium in a container (`browser-server/`, Neko) and
  streams it into the app.


## Deliverables, in order (D1 is a spike and gates everything)

| # | Deliverable | Why it is here / what "done" means |
| --- | --- | --- |
| **D1** | **Profile-portability spike (no UI).** Prove a Windows-captured profile can drive a browser **on the hosted PC**. | THE technical risk. Windows Chrome cookie values are AES-GCM encrypted with a DPAPI-protected key from `Local State`; `capture` already decrypts that locally and re-encrypts for transport (`pkg/crypto/password_handler.go`). Injection must then emit a profile the **host's** browser accepts — either by writing a host-valid `os_crypt` key in `Local State`, or by launching the host browser with `--password-store=basic` and writing matching values. **Done =** a containerised browser on the host, started from a real `Sc` capture, is signed in to a test site it never logged into. If this fails, D2+ are re-planned before more is built. |
| **D2** | **Hosted-PC identity + registration.** A `Device` row with `deviceKind="hosted"` and the `clone-host` capability, owned by a **system tenant** — never a customer account. | Registers idempotently (re-running setup must not duplicate), and enforcement exists for `hostedPoolSize`: the pool is capped by the dial (CROSS-TRACK RULE 7), and the count-0 bug can never return. |
| **D3** | **Transport both ways.** (a) The parcel reaches the host (`POST /rmm/inject-clone`, chunked + HMAC-signed, key provisioned out-of-band); (b) the hosted browser reaches the **customer's relay** so egress keeps their IP. | The relay is `127.0.0.1:8118` **on the customer's PC**, so this needs an agreed path (agent-forwarded port vs the relay dialling out). Fail closed, as `relayRequired` already demands. |
| **D4** | **Session streaming into the app.** The hosted browser is usable from the SpaceWorker UI (reuse the Neko / `browser-server` pattern). | Matches the private-browser UX that already works, and is what "open it on our app" means. |
| **D5** | **UI truth-telling.** "Set up as clone host" stops being a customer-facing task; the clone tab reports **hosted-pool status** instead. | This is the fix for the misconception that caused this task. The copy in `TASK_116` already stops instructing users to provision hardware; D5 finishes the job by moving the button to an ops surface. |
| **D6** | **Lifecycle.** TTL/teardown/purge for hosted sessions + `TASK_105` governor integration so RAM caps and queueing apply to the pool like every other high-RAM consumer. | `hostedPoolSize` is a RAM dial; the governor owns RAM admission. |

## Non-negotiable guardrails

1. **A customer device is never clone infrastructure.** Not a clone host, not a
   test target, not a fallback, not a probe. `WilkSF9` specifically: no clone,
   no setup click, no experimental command — a clone can raise a visible popup on
   a customer's screen, so it must be perfect first.
2. **Test on `Sc` (the test VM) and on the hosted pool. Nothing else.**
3. **Same-device hosting stays refused.** Do not "fix" `self_only` by allowing a
   device to host its own clone.
4. **No new customer-facing button may instruct a user to provision hardware we
   are supposed to own.** If copy needs to name a fix, it must name a
   SpaceWorker-side action.

## Verification

- D1 proved with a **real capture** from `Sc` and a signed-in check on the host.
- D2 proved by: pool count goes `0 → 1`; re-running registration leaves it `1`;
  `hostedPoolSize` gates a second host.
- D3 proved by: a launch reaches the relay (relay-mode egress shows the
  **customer's** IP) and **aborts** when the relay is down (`relayRequired`).
- D4/D5/D6 proved live, then re-tested against a fresh `Sc` console.
- Every step: never touch `WilkSF9`.

## Decisions needed from the owner before D2 starts

- **Q1 — where does the hosted PC run?** *(a)* a **Linux container on our VPS**,
  reusing the private-browser/Neko pattern — cheapest, no per-host licence, but
  depends on D1; or *(b)* a **dedicated Windows VM we control** — matches the
  current `install-hosted.ps1` path exactly, but adds a paid unmanaged box to run
  and patch. **Recommendation: (a), with D1 as the go/no-go.**
- **Q2 — is a headless hosted browser acceptable for the first end-to-end clone?**
  The user sees it only through our app (same as the private browser today).
  **Recommendation: yes** — that is the design, and it avoids needing a real
  desktop session.
- **Q3 — remove the customer-facing "Set up as clone host" button entirely**
  (ops-only), now that the host is ours? **Recommendation: yes, in D5.**

## Rollback

Nothing in `TASK_116`/this scope changes existing customer behaviour: the pool
stays empty until D2 lands, and the console copy now describes that state
truthfully instead of asking a user to build us a server.
