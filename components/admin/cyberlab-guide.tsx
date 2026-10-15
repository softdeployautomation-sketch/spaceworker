// TASK_156B Slice 6 (owner ask: "add a guide in the admin so I can understand
// and test this better"). A static, zero-state, zero-fetch runbook rendered at
// the TOP of the admin Cyber Lab tab — the owner reads it once and knows the
// whole loop: grant → scan (real packets) → break-in sim → replay → protect.
// FACTS ARE PINNED BY tests/cyberlab-admin-guide.test.ts — keep the egress
// field names, the money-flow steps and the honesty statements in sync with
// the engine (lib/lab/*) and schema when behaviour changes.

export function CyberLabGuide() {
  return (
    <section
      data-cy="cyberlab-guide"
      className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/40 p-4 sm:p-6"
    >
      <h3 className="text-lg font-semibold tracking-tight">
        Guide — run the loop, then close the doors
      </h3>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        Cyber Lab is an authorized offensive-security lab for testing your own
        environment. It is <b>not part of Premium Plus</b> — access is per-user
        (granted below, or via the add-on request flow) and every run is
        recorded as a signed, tamper-evident episode.
      </p>

      <h4 className="mt-4 text-sm font-semibold">1 · Grant yourself (or a worker) access</h4>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        Users tab → the user row → <b>Cyber Lab</b> column → 30 / 90 / 365 /
        Custom. Without a grant, /cyberlab shows the add-on lock — Premium Plus
        does not include Cyber Lab, so even a tier-5 user needs this grant.
      </p>

      <h4 className="mt-4 text-sm font-semibold">
        2 · Scan first — the way real attacks start (no device needed)
      </h4>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        Open /cyberlab → section <b>&quot;1 · Scan for weaknesses&quot;</b> → pick a
        kind (host / network / url / domain / email), declare a scope you are
        authorized to assess (e.g. your test VM&apos;s IP), and run. With live
        egress on (dial below) this sends <b>real TCP probes from our servers</b>{" "}
        to the ports you choose (defaults 22/80/443/3389/8080) and records
        open / closed / filtered from the OS. That is the &quot;can anyone break
        into my VM&quot; first step.
      </p>

      <h4 className="mt-4 text-sm font-semibold">3 · Simulate the break-in (attested device)</h4>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        Stage two: attest a device you own (Devices tab / the console&apos;s
        device picker), then run a scenario — phishing sim via the mailer,
        credential extraction, malware dry-run. Simulations send no packets:
        synthetic telemetry, honestly watermarked SIMULATION.
      </p>

      <h4 className="mt-4 text-sm font-semibold">4 · Watch, replay, then protect</h4>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        Runs stream live (kill-chain rail → radar → evidence feed). Every run
        becomes an episode: <b>Replay ▶</b> scrubs the recorded timeline like a
        video (/cyberlab/replay/[id]) and the signature line shows VERIFIED /
        INVALID exactly as the server computed it. Fix the exposure, re-scan,
        prove it closed.
      </p>

      <h4 className="mt-4 text-sm font-semibold">The egress dials (this tab, above the guide)</h4>
      <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-zinc-500 dark:text-zinc-400">
        <li>
          <code className="text-xs">cyberlabLiveEgressEnabled</code> — the master
          switch for real packets (ships ON; OFF keeps every run in-platform).
        </li>
        <li>
          <code className="text-xs">cyberlabEgressRequireOwnershipProof</code> —
          require a DNS-TXT ownership challenge on public targets before
          probing (off in the grant-only beta).
        </li>
        <li>
          <code className="text-xs">cyberlabEgressScopeGuard</code> — re-apply the
          /24 breadth refusal on declared scopes (off: scan however you like).
        </li>
        <li>
          <code className="text-xs">cyberlabEgressAllowList</code> — comma-separated
          CIDRs/hosts egress may reach; empty = allow all.
        </li>
        <li>Broadcast scopes are always refused, grant or no grant.</li>
      </ul>

      <h4 className="mt-4 text-sm font-semibold">How paying users get in (money flow)</h4>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        User hits the lock → <b>&quot;Request for Cyber Lab&quot;</b> → the support
        request lands in the Support tab queue → send the invoice (plan: Cyber
        Lab, your price, duration in days) → when payment lands, settle the
        linked payment → the entitlement is granted automatically for the
        invoice&apos;s duration. Grants expire on their own; re-grant or
        re-invoice to extend.
      </p>

      <h4 className="mt-4 text-sm font-semibold">If something doesn&apos;t work</h4>
      <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-zinc-500 dark:text-zinc-400">
        <li>
          403 cyberlab_not_entitled → no grant yet — Users tab, Cyber Lab column.
        </li>
        <li>
          Run refused with live_egress_disabled → flip cyberlabLiveEgressEnabled
          on, above.
        </li>
        <li>
          Scan returns nothing → the VM&apos;s firewall / security group, or the
          scope is not reachable FROM OUR SERVERS (the probe source is the
          server, not your laptop).
        </li>
        <li>
          Whole features missing after a deploy → the DB migration was not
          applied (deploy owner: see HANDOFF_CYBERLAB_DEPLOY_ALL.md).
        </li>
      </ul>
    </section>
  );
}
