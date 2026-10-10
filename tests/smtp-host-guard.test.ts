import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

// 2026-09-28 — `validatePublicSmtpHost` + the own-relay allowlist.
//
// WHY THIS FILE EXISTS: Task 51 made the SMTP host guard reject every
// loopback/private/link-local host, because "Test connection" otherwise turned
// into an authenticated port-scan oracle against the VPS's own network. That is
// still exactly right for a host a USER types. But it also blocked the one
// internal SMTP target that is deliberately ours: the local Postfix sending
// relay bound to 127.0.0.1, which the platform runs so a customer's broken or
// unreachable third-party SMTP server cannot stop campaigns going out.
//
// The allowlist that re-permits it is read from the OPERATOR's environment, and
// the two properties that keep the original hole closed are invisible in the UI
// and easy to regress:
//
//   1. An allowlist entry MUST carry an explicit port, and the caller must pass
//      the same port. A portless allowlist entry would silently re-permit
//      probing EVERY loopback port — i.e. re-open precisely what Task 51 fixed.
//   2. With no allowlist configured, nothing changes: loopback, RFC1918,
//      link-local and the cloud metadata address all stay blocked.
//
// The module under test is the REAL `lib/smtp-host-guard.ts` — not a copy of its
// logic — loaded through the house require hook (HOW_WE_MOVE_FAST §4), with its
// DNS resolver swapped for a table so no test touches a real resolver.

process.env.SMTP_INTERNAL_RELAY_HOSTS = "";

type Loader = {
  _load: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown;
};

const MODULE_UNDER_TEST = "lib/smtp-host-guard.ts";

/** A tiny hermetic DNS table: hostname -> addresses per family. */
const dnsTable = new Map<string, { v4: string[]; v6: string[] }>();
function setDns(name: string, v4: string[] = [], v6: string[] = []): void {
  dnsTable.set(name, { v4, v6 });
}

setDns("smtp.gmail.com", ["142.250.185.109"], ["2a00:1450:400c:c05::6c"]);
// 2026-10-10 — resolvers (macOS/Windows getaddrinfo) can hand back an
// IPv4-MAPPED IPv6 even for a family:4 lookup; caught live creating a mailbox
// in the mailer EXE. The guard must judge the embedded IPv4, not read "ffff"
// as multicast.
setDns("smtp.mapped-v4.test", ["::ffff:142.250.185.109"]);
setDns("smtp.mapped-v4-internal.test", ["::ffff:127.0.0.1"]);
setDns("smtp.mapped-v4-private.test", ["::ffff:10.0.0.5"]);
setDns("relay.internal", ["127.0.0.1"]);
setDns("db.internal", ["10.0.0.5"]);
setDns("metadata.internal", ["169.254.169.254"]);

function installRequireHook(): void {
  const loader = Module as unknown as Loader;
  const original = loader._load;
  loader._load = function patched(request, parent, isMain) {
    if (request === "server-only") return {};
    const from = (parent?.filename ?? "").replace(/\\/g, "/");
    if (
      request === "dns/promises" &&
      (from.endsWith(`/${MODULE_UNDER_TEST}`) || from.endsWith("/lib/smtp-host-guard"))
    ) {
      return {
        lookup: async (name: string, opts: { family: number; all?: boolean }) => {
          const row = dnsTable.get(name);
          const list = (opts.family === 4 ? row?.v4 : row?.v6) ?? [];
          if (list.length === 0) throw new Error("ENOTFOUND");
          const all = list.map((address) => ({ address, family: opts.family }));
          return opts.all ? all : all[0];
        },
      };
    }
    return original.call(this, request, parent, isMain);
  };
}

installRequireHook();

/* eslint-disable @typescript-eslint/no-require-imports */
const {
  validatePublicSmtpHost,
  internalRelayAllowlist,
  isInternalRelayAllowed,
  NonRoutableSmtpHostError,
} = require("../lib/smtp-host-guard") as typeof import("../lib/smtp-host-guard");
/* eslint-enable @typescript-eslint/no-require-imports */

const ENV = "SMTP_INTERNAL_RELAY_HOSTS";

