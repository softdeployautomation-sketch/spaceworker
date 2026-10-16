/**
 * scripts/lib/crx3.mjs — minimal CRX3 packer for the clone-extension force-
 * install layer (TASK_214 D6). Pure node:crypto, no dependencies, and
 * DELIBERATELY incapable of generating a key: the whole point of the stable
 * extension ID is that the .pem is generated ONCE by the owner and never
 * replaced (a new key = a new ID = every deployed ExtensionInstallForcelist
 * silently stops matching). This module only consumes an existing RSA PEM.
 *
 * CRX3 layout (Chromium crx3.proto):
 *   "Cr24" | uint32le version=3 | uint32le header_len | header | zip payload
 *   header = CrxFileHeader{ sha256_with_rsa: [AsymmetricKeyProof{
 *     sha256_with_rsa: MessageSha256WithRsa{ public_key: SPKI_DER, signature } }]}
 *   signature = RSA-SHA256 over "CRX3 SignedData\0" + varint32(len) + SignedData
 *   SignedData{ crx_id = sha256(SPKI_DER)[0..16] }
 *   extension id = crx_id hex, each nibble mapped 0..f -> a..p
 */
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";

/** varint32 encoder (lengths here are < 128, but be correct anyway). */
function varint(n) {
  const out = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return Buffer.from(out);
}

/** protobuf wire: field number `field`, length-delimited `data`. */
function pbBytes(field, data) {
  const tag = Buffer.from([(field << 3) | 0x02]);
  return Buffer.concat([tag, varint(data.length), data]);
}

function u32le(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
}

/**
 * Pack `zipBytes` into a CRX3 using the PERSISTENT RSA key in `privateKeyPem`.
 * Throws on anything that would produce an unstable or invalid CRX — loud
 * beats silent here for the same reason the build refuses to generate a key.
 *
 * @param {string} privateKeyPem  PKCS#8/PKCS#1 RSA private key (the .pem secret)
 * @param {Buffer} zipBytes       the packed extension zip
 * @returns {{ crx: Buffer, extensionId: string, crxId: Buffer }}
 */
export function packCrx3(privateKeyPem, zipBytes) {
  if (!Buffer.isBuffer(zipBytes) || zipBytes.length === 0) {
    throw new Error("packCrx3: zipBytes must be a non-empty Buffer");
  }
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== "rsa") {
    // Chrome's CRX3 sha256_with_rsa proof (and every force-install doc) is
    // RSA; an EC key would need the ecdsa proof path and a different id
    // derivation. Refuse rather than mint something Chrome may reject.
    throw new Error(
      `packCrx3: signing key must be RSA (got ${privateKey.asymmetricKeyType}) — regenerate the .pem as RSA, do not reuse an EC key`,
    );
  }
  const spki = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  const crxId = createHash("sha256").update(spki).digest().subarray(0, 16);

  const signedData = pbBytes(1, crxId); // SignedData{ crx_id }
  const sigInput = Buffer.concat([
    Buffer.from("CRX3 SignedData\0", "latin1"),
    varint(signedData.length),
    signedData,
  ]);
  const signature = sign("sha256", sigInput, privateKey); // RSA PKCS#1 v1.5

  const msgRsa = Buffer.concat([pbBytes(1, spki), pbBytes(2, signature)]);
  const proof = pbBytes(1, msgRsa); // AsymmetricKeyProof{ sha256_with_rsa }
  const header = pbBytes(1, proof); // CrxFileHeader{ sha256_with_rsa: [proof] }

  const crx = Buffer.concat([Buffer.from("Cr24", "latin1"), u32le(3), u32le(header.length), header, zipBytes]);

  // id derivation: each nibble of crx_id hex, 0..f -> a..p (Chrome's alphabet)
  const extensionId = Buffer.from(crxId)
    .toString("hex")
    .replace(/[0-9a-f]/g, (c) => "abcdefghijklmnop"[parseInt(c, 16)]);

  return { crx, extensionId, crxId };
}

/**
 * The update manifest the ExtensionInstallForcelist policy fetches, in the
 * `genc` shape the device-side forcelist step reads (lib/clone-setup.ts
 * buildExtensionInstallScript reads $mf.genc — single source of truth for the
 * extension ID on BOTH sides: here from the .pem at build time, there from
 * this manifest at install time; neither ever guesses the ID).
 */
export function updateManifestJson({ publicBase, extensionId, version }) {
  const crxUrl = `${publicBase.replace(/\/+$/, "")}/clone-ext/clone-extension.crx`;
  return `${JSON.stringify({ genc: { [extensionId]: { crx_url: crxUrl, version } } }, null, 2)}\n`;
}
