import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

// TASK_139 — `lib/sending-domains.ts` regression test.
//
// WHY THIS FILE EXISTS: this module decides two things that both LOOK right
// while being wrong, and neither is visible in the UI:
//
//   1. DKIM verification. "The record exists" is not the same as "the record
//      holds the key we sign with". A stale or mismatched record fails DKIM
//      identically to no record at all, so reporting a green tick on existence
//      alone would show "verified" over mail that still lands in spam.
//
//   2. The relay's KeyTable/SigningTable are SHARED BY EVERY TENANT. Building
//      the new file from only the new domain would silently stop signing for
//      every other customer's domain — no error, no log, just unsigned mail.
//      That is why the table writers are merge/remove functions and why they
//      are tested directly here rather than only through the install path
//      (which needs a Linux relay host with sudo).
//
// The module under test is the REAL `lib/sending-domains.ts` — not a copy of its
// logic — loaded through the house require hook (HOW_WE_MOVE_FAST §4), with its
// DNS resolver swapped for a table so no test touches a real resolver.

type Loader = {
  _load: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown;
};

/**
 * Every module whose `node:dns/promises` import must be replaced by the table
 * below. Both are listed with their real extension: the parent filename at require
 * time ends in `.ts`, so a suffix check without it never matches.
 */
const DNS_CONSUMERS = ["/lib/sending-domains.ts", "/lib/sending-domain-coverage.ts"];

/** Tiny hermetic TXT table: name -> records (each record as its own string). */
const txtTable = new Map<string, string[]>();
function setTxt(name: string, records: string[]): void {
  txtTable.set(name, records);
}

/**
 * Failure modes a resolver can produce, which must NOT be conflated.
 *
 * "no such record" (ENOTFOUND/ENODATA) is a DEFINITE answer and a real DKIM
 * failure. Anything else — SERVFAIL, a timeout, a refused query — is the resolver
 * failing to answer, and must stay "unknown". Modelling both is the only way to
 * prove the code keeps them apart: a stub that can ONLY say "absent" makes the
 * two indistinguishable, and every lookup then reads as a hard no.
 */
const dnsFailures = new Map<string, string>();
function setDnsFailure(name: string, code: string): void {
  dnsFailures.set(name, code);
}

/** Names whose lookup never settles, so the bounded wait has to fire. */
const hanging = new Set<string>();
function setHang(name: string): void {
  hanging.add(name);
}

function installRequireHook(): void {
  const loader = Module as unknown as Loader;
  const original = loader._load;
  loader._load = function patched(request, parent, isMain) {
    if (request === "server-only") return {};
    const from = (parent?.filename ?? "").replace(/\\/g, "/");
    if (
      request === "node:dns/promises" &&
      // The suffix MUST include the real ".ts", because at require time the parent
      // filename is the compiled path ending in `.ts`. Writing the check without it
      // made it silently false, so the module under test got the REAL resolver —
      // and three of the tests below still passed, because a real NXDOMAIN for a
      // name that does not exist happens to produce the same answer as "missing".
      // That is the whole hazard: a stub that does not apply is indistinguishable
      // from a stub that agrees with you.
      DNS_CONSUMERS.some((suffix) => from.endsWith(suffix))
    ) {
      return {
        // Top level, exactly like the `{ lookup }` stub in
        // tests/smtp-host-guard.test.ts. The module does `import dns from
        // "node:dns/promises"`, and esbuild's CJS interop sets the wrapper's
        // `.default` to the WHOLE module object — so returning
        // `{ default: { resolveTxt } }` makes `dns.resolveTxt` undefined, the
        // TypeError is swallowed by txtRecords()'s catch, and every lookup
        // silently reads as "no record". That is a stub that cannot fail loudly.
        resolveTxt: async (name: string) => {
          // A resolver that never answers: the bounded wait must produce
          // "unknown", NOT "missing".
          if (hanging.has(name)) return new Promise<never>(() => {});
          const code = dnsFailures.get(name);
          if (code) {
            const err = new Error(`queryTxt ${code} ${name}`) as Error & { code: string };
            err.code = code;
            throw err;
          }
          const rows = txtTable.get(name);
          if (!rows) {
            // resolveTxt throws ENOTFOUND/ENODATA when a name has no TXT
            // records — the module must treat that as "nothing to look at",
            // not as a crash.
            const err = new Error(`queryTxt ENOTFOUND ${name}`) as Error & { code: string };
            err.code = "ENOTFOUND";
            throw err;
          }
          // Node chunks a >255-byte TXT value into an array of strings. A
          // 2048-bit DKIM key (~372 chars) is ALWAYS chunked, so the real
          // shape has to be modelled or the test would pass on a fake that
          // never occurs in production.
          return rows.map((r) => (r.length > 255 ? [r.slice(0, 255), r.slice(255)] : [r]));
        },
      };
    }
    return original.call(this, request, parent, isMain);
  };
}

