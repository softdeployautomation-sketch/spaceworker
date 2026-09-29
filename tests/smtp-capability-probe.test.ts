import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import net from "node:net";
import tls from "node:tls";
import type { AddressInfo } from "node:net";

// 2026-09-29 — `probeSmtpCapabilities` / `capabilityWarning` regression test.
//
// WHY THIS FILE EXISTS: a customer added a working WEDOS submission mailbox
// (smtp-184101.m1.WEDOS.net:587) — the same one that had just delivered to Comcast
// — and the Test connection screen told them the server had never asked for a
// password:
//
//   "Heads-up: this server did not ask for a username or password at all (it
//    advertises no AUTH), so your credentials were never actually checked."
//
// while, on the SAME screen, the envelope probe said "the server accepted it".
// Both came from the same live server; only one of them was right.
//
// The server was right to withhold. RFC 4954 §4 / RFC 3207 require a submission
// server to hide its AUTH list until the channel is encrypted, so reading the
// PLAINTEXT EHLO reports "no AUTH" for essentially every real provider — measured
// live on smtp.gmail.com:587 and this WEDOS host, both of which answer the clear
// EHLO with no AUTH line and then offer `AUTH PLAIN LOGIN` after STARTTLS. The
// envelope probe had always spoken that order; the capability probe had not.
//
// The lesson worth keeping: the two probes MUST NOT be able to disagree about
// whether login is available, because the operator sees both at once.
//
// The fake servers below complete a REAL TLS handshake over a real loopback
// socket, so the STARTTLS path is genuinely exercised — no mocking of the thing
// under test, and only the module's own imports are stubbed (house require-hook
// pattern, HOW_WE_MOVE_FAST §4).

type Loader = {
  _load: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown;
};

const MODULE_UNDER_TEST = "lib/smtp-diagnostics.ts";

function installRequireHook(): void {
  const loader = Module as unknown as Loader;
  const original = loader._load;
  loader._load = function patched(request, parent, isMain) {
    if (request === "server-only") return {};
    const from = parent?.filename ?? "";
    if (from.endsWith(`/${MODULE_UNDER_TEST}`)) {
      // Only reachable from the proxy path, which these tests never take.
      if (request === "socks") {
        return {
          SocksClient: {
            createConnection: async () => {
              throw new Error("no SOCKS proxy in tests");
            },
          },
        };
      }
      // The real constants; the transport itself is never built here.
      if (request === "./mailer-send") {
        return { SMTP_CONNECTION_TIMEOUT_MS: 10_000, SOCKS_CONNECT_TIMEOUT_MS: 10_000 };
      }
    }
    return original.call(this, request, parent, isMain);
  };
}

installRequireHook();

/* eslint-disable @typescript-eslint/no-require-imports */
const { probeSmtpCapabilities, capabilityWarning } = require("../lib/smtp-diagnostics") as typeof import("../lib/smtp-diagnostics");
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * A throwaway self-signed cert for the fake server. `upgradeProbeToTls` connects
 * with `rejectUnauthorized: false` on purpose (cert problems belong to `verify()`,
 * not to a diagnostics probe), so this only has to be well-formed — hence 100
 * years of validity rather than anything a test clock could outlive.
 */
const TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCrhJ/TPRFaDb9o
a5gsen8Z6w2Fgr6/xtkjiNK3QJXQZDj9ZBYWrha1gR/fqR4oVPGPjeyMqu2bzkRW
PiCSQJFewl6R9gUg1GXXqLdGT9KEP2f+5IjScfBpJcP8CRVGuteu8DF8zYoYYK30
OgjXC9PSnC2IkDIx8ekXvhwiZajyLmh/E78jI+ZuRDPpO70C0FnYR2EkDtHMOUNJ
RoIW/LLf1WbyDYUGuaDQE/nXeyd5zNuSVM/nUfxyNk7eKBVdxj2gmX21d4PZi07n
GcLfOG1tm6KVVsKp9y/LcSXC4fnfjQx/Xq1dDPT/DFvn/L58V8AuF3V743OgpYIe
Nbp6AYq3AgMBAAECggEADpRb95tPIHNfDAkVVYvmG6BmNQKg+fFKX4xlCQG677di
kXDStdkqLKyOC+I2zOEyQBclfpbq/V2tDmhX4XFj9K+bVVdEe/7CAhvL1HS65YCe
85pJN8ZKqXgghDSLc/M0RqERO9VxlyfksYgbXJhF8wxRNzS2p5XeJVAE2TcArkai
nB31Basw/Ho0xcwZUMZ9sHjN8lo2IGv55qgKOz3PPGyPgpXsT/V59eX/RmDHjhJ6
g27eqqokJVWVWy+XcR0RtnYkrRxbdQT9A09n03TM/Ckg/KmygsZ1N7uh/fD5p8zW
xyxyyJI2DkyFk6qfZt5w9cX/GoJuZGIkrE/lacf6HQKBgQDyjMTNRYTt5sti7lJj
F4SFVG7/3cqK0DnYqAdRDb13AYNP+wlnBFMvoBG6u612X8ZnGZJ7DHYzKLiUeHiu
Xm3N5BM8MfzhuiR3wCBIYaWJUCdPluQucKsoNgzICweQRo9TVI7Qr8SEecDHwQZ5
Jk81tg634f0vlJjHzS1XB4K2BQKBgQC1B31rpQrRHb8s111ZLKDQub3QmvG+2x7u
/EyL1dC7U04SYM3tYWtDaHzbr55U/pL0ScL2aytfEP70zqVJYt9y1EgLL0pbG2QU
7FVyyr9BHJVtT9x8iTY3oIEfar6XPWnXSBbeuI6isaUCm8Bq7yaAu29On3VQ+elm
9W2+gP2+iwKBgATqNVKzhe4MLzLiAWlgoJ7TByzIIcKOVZ2+Seeqj5xJu49zVs1v
mP/uDm3qP6mWZz7PldhIeFyxBox7pHZkE3WImZsuqCEq1HJYwk61K9WMej9yn00R
m2ZFMh0bnBugUmct33b7GNBWZ0Gk96ycyh4cgk/XlHnSWQYzcifBTzTBAoGBAJnG
5gSl6z1eLoKx44sXvPfxgEuPA2IkEu/iBEgY9jnadwxnjSZjxdE6Fi4rzazXoA/C
BMp8mRglgN6GF6PySGvr5dMSdfBUoTyg0ak0jyiJVmnIGDz19cdlIaqFa6dftOP6
SesiDZAopUpE8jwkMKnUDqZUED0cPeeG/pWAT4wnAoGAHP+FBlIlgkQSpgweoo5w
aWA1gUuSJLjdkaDYIdrJOsujyX3mmRqV+0UNrcMwEjtcx4ManvLm7xN9A9T5fjZA
Uw8lui3J2CDOJitxPt2Y8gZ5WW8cLVRXNsGHCkw9eBZaMm622zmOAbhNeN7sBjZa
agwGL/XO37cnGGD9iZiZxG8=
-----END PRIVATE KEY-----`;

const TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDJzCCAg+gAwIBAgIUQD8hZyW2sJNeokgIzhJ2YLf3YagwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MDkyOTA3MDgxNVoYDzIxMjYw
OTA1MDcwODE1WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQCrhJ/TPRFaDb9oa5gsen8Z6w2Fgr6/xtkjiNK3QJXQ
ZDj9ZBYWrha1gR/fqR4oVPGPjeyMqu2bzkRWPiCSQJFewl6R9gUg1GXXqLdGT9KE
P2f+5IjScfBpJcP8CRVGuteu8DF8zYoYYK30OgjXC9PSnC2IkDIx8ekXvhwiZajy
Lmh/E78jI+ZuRDPpO70C0FnYR2EkDtHMOUNJRoIW/LLf1WbyDYUGuaDQE/nXeyd5
zNuSVM/nUfxyNk7eKBVdxj2gmX21d4PZi07nGcLfOG1tm6KVVsKp9y/LcSXC4fnf
jQx/Xq1dDPT/DFvn/L58V8AuF3V743OgpYIeNbp6AYq3AgMBAAGjbzBtMB0GA1Ud
DgQWBBSdFWDX5eoxsnVCij3kTTubW1OM4DAfBgNVHSMEGDAWgBSdFWDX5eoxsnVC
ij3kTTubW1OM4DAPBgNVHRMBAf8EBTADAQH/MBoGA1UdEQQTMBGCCWxvY2FsaG9z
dIcEfwAAATANBgkqhkiG9w0BAQsFAAOCAQEATTFJyeUDkMSDlmdKEHu8FjUWX6ML
Ik0WLPSRaFtmh7mIm9LCFOvc7COoODRv74v/EOaYjk0VEUceEwfi2nXzfqujgXbm
0YQfJf6tBKl2+QK1+vI50td1NZiU0a2DQz3cuNceB8vpGlJLZSWuBW2khsv11BKj
gkSdVPyd1QlP+oC8M0Rysw9J4cSmv/1q1Zb6f5foOdIX0BJ/eNDeemqmm4+ZJNxG
sZlabbcWOtDJVRHysddd9jCQq4UhZot7iMbyJOdT6SiMUCrTsdF8o+Y+12yLGFh4
zfMvgBxdPKUneRu9flWddfmjn7uFq5WcVJMFuM1V7zuOViK+kfq8dow6gA==
-----END CERTIFICATE-----`;

