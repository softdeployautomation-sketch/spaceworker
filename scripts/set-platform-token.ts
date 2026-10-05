/**
 * TASK_160 — store a Cloudflare Zones/Workers token for a hosting platform
 * account, from the terminal, with the read-back PROOF printed.
 *
 *   Why this exists: the owner has reported three times that a Cloudflare token
 *   "did not stick". The write path was never at fault — it was the BROWSER.
 *   A `type="password"` field can be autofilled wrong, the tab can go stale, the
 *   subdomain input sits right next to it, and none of that is diagnosable
 *   after the fact. The fix for a recurring human error is to remove the human
 *   step from the loop where you can, so this script:
 *
 *     1. takes the token on STDIN (never argv — argv is visible in `ps` and lands
 *        in shell history; a here-doc keeps it out of both),
 *     2. writes it through the SAME `updatePlatformAccount()` the panel calls, so
 *        it exercises the real read-back guarantee rather than a parallel one,
 *     3. re-reads the row and DECRYPTS it in a separate query, so the proof is
 *        independent of the writer's own claim,
 *     4. prints ONLY the last four characters, ever.
 *
 * Usage (on the box, as the app user so it reads the real .env):
 *   printf '%s' "$TOKEN" | npx tsx --require ./scripts/stub-server-only.cjs \
 *     scripts/set-platform-token.ts --label "New Prod" --field zone
 *
 * House pattern (cf. scripts/task156-c1-evidence.ts). Not part of the shipped app.
 * NEVER run with a token in argv. Never paste a token into a chat window.
 */
import { prisma } from "../lib/prisma";
import { updatePlatformAccount, listPlatformAccounts } from "../lib/hosting/platform-accounts";
import { decryptSecret } from "../lib/mailbox-crypto";

type Field = "zone" | "worker" | "pages";

/** Last 4 chars, for a display hint. The single place this script can leak. */
function hint(token: string): string {
  return token.length <= 4 ? token : token.slice(-4);
}

function parseArgs(argv: string[]): { label: string; field: Field } {
  let label = "";
  let field = "";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--label") label = argv[++i] ?? "";
    else if (argv[i] === "--field") field = argv[++i] ?? "";
  }
  if (!label) throw new Error("--label is required (match the account's label exactly).");
  if (field !== "zone" && field !== "worker" && field !== "pages") {
    throw new Error("--field must be one of: zone, worker, pages.");
  }
  return { label, field };
}

/** Read one line from stdin without ever putting it on the command line. */
async function readTokenFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function main(): Promise<void> {
  const { label, field } = parseArgs(process.argv.slice(2));
  const key = field === "zone" ? "zoneToken" : field === "worker" ? "workerToken" : "token";

  const accounts = await listPlatformAccounts();
  const target = accounts.find((a) => a.label.toLowerCase() === label.toLowerCase());
  if (!target) {
    console.error(`No account labelled "${label}". Known accounts:`);
    for (const a of accounts) console.error(`  priority ${a.priority} — ${a.label}`);
    process.exitCode = 1;
    return;
  }

  const token = await readTokenFromStdin();
  if (!token) {
    console.error("No token on stdin. Pipe it:  printf '%s' \"$TOKEN\" | tsx …");
    process.exitCode = 1;
    return;
  }
  // The ORIGINAL bug: a token pasted into the workers.dev subdomain box, or read
  // off the wrong line of the Cloudflare dashboard. Both are plain lowercase
  // words with hyphens; a real API token is mixed-case and 40 chars. Refusing
  // here is cheap — the owner re-runs the command — whereas storing a subdomain
  // as a credential produces a red panel at 3am with no clue why.
  if (/^[a-z0-9]+(-[a-z0-9]+)*$/.test(token)) {
    console.error(`That is a subdomain, not a Cloudflare API token ("${token}").`);
    console.error("This is the exact mistake that caused the original problem. Refusing to store it.");
    process.exitCode = 1;
    return;
  }
  if (token.includes(" ")) {
    console.error("That looks like a sentence, not a Cloudflare API token. Refusing to store it.");
    process.exitCode = 1;
    return;
  }
  if (token.length !== 40) {
    // Not fatal — a token length may legitimately differ — but say it plainly
    // rather than storing it and leaving the owner to find out later.
    console.warn(`WARNING: Cloudflare API tokens are 40 characters; this is ${token.length}.`);
    console.warn("Proceeding — the write is still verified below, but check you copied the whole token.");
  }

  console.log(`Writing the ${field} token for "${target.label}" (priority ${target.priority})…`);

  const result = await updatePlatformAccount({ id: target.id, [key]: token } as never);
  if (!result.ok) {
    console.error(`\nWRITE FAILED [${result.code}] ${result.message}`);
    process.exitCode = 1;
    return;
  }

  // --- Independent read-back. Not the writer's return value: a fresh query that
  // decrypts the stored copy, so this proves the bytes are really in Postgres.
  const fresh = await prisma.hostingPlatformAccount.findUnique({ where: { id: target.id } });
  const cols = field === "zone"
    ? { c: fresh?.zoneTokenCiphertext, i: fresh?.zoneTokenIv, t: fresh?.zoneTokenTag, h: fresh?.zoneTokenHint ?? "" }
    : field === "worker"
      ? { c: fresh?.workerTokenCiphertext, i: fresh?.workerTokenIv, t: fresh?.workerTokenTag, h: fresh?.workerTokenHint ?? "" }
      : { c: fresh?.tokenCiphertext, i: fresh?.tokenIv, t: fresh?.tokenTag, h: fresh?.tokenHint ?? "" };

  if (!cols.c || !cols.i || !cols.t) {
    console.error("\nNOT PERSISTED: the row has no ciphertext after a successful write.");
    process.exitCode = 1;
    return;
  }
  const decrypted = decryptSecret(cols.c, cols.i, cols.t);
  const matches = decrypted.trim() === token;
  const hintOk = cols.h === hint(token);

  console.log(`\nciphertext  : present (${cols.c.length} chars)`);
  console.log(`hint stored : …${cols.h || "(none)"}`);
  console.log(`decrypts to : …${hint(decrypted)}`);
  console.log(`matches     : ${matches ? "YES" : "NO"}`);
  console.log(`hint agrees : ${hintOk ? "YES" : "NO"}`);

  if (!matches || !hintOk) {
    console.error("\nNOT PERSISTED: the stored copy does not equal what was submitted.");
    process.exitCode = 1;
    return;
  }
  console.log(`\nVERIFIED. The ${field} token for "${target.label}" is stored and readable.`);
  if (field === "zone") {
    console.log("Note: TASK_160 is still OPEN — zoneTokenError is never written, so a");
    console.log("token stored here is NOT yet proven to have the zone.create scope.");
  }
}

main()
  .catch((e) => {
    console.error(`\nERROR: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());