/** True when the guard rejected the host with its own specific error type. */
async function rejected(host: string, port?: number): Promise<boolean> {
  try {
    await validatePublicSmtpHost(host, port);
    return false;
  } catch (err) {
    assert.ok(
      err instanceof NonRoutableSmtpHostError,
      `expected a NonRoutableSmtpHostError for ${host}, got ${String(err)}`
    );
    return true;
  }
}

async function withAllowlist(value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const previous = process.env[ENV];
  if (value === undefined) delete process.env[ENV];
  else process.env[ENV] = value;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env[ENV];
    else process.env[ENV] = previous;
  }
}

test("no allowlist: loopback and private hosts are still blocked (Task 51 intact)", async () => {
  await withAllowlist(undefined, async () => {
    assert.equal(await rejected("127.0.0.1", 587), true);
    assert.equal(await rejected("10.0.0.5", 587), true);
    assert.equal(await rejected("192.168.1.10", 25), true);
    assert.equal(await rejected("169.254.169.254", 80), true, "cloud metadata must stay blocked");
    assert.equal(await rejected("::1", 587), true);
  });
});

test("no allowlist: a public host is unaffected", async () => {
  await withAllowlist(undefined, async () => {
    assert.equal(await rejected("smtp.gmail.com", 587), false);
  });
});

test("the allowlisted host:port is permitted", async () => {
  await withAllowlist("127.0.0.1:587", async () => {
    assert.equal(await rejected("127.0.0.1", 587), false);
  });
});

test("a portless allowlist entry is ignored — it would re-open port scanning", async () => {
  await withAllowlist("127.0.0.1", async () => {
    assert.deepEqual(internalRelayAllowlist(), [], "portless entries must parse to nothing");
    assert.equal(await rejected("127.0.0.1", 587), true);
    assert.equal(await rejected("127.0.0.1", 3306), true);
  });
});

test("the allowlist is port-specific: another port on the same host stays blocked", async () => {
  await withAllowlist("127.0.0.1:587", async () => {
    assert.equal(
      await rejected("127.0.0.1", 3306),
      true,
      "must not become a probe for other loopback ports"
    );
    assert.equal(await rejected("127.0.0.1", 25), true);
  });
});

test("a caller that cannot supply a port gets the strict behaviour", async () => {
  await withAllowlist("127.0.0.1:587", async () => {
    assert.equal(await rejected("127.0.0.1"), true);
    assert.equal(isInternalRelayAllowed("127.0.0.1", undefined), false);
  });
});

test("a hostname resolving to the allowlisted relay address is permitted on that port", async () => {
  await withAllowlist("127.0.0.1:587", async () => {
    assert.equal(await rejected("relay.internal", 587), false);
    // ...but not on a port the operator did not allow.
    assert.equal(await rejected("relay.internal", 2525), true);
  });
});

test("a private host NOT in the allowlist stays blocked even when it resolves", async () => {
  await withAllowlist("127.0.0.1:587", async () => {
    assert.equal(await rejected("db.internal", 587), true);
    assert.equal(await rejected("metadata.internal", 587), true);
  });
});

test("an unresolvable host fails closed", async () => {
  await withAllowlist("127.0.0.1:587", async () => {
    assert.equal(await rejected("does-not-exist.internal", 587), true);
  });
});

test("allowlist parsing: whitespace, IPv6 brackets, junk and out-of-range ports", async () => {
  await withAllowlist(" 127.0.0.1:587 , [::1]:2525 ,, not-a-pair , 127.0.0.1:70000 ", async () => {
    assert.deepEqual(internalRelayAllowlist(), [
      { host: "127.0.0.1", port: 587 },
      { host: "::1", port: 2525 },
    ]);
  });
});

test("IPv4-mapped IPv6 answers are judged by their embedded IPv4 (2026-10-10)", async () => {
  await withAllowlist(undefined, async () => {
    // A mapped PUBLIC address must pass — before the fix, "ffff" read as the
    // first hextet of ff00::/8 multicast and every mapped answer was blocked.
    assert.equal(await rejected("smtp.mapped-v4.test", 465), false);
    // Mapped loopback / RFC1918 must still be blocked.
    assert.equal(await rejected("smtp.mapped-v4-internal.test", 465), true);
    assert.equal(await rejected("smtp.mapped-v4-private.test", 465), true);
  });
});
