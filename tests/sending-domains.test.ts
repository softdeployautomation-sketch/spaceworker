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

const MODULE_UNDER_TEST = "lib/sending-domains.ts";

/** Tiny hermetic TXT table: name -> records (each record as its own string). */
const txtTable = new Map<string, string[]>();
function setTxt(name: string, records: string[]): void {
  txtTable.set(name, records);
}

function installRequireHook(): void {
  const loader = Module as unknown as Loader;
  const original = loader._load;
  loader._load = function patched(request, parent, isMain) {
    if (request === "server-only") return {};
    const from = (parent?.filename ?? "").replace(/\\/g, "/");
    if (
      request === "node:dns/promises" &&
      (from.endsWith(`/${MODULE_UNDER_TEST}`) || from.endsWith("/lib/sending-domains"))
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