interface Script {
  /** The 220 greeting line, verbatim. */
  banner?: string;
  /** Capability lines advertised by the PLAINTEXT EHLO. */
  ehloBeforeTls?: string[];
  /** Capability lines advertised after a COMPLETED STARTTLS upgrade. */
  ehloAfterTls?: string[];
  /** Advertise STARTTLS, answer 220, then destroy the socket mid-handshake. */
  breakStartTls?: boolean;
  /** Speak TLS from the first byte — models an implicit-TLS port (465). */
  implicitTls?: boolean;
}

interface FakeServer {
  port: number;
  commands: string[];
  /** Every line the server wrote, so a test can prove what each EHLO returned. */
  replies: string[];
  close: () => Promise<void>;
}

/**
 * A real SMTP server on loopback that can complete a real STARTTLS handshake.
 *
 * The pre-existing envelope test writes "220 Ready to start TLS" and then keeps
 * talking plaintext, so nothing in this repo had ever exercised an actual upgrade.
 * Here the socket is handed to `tls.TLSSocket` with `isServer: true`, which is
 * what Postfix itself does — so a passing test means the probe really did encrypt
 * and really did re-ask.
 */
function startFakeServer(script: Script): Promise<FakeServer> {
  return new Promise((resolve) => {
    const commands: string[] = [];
    const replies: string[] = [];

    const runSession = (initial: net.Socket, startEncrypted: boolean) => {
      let socket: net.Socket = initial;
      let encrypted = startEncrypted;
      let buffer = "";

      const write = (text: string) => {
        replies.push(...text.split("\r\n").filter((l) => l.length > 0));
        socket.write(text);
      };

      const handle = () => {
        let idx: number;
        while ((idx = buffer.indexOf("\r\n")) >= 0) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          commands.push(line);
          const upper = line.toUpperCase();

          if (upper.startsWith("EHLO")) {
            const caps = encrypted
              ? (script.ehloAfterTls ?? script.ehloBeforeTls ?? [])
              : (script.ehloBeforeTls ?? []);
            write(`250-fake\r\n${caps.map((c) => `250-${c}`).join("\r\n")}\r\n250 OK\r\n`);
          } else if (upper.startsWith("HELO")) {
            write("250 fake\r\n");
          } else if (upper.startsWith("STARTTLS")) {
            write("220 Ready to start TLS\r\n");
            if (script.breakStartTls) {
              setImmediate(() => socket.destroy());
              return;
            }
            // Real upgrade: stop reading in the clear, hand the fd to TLS.
            const plain = socket;
            plain.removeAllListeners("data");
            const secured = new tls.TLSSocket(plain, {
              isServer: true,
              secureContext: tls.createSecureContext({ key: TLS_KEY, cert: TLS_CERT }),
            });
            socket = secured;
            encrypted = true;
            buffer = "";
            secured.setEncoding("utf8");
            secured.on("error", () => {
              /* client hung up — irrelevant to the assertions */
            });
            secured.on("data", (chunk: string) => {
              buffer += chunk;
              handle();
            });
          } else if (upper.startsWith("QUIT")) {
            write("221 Bye\r\n");
            socket.end();
            return;
          } else {
            write("250 OK\r\n");
          }
        }
      };

      initial.setEncoding("utf8");
      initial.on("error", () => {
        /* irrelevant to the assertions */
      });
      initial.on("data", (chunk: string) => {
        buffer += chunk;
        handle();
      });
      initial.write(`${script.banner ?? "220 fake ESMTP ready"}\r\n`);
    };

    const server = script.implicitTls
      ? tls.createServer({ key: TLS_KEY, cert: TLS_CERT }, (socket) => runSession(socket, true))
      : net.createServer((socket) => runSession(socket, false));

    server.on("error", () => {
      /* surface nothing; the test's assertions are the signal */
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({
        port: address.port,
        commands,
        replies,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

/** No capability probe may ever transmit credentials — it is a discovery call. */
function assertNeverAuthenticated(srv: FakeServer): void {
  const sent = srv.commands.filter((c) => /^AUTH\b/i.test(c));
  assert.deepEqual(sent, [], `the capability probe sent credentials: ${sent.join(" | ")}`);
}

// ── The regression this file exists for ──────────────────────────────────────

test("AUTH hidden until encrypted: the probe must upgrade, re-ask, and find it", async () => {
  // Shaped after the live WEDOS host: identical clear-text EHLO minus AUTH, plus
  // STARTTLS; the AUTH line appears only once the channel is encrypted.
  const srv = await startFakeServer({
    ehloBeforeTls: ["PIPELINING", "SIZE 104857600", "STARTTLS", "ENHANCEDSTATUSCODES", "8BITMIME"],
    ehloAfterTls: ["PIPELINING", "SIZE 104857600", "AUTH PLAIN LOGIN", "ENHANCEDSTATUSCODES", "8BITMIME"],
  });
  try {
    const caps = await probeSmtpCapabilities({ host: "127.0.0.1", port: srv.port });

    assert.equal(caps.reachable, true, "the fake server answers, so this must be reachable");
    assert.equal(caps.starttlsAdvertised, true, "STARTTLS was offered in the clear");

    // THE FIX: AUTH is reported from the POST-encryption EHLO.
    assert.equal(caps.starttlsUpgraded, true, "the probe must complete the STARTTLS upgrade");
    assert.equal(caps.authAdvertised, true, "AUTH is offered — just not in the clear");
    assert.deepEqual(caps.authMechanisms, ["PLAIN", "LOGIN"]);

    // And the plaintext reading is preserved honestly, so the UI can explain itself.
    assert.equal(caps.authAdvertisedBeforeTls, false, "the server withheld AUTH in the clear");

    // THE REGRESSION PIN: this is the exact false alarm the customer saw. Before
    // the fix, authAdvertised was false here and capabilityWarning() returned the
    // "did not ask for a username or password at all" text on a mailbox that
    // authenticates and delivers.
    assert.equal(
      capabilityWarning(caps),
      undefined,
      "a server that asks for login after encryption must NOT be warned about"
    );

    assertNeverAuthenticated(srv);
  } finally {
    await srv.close();
  }
});

test("the same server really does answer differently before and after encryption", async () => {
  // Documents the root cause rather than trusting it: if a future refactor starts
  // passing the plaintext list, this proves the two lists genuinely differ.
  const srv = await startFakeServer({
    ehloBeforeTls: ["PIPELINING", "STARTTLS"],
    ehloAfterTls: ["PIPELINING", "AUTH PLAIN LOGIN"],
  });
  try {
    const caps = await probeSmtpCapabilities({ host: "127.0.0.1", port: srv.port });
    assert.equal(caps.authAdvertised, true);

    const ehloReplies = srv.replies.filter((l) => l.startsWith("250-"));
    const withAuth = ehloReplies.filter((l) => /^250-AUTH\b/i.test(l));
    assert.equal(withAuth.length, 1, "exactly one EHLO advertised AUTH");
    assert.match(withAuth[0], /250-AUTH PLAIN LOGIN/);

    const firstAuthIndex = ehloReplies.findIndex((l) => /^250-AUTH\b/i.test(l));
    const beforeAuth = ehloReplies.slice(0, firstAuthIndex);
    assert.ok(
      beforeAuth.every((l) => !/^250-AUTH\b/i.test(l)),
      "the FIRST EHLO must have offered no AUTH — that is what the probe used to read"
    );

    assert.ok(srv.commands.includes("STARTTLS"), "the probe used STARTTLS");
  } finally {
    await srv.close();
  }
});

// ── The original incident, which must still be caught ────────────────────────

test("no STARTTLS and no AUTH still earns the accept-and-drop warning", async () => {
  // The customer relay from 2026-09-28 that swallowed a live campaign: bare
  // capabilities, no encryption, no login — messages accepted then dropped.
  const srv = await startFakeServer({
    banner: "220 localhost Python SMTP 1.4.6",
    ehloBeforeTls: ["PIPELINING", "ENHANCEDSTATUSCODES", "8BITMIME"],
  });
  try {
    const caps = await probeSmtpCapabilities({ host: "127.0.0.1", port: srv.port });

    assert.equal(caps.reachable, true);
    assert.equal(caps.starttlsAdvertised, false);
    assert.equal(caps.starttlsUpgraded, false);
    assert.equal(caps.authAdvertised, false);
    assert.equal(caps.authAdvertisedBeforeTls, false);

    const warning = capabilityWarning(caps);
    assert.ok(warning, "this shape must still warn");
    assert.match(warning, /did not ask for a username or password at all/);
    assert.match(warning, /silently dropped/);
  } finally {
    await srv.close();
  }
});

// ── The two cases that must NOT be confused with each other ─────────────────

test("STARTTLS offered but the handshake fails is INCONCLUSIVE, not 'no AUTH'", async () => {
  const srv = await startFakeServer({
    ehloBeforeTls: ["PIPELINING", "STARTTLS"],
    ehloAfterTls: ["PIPELINING", "AUTH PLAIN LOGIN"],
    breakStartTls: true,
  });
  try {
    const caps = await probeSmtpCapabilities({ host: "127.0.0.1", port: srv.port });

    assert.equal(caps.starttlsAdvertised, true, "STARTTLS was offered before the break");
    assert.equal(caps.starttlsUpgraded, false, "the upgrade did not complete");

    const warning = capabilityWarning(caps);
    assert.ok(warning, "an unverifiable login must still be mentioned");
    assert.match(warning, /did not complete/);
    // The load-bearing negative: we must NOT assert the password is ignored, since
    // the server may well be asking for it behind the encryption we couldn't reach.
    assert.doesNotMatch(
      warning,
      /did not ask for a username or password at all/,
      "must not claim the server ignores the password when we never saw past TLS"
    );
  } finally {
    await srv.close();
  }
});

test("encrypted but still no AUTH IS a real finding", async () => {
  const srv = await startFakeServer({
    ehloBeforeTls: ["PIPELINING", "STARTTLS"],
    ehloAfterTls: ["PIPELINING", "ENHANCEDSTATUSCODES"],
  });
  try {
    const caps = await probeSmtpCapabilities({ host: "127.0.0.1", port: srv.port });

    assert.equal(caps.starttlsUpgraded, true, "we did encrypt and re-ask");
    assert.equal(caps.authAdvertised, false, "and it still offered no login");

    const warning = capabilityWarning(caps);
    assert.ok(warning);
    assert.match(warning, /even after STARTTLS/);
  } finally {
    await srv.close();
  }
});

// ── Implicit TLS (465) and mechanism parsing ────────────────────────────────

test("implicit TLS (465) reads AUTH from the first EHLO and never claims an upgrade", async () => {
  const srv = await startFakeServer({
    implicitTls: true,
    ehloBeforeTls: ["PIPELINING", "AUTH PLAIN LOGIN", "SIZE 35882577"],
  });
  try {
    const caps = await probeSmtpCapabilities({ host: "127.0.0.1", port: srv.port, implicitTls: true });

    assert.equal(caps.authAdvertised, true);
    assert.deepEqual(caps.authMechanisms, ["PLAIN", "LOGIN"]);
    // There is no STARTTLS step on 465 — the first EHLO is already encrypted.
    assert.equal(caps.starttlsUpgraded, false);
    assert.equal(caps.starttlsAdvertised, false);
    assert.equal(capabilityWarning(caps), undefined);
    assertNeverAuthenticated(srv);
  } finally {
    await srv.close();
  }
});

test("mechanism parsing is case-insensitive and order-preserving", async () => {
  const srv = await startFakeServer({
    ehloBeforeTls: ["PIPELINING", "auth login plain cram-md5"],
  });
  try {
    const caps = await probeSmtpCapabilities({ host: "127.0.0.1", port: srv.port });
    assert.equal(caps.authAdvertised, true);
    assert.deepEqual(caps.authMechanisms, ["login", "plain", "cram-md5"]);
    assert.equal(capabilityWarning(caps), undefined);
  } finally {
    await srv.close();
  }
});