installRequireHook();

/* eslint-disable @typescript-eslint/no-require-imports */
const sd = require("../lib/sending-domains") as typeof import("../lib/sending-domains");
// The DNS-facing half. Loaded through the same hook so its `dns` import is the
// stubbed one — without this, lookupDkimState would query the real resolver.
const cov = require("../lib/sending-domain-coverage") as typeof import("../lib/sending-domain-coverage");
/* eslint-enable @typescript-eslint/no-require-imports */

const SELECTOR = sd.DKIM_SELECTOR;
const DOMAIN = "example.com";

test("generateDkimKeypair produces a key whose published TXT matches the key it signs with", () => {
  const pair = sd.generateDkimKeypair(2048);
  assert.match(pair.publicKeyTxt, /^v=DKIM1; h=sha256; k=rsa; p=[A-Za-z0-9+/]+=*$/);
  assert.match(pair.privatePem, /-----BEGIN PRIVATE KEY-----/);
  // The p= value must be the base64 DER of the SPKI — no PEM armour, no
  // newlines. An unstripped PEM body is the classic silent DKIM failure.
  assert.ok(!pair.publicKeyTxt.includes("\n"), "TXT value must be one line");
  assert.ok(!pair.publicKeyTxt.includes("-----"), "TXT value must not contain PEM armour");
  const p = sd.dkimPublicKeyOf(pair.publicKeyTxt);
  assert.ok(p && p.length > 300, "expected a 2048-bit modulus in p=");
  assert.strictEqual(sd.dkimPublicKeyOf(`v=DKIM1; k=rsa; p=${p}`), p);
});

