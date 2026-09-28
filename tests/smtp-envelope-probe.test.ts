import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import net from "node:net";
import type { AddressInfo } from "node:net";

// 2026-09-28 — `probeEnvelope` / `describeEnvelopeRefusal` regression test.
//
// WHY THIS FILE EXISTS: `verify()` stops at EHLO (+AUTH), so a mailbox can pass
// every test we have and still be incapable of sending. The live incident was a
// relay that answers
//     220 localhost Python SMTP 1.4.6
// advertises NO AUTH and NO STARTTLS, accepts MAIL FROM with "250 OK", and then
// answers the very first RCPT TO with "550 Not allowed" — for its OWN address as
// well as for anyone else's. Every message is refused at the envelope, so a
// campaign through that mailbox delivered nothing, not even to spam, while the
// connection test showed a tick.
//
// `probeEnvelope` closes that gap by offering a real envelope and reading the
// server's own reply. Two invariants here are load-bearing and invisible in the
// UI, so they are pinned explicitly:
//
//   1. It must NEVER issue DATA. The probe runs behind a user-facing button, so
//      a regression that let it transmit a message body would start mailing real
//      people from a diagnostics screen. Asserted after every conversation.
//   2. It must fail only when EVERY offered recipient is refused. Relay services
//      (Resend et al) refuse the bare login name but accept the domain address
//      you send as; failing those mailboxes would be a worse bug than the one
//      this fixes.
//
// The fake servers below speak real SMTP over a real loopback socket — no
// mocking of the thing under test — and only the module's own imports are
// stubbed (the house require-hook pattern, HOW_WE_MOVE_FAST §4).

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
const { probeEnvelope, describeEnvelopeRefusal, formatSmtpReply } = require("../lib/smtp-diagnostics") as typeof import("../lib/smtp-diagnostics");
/* eslint-enable @typescript-eslint/no-require-imports */

interface Script {
  /** The 220 greeting line, verbatim. */
  banner?: string;
  /** EHLO capability lines; "AUTH ..." and "STARTTLS" belong here when advertised. */
  ehlo?: string[];
  mailFrom?: { code: number; text: string };
  /** Given the recipient and its 0-based order, return the reply. */
  rcpt?: (recipient: string, order: number) => { code: number; text: string };
  /** Advertise STARTTLS and answer the command with 220, then kill the socket. */
  breakStartTls?: boolean;
  /** Advertise AUTH LOGIN and return this reply to the password step. */
  authResult?: { code: number; text: string };
}

interface FakeServer {
  port: number;
  commands: string[];
  /**
   * Resolves once every connection handed to this server has closed. The probe
   * writes its last command and hangs up, so a socket's `data` events are all
   * delivered BEFORE its `close` — awaiting this is what makes the "no DATA"
   * assertion below actually see the whole conversation instead of racing it.
   */
  waitForIdle: () => Promise<void>;
  close: () => Promise<void>;
}

