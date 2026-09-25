# Task 118 (bit B8) — make the CLONE DESTINATION real, then launch it

**Depends on:** B7 (`TASK_117_HOSTED_POOL_PROVISIONING.md`) — the decision to reuse the
Neko private browser as the clone destination, and the D1 findings that killed the
cookie-capture route.
**Supersedes for launch:** the destination-agent path in `runCloneLaunch`.
**Guardrail:** never touch `WilkSF9`. All testing on `Sc` only.

Owner, 2026-09-25: **"close this browser clone and let me test it and see it worked"** —
and route 3 from TASK_117 F10 is confirmed: **no cookie transfer.** The clone is a
browser on our infrastructure whose traffic exits through the user's device. The user
logs in inside it. Nothing is copied from their machine.

---

## The four defects that make "click Start" impossible today (all measured in code)

**1. `Device.deviceKind = "hosted"` is read in exactly one place and WRITTEN NOWHERE.**
The only reader is `app/api/admin/clone-limits/route.ts:54` (`prisma.device.count({ where
: { deviceKind: "hosted" } })`). Nothing anywhere creates such a row. So the pool is
permanently 0 and the admin `hostedPoolSize` dial controls nothing. This is the root
cause of the owner's original *"clone host is ready, and i clicked start clone, and its
still say no host"*.

**2. The picker structurally cannot ever select a hosted browser.** `hostAvailability`
(`lib/clone-hosts.ts:112`) filters `device: { userId, vantraAgentId: { not: null } }`, and
`pickHostedCloneDevice` returns that. A Neko container has **no Vantra agent**, so even a
correctly-provisioned hosted row would be filtered out by that clause.

**3. Launch has no hosted path at all.** `runCloneLaunch` (`lib/clone-transport.ts:466`)
POSTs to Vantra `/api/internal/sw/devices/<agentId>/clone/launch` — an **agent RPC on the
destination**. A hosted browser has no agent, so even with 1 and 2 fixed the launch step
would fail. The destination must instead be driven through **our own** `browser-server`.

**4. THE LONG POLE — same-IP egress has no data path.** The relay is **loopback-bound on
the work PC**: `lib/clone-setup.ts:53` pins `RELAY_ADDR = "127.0.0.1:8118"`, and
`cmd/relay/main.go:4` documents it as *"Loopback-bound in production (**replayed over the
Mesh tunnel**)"*. **That tunnel does not exist in either repo** — a grep for tunnel/mesh
in `spaceworker/lib`, `spaceworker/app` and `vantra/*` finds only MeshCentral *viewer URL*
helpers and the bundle streaming POST (`pkg/transport/http_stream.go`, `/rmm/inject-clone`),
which is a one-way parcel upload, not a TCP path. `install-relay.ps1`'s `0.0.0.0:8080`
default is explicitly the **lab/topology** binding, not production. So today the hosted
container on the VPS cannot dial the device's loopback relay — **same-IP egress is not
merely unconfigured, it is unreachable.**

This is why the pipeline's capture → transfer → inject → launch chain cannot carry a Neko
destination: it was built to push a *bundle* to a *second agent PC*, and with route 3
there is no bundle and no second PC.


---

## The bits, in dependency order

### B8-1 — the hosted destination becomes a real, selectable thing
- Provision a hosted destination row: `deviceKind = "hosted"`, `clone-host` capability
  enabled, `vantraAgentId = null` (see **Q1** for ownership).
- Teach `hostAvailability`/`pickHostedCloneDevice` that a hosted destination is legitimate
  **without** an agent and **without** a heartbeat: it is our process, so "online" means
  *our browser service is up*, not *the agent checked in*. The user-device rule stays
  unchanged for workstation hosts.
- Make the admin pool count (`clone-limits`) reflect reality, so `hostedPoolSize` finally
  gates something.
- **Verifiable:** the console's Device-setup card stops saying "no hosted PC", and Start
  passes the `no_hosted_clone_device` gate.

### B8-2 — hosted launch (the clone actually appears)
- For a job whose destination is hosted, **skip capture / transfer / inject** — there is
  nothing to copy (route 3) — and go straight to a launch that starts a browser session
  through `browser-server`, reusing the private-browser machinery that already exists
  (`--proxy-server` injection, per-session Neko password, `HostedBrowserSession` row).
- Surface the session URL in the clone console so the user can **open the clone**.
- **Fail closed and label honestly:** if relay egress cannot be provided, the launch must
  **refuse with a named reason** — never silently fall back to our own IP, because a clone
  that claims the user's IP but egresses from ours is worse than no clone (it breaks the
  product promise and burns our IP).
- **Verifiable:** click Start → a browser session starts; the console shows it; the
  session's egress mode is exactly what the record says.

### B8-3 — relay reachability (reverse tunnel) — THE LONG POLE
- Give `cmd/relay` a **dial-out** mode: the relay connects out to our infrastructure and
  serves the proxy over that connection, so no inbound port, firewall rule or NAT entry is
  needed on the user's side. Server side gets a local listener (beside the browser
  container) that presents the device's relay as a normal proxy address the container dials.
- Alternative considered and **not** chosen: MeshCentral's TCP tunnel — not implemented in
  either repo, aimed at interactive RDP/SSH forwarding, and it would make the clone's egress
  depend on a web session instead of our own agent.
- Keep the existing bearer-token auth (`--token`), add per-user scoping, and keep the
  fail-closed gate: no reachable relay → no relay-mode clone.
- **Verifiable:** a clone reports the **device's public IP** as its exit IP, and the launch
  **aborts** when the relay is down.

### B8-4 — retire the copy that no longer applies
With a hosted destination, **single-PC cloning becomes legitimate** — the user no longer
needs a second machine. The `self_only` refusal and the "you need one more PC" family of
copy must go, and the Device-setup card must stop asking the user to set up a *second*
machine (that ask is what sent the owner round the loop in the first place).

---

## Owner decisions needed before B8-2

- **Q1 — identity of the hosted destination.** One shared hosted destination row for all
  accounts, or one per account? (Affects queueing fairness, per-user isolation of the
  browser profile, and whether the pool size means "global slots".)
- **Q2 — is a clone that egresses from OUR IP acceptable as an interim**, clearly labelled,
  while B8-3 is built? **Recommendation: no** — it contradicts the product promise, and the
  codebase already treats direct egress as premium and explicitly labelled. If the answer is
  yes, it must be labelled in the console and in the audit, never implied.
- **Q3 — B8-3 tunnel shape.** Our own dial-out relay (recommended: ~200-300 lines across
  `cmd/relay` + a server listener + tests) or MeshCentral's tunnel (not implemented here).

## Verification for the bit as a whole
- Start from `Sc` in relay mode → clone record created → session launched → **exit IP is the
  device's**, not ours; and with the relay stopped, the launch **refuses** with a reason that
  names the relay.
- Every step writes the audit row it already writes; no step may report a mode it did not use.
- Never `WilkSF9`. The VM is left clean afterwards.

## Rollback
Additive: a new destination row, a launch path selected by `deviceKind`, and a new relay
mode. The existing workstation-host path stays byte-for-byte intact, so reverting is
removing the hosted row — and the gate returns to the honest `no_hosted_clone_device`
refusal it makes today.