test("verifySendingDomainDns verifies only when the PUBLISHED key is the key we sign with", async () => {
  const pair = sd.generateDkimKeypair(2048);
  const ipv4 = "203.0.113.10";

  const dkimName = `${SELECTOR}._domainkey.${DOMAIN}`;

  // (a) nothing published at all
  txtTable.clear();
  let result = await sd.verifySendingDomainDns({
    domain: DOMAIN, selector: SELECTOR, publicKeyTxt: pair.publicKeyTxt, ipv4,
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.status, "invalid");
  assert.match(result.detail, /no TXT record yet/);

  // (b) a DIFFERENT key published — the trap this test exists for. Existence
  // alone would pass here; matching p= must not.
  const other = sd.generateDkimKeypair(2048);
  setTxt(dkimName, [other.publicKeyTxt]);
  setTxt(DOMAIN, [`v=spf1 ip4:${ipv4} -all`]);
  result = await sd.verifySendingDomainDns({
    domain: DOMAIN, selector: SELECTOR, publicKeyTxt: pair.publicKeyTxt, ipv4,
  });
  assert.strictEqual(result.ok, false, "a mismatched p= must never verify");
  assert.match(result.detail, /NOT the key we sign with/);

  // (c) the matching key, chunked exactly as Node returns a long TXT record
  setTxt(dkimName, [pair.publicKeyTxt]);
  result = await sd.verifySendingDomainDns({
    domain: DOMAIN, selector: SELECTOR, publicKeyTxt: pair.publicKeyTxt, ipv4,
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.status, "verified");

  // (d) SPF present but NOT authorising this server -> not verified. DKIM is
  // fine, so this pins that SPF genuinely participates in the verdict.
  setTxt(DOMAIN, [`v=spf1 ip4:198.51.100.7 -all`]);
  result = await sd.verifySendingDomainDns({
    domain: DOMAIN, selector: SELECTOR, publicKeyTxt: pair.publicKeyTxt, ipv4,
  });
  assert.strictEqual(result.ok, false);
  assert.match(result.detail, /does not authorise/);
});

test("DMARC is advisory: a missing DMARC record does not block verification", async () => {
  const pair = sd.generateDkimKeypair(2048);
  const ipv4 = "203.0.113.10";

  txtTable.clear();
  setTxt(`${SELECTOR}._domainkey.${DOMAIN}`, [pair.publicKeyTxt]);
  setTxt(DOMAIN, [`v=spf1 ip4:${ipv4} -all`]); // deliberately no _dmarc

  const result = await sd.verifySendingDomainDns({
    domain: DOMAIN, selector: SELECTOR, publicKeyTxt: pair.publicKeyTxt, ipv4,
  });
  const dmarc = result.checks.find((c) => c.purpose === "dmarc");
  assert.ok(dmarc, "DMARC is always reported");
  assert.strictEqual(dmarc.ok, false, "and honestly reported as missing");
  assert.strictEqual(dmarc.advisory, true);
  assert.strictEqual(result.ok, true, "but it must not block verification");
});

test("upsertTableLine MERGES: other tenants' domains survive an install", () => {
  const existing = [
    "sw._domainkey.alpha.com alpha.com:sw:/etc/opendkim/keys/alpha.com/sw.private",
    "*@alpha.com sw._domainkey.alpha.com",
    "sw._domainkey.beta.com beta.com:sw:/etc/opendkim/keys/beta.com/sw.private",
    "",
  ].join("\n");

  const { name, line } = sd.keyTableEntry({ domain: "gamma.com", selector: SELECTOR });
  const merged = sd.upsertTableLine(existing, name, line);

  assert.match(merged, /alpha\.com/, "alpha must survive");
  assert.match(merged, /beta\.com/, "beta must survive");
  assert.ok(merged.includes(line), "gamma must be added");
  assert.strictEqual(merged.split("\n").filter(Boolean).length, 4);

  // Re-running for the SAME domain must replace, not duplicate — a duplicated
  // KeyTable entry makes OpenDKIM fail to load the whole table.
  assert.strictEqual(sd.upsertTableLine(merged, name, line), merged);

  // A changed value for the same key replaces the old line rather than adding
  // a second one.
  const rewritten = sd.upsertTableLine(merged, name, `${name} gamma.com:sw:/etc/opendkim/keys/gamma.com/other.private`);
  assert.strictEqual(rewritten.split("\n").filter(Boolean).length, 4);
  assert.match(rewritten, /other\.private/);
  assert.doesNotMatch(rewritten, /gamma\.com\/sw\.private/);

  // Removing one domain leaves the others intact.
  const pruned = sd.removeTableLine(merged, name);
  assert.match(pruned, /alpha\.com/);
  assert.match(pruned, /beta\.com/);
  assert.doesNotMatch(pruned, /gamma\.com/);
});

test("key/signing table entries point at the real key path and the whole domain", () => {
  const key = sd.keyTableEntry({ domain: "Example.COM.", selector: SELECTOR });
  assert.strictEqual(key.name, "sw._domainkey.example.com");
  assert.strictEqual(
    key.line,
    "sw._domainkey.example.com example.com:sw:/etc/opendkim/keys/example.com/sw.private"
  );

  const sign = sd.signingTableEntry({ domain: "example.com", selector: SELECTOR });
  // Must be *@domain — a bare "example.com" pattern would miss the address
  // actually in the From header, and signing would silently not happen.
  assert.strictEqual(sign.name, "*@example.com");
  assert.strictEqual(sign.line, "*@example.com sw._domainkey.example.com");
});

test("domain validation refuses anything that could escape the key directory", () => {
  assert.strictEqual(sd.normalizeDomain("  Example.COM. "), "example.com");
  assert.ok(sd.isValidSendingDomain("mail.example.co.uk"));
  assert.ok(!sd.isValidSendingDomain("localhost"), "a bare label is not a sending domain");
  assert.ok(!sd.isValidSendingDomain(""));
  assert.ok(!sd.isValidSendingDomain("example..com"));
  // The domain becomes a DIRECTORY NAME under /etc/opendkim/keys, so traversal
  // must be impossible, not merely unlikely.
  assert.throws(() => sd.requireValidSendingDomain("../../etc/passwd"));
  assert.throws(() => sd.requireValidSendingDomain("example.com/../../etc"));
  assert.throws(() => sd.requireValidSendingDomain("exa mple.com"));
  assert.strictEqual(sd.requireValidSendingDomain("Example.COM."), "example.com");
});

test("the printed DNS records name the right hosts and carry the copyable values", () => {
  const pair = sd.generateDkimKeypair(2048);

  const records = sd.buildSendingDomainRecords({
    domain: DOMAIN,
    selector: SELECTOR,
    publicKeyTxt: pair.publicKeyTxt,
    ipv4: "203.0.113.10",
    ipv6: "",
  });

  const byName = new Map(records.map((r) => [r.purpose, r]));
  assert.strictEqual(byName.get("dkim")?.name, `${SELECTOR}._domainkey.${DOMAIN}`);
  assert.strictEqual(byName.get("dkim")?.value, pair.publicKeyTxt);
  assert.strictEqual(byName.get("spf")?.name, DOMAIN);
  assert.strictEqual(byName.get("spf")?.value, "v=spf1 ip4:203.0.113.10 -all");
  assert.strictEqual(byName.get("dmarc")?.name, `_dmarc.${DOMAIN}`);
  assert.match(byName.get("dmarc")?.value ?? "", /^v=DMARC1; p=none; rua=mailto:/);
  for (const r of records) assert.strictEqual(r.type, "TXT");
});


// ---------------------------------------------------------------------------
// TASK_140 — signing coverage: "will this mail actually carry a DKIM signature?"
//
// WHY THESE EXIST: an unsigned send is INVISIBLE. It is accepted with 250 and
// then spam-foldered by the receiver, so every check the app already had (does
// the server talk, does the server take the envelope) passes while the mail is
// still useless. The only defence is saying it out loud, and saying it out loud
// correctly depends on two decisions that are easy to get subtly wrong:
//
//   1. Coverage follows `installedOnRelay`, NOT `status`. What the relay does is
//      SIGN with a key that is on disk. A domain whose DNS has not been verified
//      yet is still signed — telling that user to "publish your DKIM record" is
//      telling them to redo work they have already done, so the two states must
//      never collapse into one warning.
//   2. Domain matching is case-insensitive, because DNS is. A row stored as
//      "Acme.com" must cover a From of "x@acme.com", or we warn about a domain
//      that IS signed and send the user on a wild goose chase.
// ---------------------------------------------------------------------------

test("domainOfAddress extracts the domain, and gives up honestly otherwise", () => {
  assert.strictEqual(sd.domainOfAddress("fleming@watsonandrade9382.ca.lu"), "watsonandrade9382.ca.lu");
  // Case and a trailing root dot are both normalisations, not separate domains.
  assert.strictEqual(sd.domainOfAddress("A@Example.COM."), "example.com");
  // Last "@" wins, so an @ inside a quoted local part cannot truncate the domain.
  assert.strictEqual(sd.domainOfAddress('"a@b"@acme.com'), "acme.com");
  // No domain => "", never a partial guess that would produce a bogus warning.
  assert.strictEqual(sd.domainOfAddress("not-an-address"), "");
  assert.strictEqual(sd.domainOfAddress("user@"), "");
});

test("an uninstalled From domain is reported as UNSIGNED, with a warning", () => {
  const c = sd.evaluateSigningCoverage({
    fromAddresses: ["fleming@watsonandrade9382.ca.lu"],
    rows: [],
  });
  assert.strictEqual(c.hasUnsigned, true);
  assert.deepStrictEqual(c.unsigned, ["watsonandrade9382.ca.lu"]);
  assert.strictEqual(c.entries[0].status, "unsigned");
  assert.ok(c.warning && c.warning.includes("@watsonandrade9382.ca.lu"), "warning names the domain");
});

test("installed AND verified reports verified with no warning (the whole chain works)", () => {
  const c = sd.evaluateSigningCoverage({
    fromAddresses: ["sales@acme.com"],
    rows: [{ domain: "acme.com", status: "verified", installedOnRelay: true }],
  });
  assert.strictEqual(c.hasUnsigned, false);
  assert.strictEqual(c.warning, null);
  assert.strictEqual(c.entries[0].status, "verified");
});

test("installed but DNS-unverified is 'unverified', NOT 'unsigned' (different fix)", () => {
  const c = sd.evaluateSigningCoverage({
    fromAddresses: ["sales@acme.com"],
    rows: [{ domain: "acme.com", status: "pending", installedOnRelay: true }],
  });
  // It WILL be signed, so it must not be called unsigned...
  assert.strictEqual(c.hasUnsigned, false);
  assert.deepStrictEqual(c.unsigned, []);
  assert.strictEqual(c.warning, null);
  // ...but it must not claim authentication will pass either.
  assert.strictEqual(c.entries[0].status, "unverified");
  assert.match(c.entries[0].detail, /not\s+verified/);
});


test("status 'verified' WITHOUT installedOnRelay is still UNSIGNED (the key is what signs)", () => {
  // This is the mutation target: keying coverage on `status` instead of
  // `installedOnRelay` makes this case report a green tick for mail the relay
  // has no key to sign with — the exact false-positive this feature exists to
  // prevent.
  const c = sd.evaluateSigningCoverage({
    fromAddresses: ["sales@acme.com"],
    rows: [{ domain: "acme.com", status: "verified", installedOnRelay: false }],
  });
  assert.strictEqual(c.hasUnsigned, true);
  assert.strictEqual(c.entries[0].status, "unsigned");
  assert.ok(c.warning, "must warn: nothing on disk can sign this");
});

test("domain matching is case-insensitive in both directions", () => {
  const c = sd.evaluateSigningCoverage({
    fromAddresses: ["X@ACME.COM"],
    rows: [{ domain: "Acme.Com", status: "verified", installedOnRelay: true }],
  });
  assert.strictEqual(c.hasUnsigned, false);
  assert.strictEqual(c.entries[0].status, "verified");
});

test("one address per domain: rotation lists do not repeat the same verdict", () => {
  const c = sd.evaluateSigningCoverage({
    fromAddresses: ["a@acme.com", "b@acme.com", "c@acme.com"],
    rows: [{ domain: "acme.com", status: "verified", installedOnRelay: true }],
  });
  assert.strictEqual(c.entries.length, 1);
});

test("a configured platform domain is offered as the no-DNS alternative", () => {
  const withoutPlatform = sd.evaluateSigningCoverage({
    fromAddresses: ["sales@acme.com"],
    rows: [],
  });
  // Without one, the only honest advice is to publish the record.
  assert.match(withoutPlatform.warning ?? "", /DKIM requires a public key/);
  assert.ok(!(withoutPlatform.warning ?? "").includes("send as @"));

  const withPlatform = sd.evaluateSigningCoverage({
    fromAddresses: ["sales@acme.com"],
    rows: [],
    platformDomain: "spaceworker.top",
  });
  assert.strictEqual(withPlatform.platformDomain, "spaceworker.top");
  // With one, the user who cannot edit DNS has a real way forward.
  assert.match(withPlatform.warning ?? "", /send as @spaceworker\.top/);
});

test("platformSendingDomain reads env, and rejects anything that is not a domain", () => {
  const saved = process.env.PLATFORM_SENDING_DOMAIN;
  try {
    delete process.env.PLATFORM_SENDING_DOMAIN;
    assert.strictEqual(sd.platformSendingDomain(), null, "unset => no platform domain");

    process.env.PLATFORM_SENDING_DOMAIN = "   ";
    assert.strictEqual(sd.platformSendingDomain(), null, "blank => no platform domain");

    process.env.PLATFORM_SENDING_DOMAIN = "spaceworker.top";
    assert.strictEqual(sd.platformSendingDomain(), "spaceworker.top");
    process.env.PLATFORM_SENDING_DOMAIN = "SpaceWorker.TOP.";
    assert.strictEqual(sd.platformSendingDomain(), "spaceworker.top", "normalised");

    // A bare label must never be treated as a sending domain — it would be
    // offered to users as an authenticated From that cannot exist.
    process.env.PLATFORM_SENDING_DOMAIN = "localhost";
    assert.strictEqual(sd.platformSendingDomain(), null);
  } finally {
    if (saved === undefined) delete process.env.PLATFORM_SENDING_DOMAIN;
    else process.env.PLATFORM_SENDING_DOMAIN = saved;
  }
});

// ---------------------------------------------------------------------------
// TASK_140 (refinement) — the relay's SigningTable is the GROUND TRUTH.
//
// WHY: the first cut derived coverage from the `SendingDomain` table alone. That
// is our INTENT, not what the relay does, and the live server proves they diverge:
// a key installed out-of-band (a shell script) signs mail while no DB row exists
// at all — so the DB-only check reported "UNSIGNED" for mail that is in fact
// signed, a false alarm on a working mailbox. The mirror case is just as real: a
// DB row can outlive its key on disk and promise a signature that never arrives.
// OpenDKIM consults the SigningTable, so that file decides. The DB only supplies
// DNS state.
// ---------------------------------------------------------------------------

test("parseSigningTableDomains reads all three pattern forms and skips the rest", () => {
  const domains = sd.parseSigningTableDomains(
    [
      "# a comment",
      "",
      "*@watsonandrade9382.ca.lu sw._domainkey.watsonandrade9382.ca.lu",
      "@bare.example.com   sw._domainkey.bare.example.com",
      "plain.example.org   sw._domainkey.plain.example.org",
      "   ",
      "# another comment",
      "not-a-domain sw._domainkey.not-a-domain",
      "localhost sw._domainkey.localhost",
    ].join("\n")
  );
  assert.deepStrictEqual(
    [...domains].sort(),
    ["bare.example.com", "plain.example.org", "watsonandrade9382.ca.lu"]
  );
  // A bare label must never be treated as a signing domain: it would make the
  // coverage lookup match nonsense patterns the relay would never be given.
  assert.ok(!domains.has("localhost"));
  assert.ok(!domains.has("not-a-domain"));
});

test("relay signs a domain with NO db row => 'unverified', not a false 'unsigned'", () => {
  // The exact live situation that exposed this: key on the relay, empty
  // SendingDomain table. Reporting "unsigned" here alarms a user whose mail IS
  // signed; reporting "verified" would be worse, because we cannot see DNS state.
  const c = sd.evaluateSigningCoverage({
    fromAddresses: ["fleming@watsonandrade9382.ca.lu"],
    rows: [],
    relaySignedDomains: new Set(["watsonandrade9382.ca.lu"]),
  });
  assert.strictEqual(c.entries.length, 1);
  assert.strictEqual(c.entries[0].status, "unverified");
  assert.strictEqual(c.hasUnsigned, false, "signed mail must never be called unsigned");
  assert.strictEqual(c.unsigned.length, 0);
  // No red warning, and the detail points at the missing record rather than
  // telling the user to install a key that is already installed.
  assert.strictEqual(c.warning, null);
  assert.match(c.entries[0].detail, /IS signed by the relay/);
});

test("relay does NOT sign while the db claims installed => 'unsigned' (the other direction)", () => {
  // A row can outlive its key on disk. The relay deciding is the whole point:
  // trusting the DB here would promise a signature that never arrives.
  const c = sd.evaluateSigningCoverage({
    fromAddresses: ["sales@acme.com"],
    rows: [{ domain: "acme.com", status: "verified", installedOnRelay: true }],
    relaySignedDomains: new Set(), // relay has no line for acme.com
  });
  assert.strictEqual(c.entries[0].status, "unsigned");
  assert.strictEqual(c.hasUnsigned, true);
  assert.ok(c.warning, "must warn — the key is not actually on the relay");
});

test("with the relay known, a verified db row still reports verified", () => {
  const c = sd.evaluateSigningCoverage({
    fromAddresses: ["sales@acme.com"],
    rows: [{ domain: "acme.com", status: "verified", installedOnRelay: true }],
    relaySignedDomains: new Set(["acme.com"]),
  });
  assert.strictEqual(c.entries[0].status, "verified");
  assert.strictEqual(c.warning, null);
});

test("the relay lookup is case-insensitive too", () => {
  const c = sd.evaluateSigningCoverage({
    fromAddresses: ["X@ACME.COM"],
    rows: [],
    relaySignedDomains: new Set(["acme.com"]),
  });
  assert.strictEqual(c.entries[0].status, "unverified");
  assert.strictEqual(c.hasUnsigned, false);
});

// ---------------------------------------------------------------------------
// TASK_142 — "signed, but the key is not published" must not read as "unknown".
//
// The live case that prompted this: a mailbox reported
//   "✓ DKIM — Mail from @domain IS signed by the relay, but this account has no
//    DKIM record on file for it, so whether that signature validates is unknown"
// while the DNS answer was in fact a hard NO — the name a receiver fetches had no
// record at all. "Unknown" offers the user no action, and a ✓ in front of it reads
// like success. The states below separate a real DNS negative (definite failure)
// from a resolver that did not answer (genuinely unknown), because those need
// opposite treatment: one is a call to action, the other must accuse nobody.
// ---------------------------------------------------------------------------

test("a signed domain whose key is provably not in DNS is a DEFINITE failure", () => {
  const c = sd.evaluateSigningCoverage({
    fromAddresses: ["fleming@watsonandrade9382.ca.lu"],
    rows: [],
    relaySignedDomains: new Set(["watsonandrade9382.ca.lu"]),
    dkimRecordStates: new Map([["watsonandrade9382.ca.lu", "missing"]]),
  });
  assert.strictEqual(c.entries[0].status, "unpublished");
  assert.deepStrictEqual(c.unpublished, ["watsonandrade9382.ca.lu"]);
  assert.strictEqual(c.hasUnpublished, true);
  // Still NOT "unsigned": the relay does add a signature, and telling the user to
  // install a key that is already installed is the wrong action.
  assert.strictEqual(c.hasUnsigned, false);
  assert.deepStrictEqual(c.unsigned, []);
  // The red box REPLACES the per-entry detail line, so the exact record to publish
  // has to be inside the warning or the user never sees it at all.
  assert.ok(c.warning, "a signature that cannot validate must be surfaced");
  assert.match(c.warning ?? "", /sw\._domainkey\.watsonandrade9382\.ca\.lu/);
  assert.match(c.warning ?? "", /no public key is published/);
});

test("a published key that is NOT ours is also a definite failure, worded differently", () => {
  const c = sd.evaluateSigningCoverage({
    fromAddresses: ["sales@acme.com"],
    rows: [{ domain: "acme.com", status: "pending", installedOnRelay: true }],
    relaySignedDomains: new Set(["acme.com"]),
    dkimRecordStates: new Map([["acme.com", "mismatch"]]),
  });
  assert.strictEqual(c.entries[0].status, "unpublished");
  assert.strictEqual(c.hasUnpublished, true);
  // A stale record and no record need different words: "publish this" versus
  // "what you published is not what we sign with".
  assert.match(c.warning ?? "", /is not the one this relay signs with/);
});

test("a resolver that did not answer stays unknown — never a false failure", () => {
  // SERVFAIL/timeout must NOT be reported as "no record": that would accuse a
  // domain whose DNS is perfectly correct, and send the user to fix nothing.
  const c = sd.evaluateSigningCoverage({
    fromAddresses: ["sales@acme.com"],
    rows: [{ domain: "acme.com", status: "pending", installedOnRelay: true }],
    relaySignedDomains: new Set(["acme.com"]),
    dkimRecordStates: new Map([["acme.com", "unknown"]]),
  });
  assert.strictEqual(c.entries[0].status, "unverified");
  assert.strictEqual(c.hasUnpublished, false);
  assert.strictEqual(c.warning, null);
});

test("a key IS published but cannot be confirmed as ours: no failure claim", () => {
  // The live case for a domain added OUTSIDE this UI (key installed by a script):
  // DNS holds a key, the relay signs, but no row ties the two together. Calling
  // that "no DKIM record on file" was the old wording and it read as a fault.
  // It must also not instruct a re-add: that rotates the key and would break a
  // setup that is working, so the advice has to stay conditional.
  const c = sd.evaluateSigningCoverage({
    fromAddresses: ["fleming@watsonandrade9382.ca.lu"],
    rows: [],
    relaySignedDomains: new Set(["watsonandrade9382.ca.lu"]),
    dkimRecordStates: new Map([["watsonandrade9382.ca.lu", "present"]]),
  });
  assert.strictEqual(c.entries[0].status, "unverified");
  assert.strictEqual(c.hasUnpublished, false, "a published key must never be called broken");
  assert.strictEqual(c.warning, null);
  assert.doesNotMatch(c.entries[0].detail, /no DKIM record on file/);
  assert.match(c.entries[0].detail, /a DKIM key IS published/);
});

test("a live lookup can confirm the whole chain, outranking a stale db row", () => {
  // Stronger than any row: the relay holds the key AND the outside world can fetch
  // it. This is what "verified" should ultimately mean, so it must win over a row
  // still saying "pending" — the opposite direction from the false-negative cases
  // above, and the reason the lookup is not merely additive.
  const c = sd.evaluateSigningCoverage({
    fromAddresses: ["sales@acme.com"],
    rows: [{ domain: "acme.com", status: "pending", installedOnRelay: true }],
    relaySignedDomains: new Set(["acme.com"]),
    dkimRecordStates: new Map([["acme.com", "verified"]]),
  });
  assert.strictEqual(c.entries[0].status, "verified");
  assert.strictEqual(c.warning, null);
});

test("dkimRecordStates matching is case-insensitive, like the domain itself", () => {
  // Our own lookup supplies this map, but normalising it inside the decision keeps
  // every caller honest: an odd-cased key must not make a published key look gone.
  const c = sd.evaluateSigningCoverage({
    fromAddresses: ["X@acme.com"],
    rows: [],
    relaySignedDomains: new Set(["acme.com"]),
    dkimRecordStates: new Map([["ACME.COM", "missing"]]),
  });
  assert.strictEqual(c.entries[0].status, "unpublished");
});

test("the record named in the warning uses the selector the domain was added with", () => {
  // A non-default selector must reach the advice, or we tell the user to publish a
  // name nobody will ever query — and the receiver fetches nothing.
  const c = sd.evaluateSigningCoverage({
    fromAddresses: ["sales@acme.com"],
    rows: [],
    relaySignedDomains: new Set(["acme.com"]),
    dkimRecordStates: new Map([["acme.com", "missing"]]),
    selector: "mail",
  });
  assert.match(c.warning ?? "", /mail\._domainkey\.acme\.com/);
});

test("unsigned and unpublished are BOTH reported, not just whichever came first", () => {
  // A mailbox rotating several From addresses must not have the second problem
  // hidden behind the first — the two have different fixes.
  const c = sd.evaluateSigningCoverage({
    fromAddresses: ["a@broken.com", "b@nosign.com"],
    rows: [],
    relaySignedDomains: new Set(["broken.com"]),
    dkimRecordStates: new Map([["broken.com", "missing"]]),
  });
  assert.strictEqual(c.hasUnsigned, true);
  assert.strictEqual(c.hasUnpublished, true);
  assert.match(c.warning ?? "", /@nosign\.com/); // unsigned: no key on the relay
  assert.match(c.warning ?? "", /@broken\.com/); // signed: key not published
});

test("with no lookup performed, the verdict claims nothing either way", () => {
  // Absent dkimRecordStates means nobody asked. The wording must stay the
  // conservative "unknown" rather than inventing a DNS answer we did not get.
  const c = sd.evaluateSigningCoverage({
    fromAddresses: ["fleming@watsonandrade9382.ca.lu"],
    rows: [],
    relaySignedDomains: new Set(["watsonandrade9382.ca.lu"]),
  });
  assert.strictEqual(c.entries[0].status, "unverified");
  assert.strictEqual(c.hasUnpublished, false);
  assert.deepStrictEqual(c.unpublished, []);
  assert.strictEqual(c.warning, null);
});

// ---------------------------------------------------------------------------
// The DNS layer itself. Everything above pins the DECISION; this pins the ANSWER
// the decision is fed. It is the half that turns a resolver error into either
// "no key is published" (a call to action) or "we could not tell" (silence), and
// conflating them is how a domain set up perfectly gets told it is broken.
//
// These tests are also the canary for the require hook above. The first two and
// the "no p=" case would still pass if the hook silently stopped applying, because
// a real resolver answering NXDOMAIN produces the same "missing" verdict — but the
// chunked-key and record-name cases below assert values that exist ONLY in the
// table, so they fail loudly if the stub is not in force. That is deliberate: the
// hook's suffix check was written once without the ".ts" extension and matched
// nothing, and only those table-only assertions revealed it.
// ---------------------------------------------------------------------------

test("a name with no TXT record is a DEFINITE missing key", async () => {
  // ENOTFOUND is the resolver answering "that name does not exist" — which is
  // exactly what a receiver concludes when it fetches the name and finds nothing.
  setDnsFailure(`${SELECTOR}._domainkey.nokey.test`, "ENOTFOUND");
  assert.strictEqual(
    await cov.lookupDkimState(`${SELECTOR}._domainkey.nokey.test`, null),
    "missing"
  );
});

test("ENODATA — the name exists but carries no TXT — is missing too", async () => {
  setDnsFailure(`${SELECTOR}._domainkey.emptyname.test`, "ENODATA");
  assert.strictEqual(
    await cov.lookupDkimState(`${SELECTOR}._domainkey.emptyname.test`, null),
    "missing"
  );
});

test("a resolver that FAILS (SERVFAIL) must stay unknown, never 'missing'", async () => {
  // The false-accusation guard, at the DNS layer. SERVFAIL says nothing about
  // whether the record exists; reporting "no key is published" here would send
  // the user to publish a record that may already be correct and live.
  setDnsFailure(`${SELECTOR}._domainkey.flaky.test`, "SERVFAIL");
  assert.strictEqual(
    await cov.lookupDkimState(`${SELECTOR}._domainkey.flaky.test`, null),
    "unknown"
  );
});

test("a resolver that never answers is bounded, and still unknown", async () => {
  // A stalled resolver must not become a stalled Test-connection screen, so the
  // wait is bounded — and what it yields must be "we could not tell", not a verdict
  // against the domain. The injected 50 ms timeout keeps this test honest and fast;
  // with the 2.5 s production default it would still only ever return "unknown".
  setHang(`${SELECTOR}._domainkey.hangs.test`);
  const started = Date.now();
  const state = await cov.lookupDkimState(`${SELECTOR}._domainkey.hangs.test`, null, 50);
  const elapsed = Date.now() - started;
  assert.strictEqual(state, "unknown");
  assert.ok(elapsed < 1_000, `bounded wait must fire promptly, took ${elapsed}ms`);
});

test("a TXT with no p= is 'missing': there is no key to verify with", async () => {
  // A policy record, or a paste that lost the p= entirely. Reporting "present"
  // would promise a check that cannot happen.
  setTxt(`${SELECTOR}._domainkey.nop.test`, ["v=DKIM1; k=rsa"]);
  assert.strictEqual(await cov.lookupDkimState(`${SELECTOR}._domainkey.nop.test`, null), "missing");
});

test("a chunked 2048-bit key is REJOINED, then verified against what we sign with", async () => {
  // A 2048-bit key's p= is ~372 chars, so the resolver hands it back in >255-byte
  // chunks. If the chunks are not rejoined the key reads as truncated and every
  // correctly published record is reported as a mismatch — a false negative on a
  // perfect setup, and the reason the real chunking shape is modelled here.
  const pair = sd.generateDkimKeypair(2048);
  assert.ok(pair.publicKeyTxt.length > 255, "test premise: this key is long enough to chunk");
  const name = `${SELECTOR}._domainkey.chunked.test`;
  setTxt(name, [pair.publicKeyTxt]);
  const expectedP = sd.dkimPublicKeyOf(pair.publicKeyTxt);

  assert.strictEqual(await cov.lookupDkimState(name, expectedP), "verified");
  // Same record, but this account does not know the key it signs with: a published
  // key we cannot tie to ourselves is "present", never "verified" and never a fault.
  assert.strictEqual(await cov.lookupDkimState(name, null), "present");
  // A DIFFERENT key at the name means our signature will not validate, even though
  // a DKIM record exists and looks healthy.
  const other = sd.dkimPublicKeyOf(sd.generateDkimKeypair(2048).publicKeyTxt);
  assert.strictEqual(await cov.lookupDkimState(name, other), "mismatch");
});

test("a name is asked about exactly as the verifier publishes it", async () => {
  // The advice names this record and the lookup queries this record, and they are
  // built by the same helper — so a non-default selector cannot drift between the
  // two and leave the user publishing a name nobody queries.
  const name = sd.dkimRecordName("acme.com", "mail");
  setTxt(name, ["v=DKIM1; k=rsa; p=Zm9v"]);
  assert.strictEqual(await cov.lookupDkimState(name, null), "present");
  assert.strictEqual(name, "mail._domainkey.acme.com");
});