/** A minimal but real SMTP server on loopback, so the probe talks to a socket. */
function startFakeServer(script: Script): Promise<FakeServer> {
  return new Promise((resolve) => {
    const commands: string[] = [];
    let open = 0;
    const idleWaiters: Array<() => void> = [];
    const server = net.createServer((socket) => {
      open += 1;
      socket.on("close", () => {
        open -= 1;
        if (open === 0) idleWaiters.splice(0).forEach((fn) => fn());
      });
      socket.setEncoding("utf8");
      socket.write(`${script.banner ?? "220 fake ESMTP ready"}\r\n`);
      let buffer = "";
      let rcptOrder = 0;
      // -1 = no AUTH flow in progress. See the AUTH LOGIN branch below.
      let authStep = -1;
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        let idx: number;
        while ((idx = buffer.indexOf("\r\n")) >= 0) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          commands.push(line);
          const upper = line.toUpperCase();
          if (upper.startsWith("EHLO")) {
            const caps = script.ehlo ?? ["SIZE 1048576", "HELP"];
            socket.write(`250-fake\r\n${caps.map((c) => `250-${c}`).join("\r\n")}\r\n250 OK\r\n`);
          } else if (upper.startsWith("HELO")) {
            socket.write("250 fake\r\n");
          } else if (upper.startsWith("MAIL FROM")) {
            const r = script.mailFrom ?? { code: 250, text: "OK" };
            socket.write(`${r.code} ${r.text}\r\n`);
          } else if (upper.startsWith("RCPT TO")) {
            const recipient = line.slice(line.indexOf("<") + 1, line.lastIndexOf(">"));
            const r = script.rcpt ? script.rcpt(recipient, rcptOrder++) : { code: 250, text: "OK" };
            socket.write(`${r.code} ${r.text}\r\n`);
          } else if (upper.startsWith("RSET")) {
            socket.write("250 OK\r\n");
          } else if (upper.startsWith("STARTTLS")) {
            // 220 accepts the upgrade; the probe then starts a real TLS handshake
            // on this socket. Killing it here simulates a server whose STARTTLS
            // is broken, which must come back INCONCLUSIVE (never a refusal) —
            // the real send path reports TLS problems, not this probe.
            socket.write("220 Ready to start TLS\r\n");
            if (script.breakStartTls) setImmediate(() => socket.destroy());
          } else if (upper.startsWith("AUTH LOGIN")) {
            // 334 = "send the next credential"; the probe replies with base64.
            // Starts at -1 so a non-auth session can never be mistaken for a
            // credential step (that would swallow a plain QUIT).
            authStep = 0;
            socket.write("334 VXNlcm5hbWU6\r\n");
          } else if (authStep === 0) {
            authStep = 1;
            socket.write("334 UGFzc3dvcmQ6\r\n");
          } else if (authStep === 1) {
            authStep = 2;
            const r = script.authResult ?? { code: 235, text: "Authentication successful" };
            socket.write(`${r.code} ${r.text}\r\n`);
          } else if (upper.startsWith("DATA")) {
            // Honoured on purpose: if the probe ever regressed and issued DATA,
            // the conversation must continue so the "no DATA" assertion reports
            // it, rather than the probe hanging on an unexpected 5xx.
            socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
          } else if (upper.startsWith("QUIT")) {
            socket.write("221 Bye\r\n");
            socket.end();
          } else {
            socket.write("250 OK\r\n");
          }
        }
      });
      socket.on("error", () => {
        /* client hung up — irrelevant to the assertions */
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({
        port: address.port,
        commands,
        waitForIdle: () =>
          open === 0 ? Promise.resolve() : new Promise<void>((r) => idleWaiters.push(r)),
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

/**
 * The safety pin: no conversation may ever carry a DATA command.
 *
 * Async on purpose. The probe hangs up immediately after its last command, and
 * the server's `data` events land asynchronously, so asserting straight after
 * `probeEnvelope()` returns reads a half-filled `commands` array and passes even
 * when DATA was sent. Waiting for the connection to close first is what makes
 * this a real guard.
 */
async function assertNeverSentData(srv: FakeServer): Promise<void> {
  await srv.waitForIdle();
  const data = srv.commands.filter((c) => /^DATA\b/i.test(c));
  assert.equal(data.length, 0, `probe must never issue DATA (saw ${JSON.stringify(data)})`);
}

async function withServer<T>(script: Script, run: (srv: FakeServer) => Promise<T>): Promise<T> {
  const srv = await startFakeServer(script);
  try {
    return await run(srv);
  } finally {
    await srv.close();
  }
}


test("a server reply is shown once, never as a doubled code", async () => {
  // Observed live on the customer relay: the code is repeated inside the text
  // ("550 Not allowed" under 550), so a naive `${code} ${text}` renders
  // "550 550 Not allowed" in the panel.
  assert.equal(formatSmtpReply(550, "550 Not allowed"), "550 Not allowed");
  assert.equal(formatSmtpReply(550, "Not allowed"), "550 Not allowed");
  assert.equal(formatSmtpReply(530, "5.7.0 Authentication required"), "530 5.7.0 Authentication required");
  // Multiline replies collapse to their first line, whitespace normalised.
  assert.equal(formatSmtpReply(535, "535-5.7.8 Bad creds\n535 5.7.8 More info"), "535-5.7.8 Bad creds");
  // A code with no text still reads as something.
  assert.equal(formatSmtpReply(421, null), "421");
  assert.equal(formatSmtpReply(421, "   "), "421");
  // 550 must not swallow a different leading code (553 is not "550 ...").
  assert.equal(formatSmtpReply(550, "553 Relay denied"), "550 553 Relay denied");
});

test("a server that accepts the envelope reports accepted, and never sees DATA", async () => {
  await withServer({}, async (srv) => {
    const probe = await probeEnvelope({
      host: "127.0.0.1",
      port: srv.port,
      from: "sender@example.test",
      recipients: ["sender@example.test"],
      timeoutMs: 3_000,
    });

    assert.equal(probe.attempted, true);
    assert.equal(probe.accepted, true);
    assert.equal(probe.refused, false);
    assert.equal(probe.replyCode, 250);
    assert.equal(probe.error, undefined);
    await assertNeverSentData(srv);
    // Accepting must stay silent — "no message" is not an error.
    assert.equal(describeEnvelopeRefusal(probe, { host: "h", port: 25, allowInsecure: true }), undefined);
  });
});

test("the live relay's shape: no AUTH, then 550 Not allowed on every RCPT", async () => {
  await withServer(
    {
      banner: "220 localhost Python SMTP 1.4.6",
      ehlo: ["SIZE 33554432", "8BITMIME", "SMTPUTF8", "HELP"],
      mailFrom: { code: 250, text: "OK" },
      rcpt: () => ({ code: 550, text: "Not allowed" }),
    },
    async (srv) => {
      const probe = await probeEnvelope({
        host: "127.0.0.1",
        port: srv.port,
        from: "fleming@watsonandrade9382.ca.lu",
        recipients: ["fleming@watsonandrade9382.ca.lu", "postmaster@example.com"],
        timeoutMs: 3_000,
      });

      assert.equal(probe.attempted, true);
      assert.equal(probe.refused, true);
      assert.equal(probe.refusedAt, "RCPT TO");
      assert.equal(probe.replyCode, 550);
      assert.equal(probe.accepted, false);
      await assertNeverSentData(srv);

      // Both addresses were offered before giving up, so the message can present
      // the refusal as a relay-wide policy rather than a per-recipient quirk.
      assert.equal(srv.commands.filter((c) => /^RCPT TO/i.test(c)).length, 2);

      const message = describeEnvelopeRefusal(probe, {
        host: "watsonandrade9382.ca.lu",
        port: 25,
        allowInsecure: true,
      });
      assert.ok(message, "a refused envelope must produce a message");
      assert.match(message, /550 Not allowed/);
      assert.match(message, /cannot send/);
      // The advice must point at the server's side: no form value can fix this.
      assert.match(message, /source IPs it accepts from/);
    }
  );
});


test("a 530 that merely demands encryption or a login is INCONCLUSIVE, never a verdict", async () => {
  // THE FALSE-POSITIVE GUARD, and the bug the control run against smtp.gmail.com
  // caught: a plaintext probe of a 587 provider gets
  //     530 5.7.0 Must issue a STARTTLS command first
  // which is a correct answer to OUR question, not a verdict on the mailbox. An
  // earlier draft reported it as "this mailbox cannot send" — which would have
  // condemned every normal provider in the product.
  await withServer({ mailFrom: { code: 530, text: "5.7.0 Must issue a STARTTLS command first" } }, async (srv) => {
    const probe = await probeEnvelope({
      host: "127.0.0.1",
      port: srv.port,
      from: "sender@example.test",
      recipients: ["sender@example.test"],
      timeoutMs: 3_000,
    });

    assert.equal(probe.usedTls, false);
    assert.equal(probe.refused, true, "the server did refuse this session");
    // ...but it must stay silent, because our session wasn't equivalent to a send.
    assert.equal(describeEnvelopeRefusal(probe, { host: "h", port: 587, allowInsecure: false }), undefined);
    await assertNeverSentData(srv);
  });

  // Same shape for a login: our probe never authenticated (no AUTH advertised),
  // so a 530 "Authentication required" is unanswerable by this probe.
  await withServer({ mailFrom: { code: 530, text: "5.7.0 Authentication required" } }, async (srv) => {
    const probe = await probeEnvelope({
      host: "127.0.0.1",
      port: srv.port,
      from: "sender@example.test",
      recipients: ["sender@example.test"],
      timeoutMs: 3_000,
    });

    assert.equal(probe.authenticated, false);
    assert.equal(describeEnvelopeRefusal(probe, { host: "h", port: 25, allowInsecure: true }), undefined);
    await assertNeverSentData(srv);
  });
});

test("a login-required server is logged into first, then must accept — no false alarm", async () => {
  // The other half of the guard: when the server DOES advertise AUTH and our
  // login succeeds, a subsequent refusal really is about the mailbox. Here the
  // envelope is accepted, so the result must be a clean pass — proving the probe
  // speaks a full authenticated conversation rather than condemning providers
  // that simply require a login before MAIL FROM.
  await withServer({ ehlo: ["AUTH LOGIN", "SIZE 1048576"] }, async (srv) => {
    const probe = await probeEnvelope({
      host: "127.0.0.1",
      port: srv.port,
      from: "sender@example.test",
      recipients: ["sender@example.test"],
      auth: { user: "sender@example.test", pass: "hunter2" },
      timeoutMs: 3_000,
    });

    assert.equal(probe.authenticated, true);
    assert.equal(probe.accepted, true);
    assert.equal(probe.refused, false);
    assert.equal(probe.error, undefined);
    assert.equal(describeEnvelopeRefusal(probe, { host: "h", port: 587, allowInsecure: false }), undefined);
    // The login really happened, with the base64 credentials, before the envelope.
    const cmds = srv.commands;
    assert.equal(cmds[0], "EHLO spaceworker-diagnostics");
    assert.equal(cmds[1], "AUTH LOGIN");
    assert.equal(cmds[2], Buffer.from("sender@example.test", "utf8").toString("base64"));
    assert.equal(cmds[3], Buffer.from("hunter2", "utf8").toString("base64"));
    assert.match(cmds[4], /^MAIL FROM/);
    await assertNeverSentData(srv);
  });
});

test("a failed login is inconclusive — verify() owns credentials, not this probe", async () => {
  await withServer(
    { ehlo: ["AUTH LOGIN"], authResult: { code: 535, text: "5.7.8 Username and Password not accepted" } },
    async (srv) => {
      const probe = await probeEnvelope({
        host: "127.0.0.1",
        port: srv.port,
        from: "sender@example.test",
        recipients: ["sender@example.test"],
        auth: { user: "sender@example.test", pass: "wrong" },
        timeoutMs: 3_000,
      });

      assert.equal(probe.authenticated, false);
      assert.equal(probe.refused, false);
      assert.ok(probe.error, "a failed login must surface as an advisory error");
      // Never a send verdict: verify() already passed for this mailbox.
      assert.equal(describeEnvelopeRefusal(probe, { host: "h", port: 587, allowInsecure: false }), undefined);
      // It gave up before offering an envelope it could not legitimately offer.
      assert.equal(srv.commands.filter((c) => /^MAIL FROM/i.test(c)).length, 0);
      await assertNeverSentData(srv);
    }
  );
});

test("a broken STARTTLS upgrade is inconclusive, not a refusal", async () => {
  // Servers whose STARTTLS is advertised but not functional must be reported by
  // the transport's own TLS handling, not by a probe that never got a message
  // far enough to have an opinion.
  await withServer({ ehlo: ["STARTTLS", "SIZE 1048576"], breakStartTls: true }, async (srv) => {
    const probe = await probeEnvelope({
      host: "127.0.0.1",
      port: srv.port,
      from: "sender@example.test",
      recipients: ["sender@example.test"],
      auth: { user: "u", pass: "p" },
      timeoutMs: 3_000,
    });

    assert.equal(probe.attempted, false);
    assert.equal(probe.refused, false);
    assert.ok(probe.error, "a failed upgrade must surface as an advisory error");
    assert.equal(describeEnvelopeRefusal(probe, { host: "h", port: 587, allowInsecure: false }), undefined);
    await assertNeverSentData(srv);
  });
});

test("one accepted recipient is enough — a relay service refusing its login name still passes", async () => {
  await withServer(
    {
      rcpt: (recipient) => (recipient === "resend" ? { code: 550, text: "Not allowed" } : { code: 250, text: "OK" }),
    },
    async (srv) => {
      const probe = await probeEnvelope({
        host: "127.0.0.1",
        port: srv.port,
        from: "you@yourdomain.test",
        // The login name first (refused), the send-as address second (accepted):
        // exactly the Resend shape the panel's own hint describes.
        recipients: ["resend", "you@yourdomain.test"],
        timeoutMs: 3_000,
      });

      assert.equal(probe.accepted, true);
      assert.equal(probe.refused, false);
      await assertNeverSentData(srv);
      assert.equal(describeEnvelopeRefusal(probe, { host: "h", port: 587, allowInsecure: false }), undefined);
    }
  );
});

test("identical recipients are offered once, not twice", async () => {
  await withServer({}, async (srv) => {
    const probe = await probeEnvelope({
      host: "127.0.0.1",
      port: srv.port,
      from: "Same@Example.test",
      recipients: ["same@example.test", "SAME@EXAMPLE.TEST", "  "],
      timeoutMs: 3_000,
    });

    assert.equal(probe.accepted, true);
    assert.deepEqual(probe.recipients, ["same@example.test"]);
    assert.equal(srv.commands.filter((c) => /^RCPT TO/i.test(c)).length, 1);
    await assertNeverSentData(srv);
  });
});

test("a 4xx (greylisting) is inconclusive — never a refusal, never a message", async () => {
  await withServer({ rcpt: () => ({ code: 451, text: "Try again later" }) }, async (srv) => {
    const probe = await probeEnvelope({
      host: "127.0.0.1",
      port: srv.port,
      from: "sender@example.test",
      recipients: ["sender@example.test"],
      timeoutMs: 3_000,
    });

    assert.equal(probe.attempted, true);
    assert.equal(probe.refused, false);
    assert.equal(probe.accepted, false);
    assert.equal(probe.replyCode, 451);
    await assertNeverSentData(srv);
    // A temporary "no" must not condemn a working mailbox.
    assert.equal(describeEnvelopeRefusal(probe, { host: "h", port: 587, allowInsecure: false }), undefined);
  });
});

test("an unreachable port is an advisory error, not a refusal", async () => {
  // Bind then close, so the port is reliably refused rather than guessed at.
  const srv = await startFakeServer({});
  const port = srv.port;
  await srv.close();

  const probe = await probeEnvelope({
    host: "127.0.0.1",
    port,
    from: "sender@example.test",
    recipients: ["sender@example.test"],
    timeoutMs: 2_000,
  });

  assert.equal(probe.attempted, false);
  assert.equal(probe.refused, false);
  assert.equal(probe.accepted, false);
  assert.ok(probe.error, "a failed connect must surface as an advisory error");
  assert.equal(describeEnvelopeRefusal(probe, { host: "127.0.0.1", port, allowInsecure: true }), undefined);
});

