import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// TASK_143 — regression guard for lib/campaign-message.ts.
//
// WHY THIS FILE EXISTS: the real queue send and the deliverability TEST send used
// to assemble their MIME payloads in two different places, and they drifted in
// exactly the two ways that decide inbox vs spam:
//
//   - the real send included a plaintext alternative; the test send did not, so
//     every test went out as an HTML-only single-part message — a long-documented
//     spam heuristic.
//   - the real send included List-Unsubscribe/-Post AND a visible footer link; the
//     test send included neither.
//
// The consequence was worse than a cosmetic mismatch: the "deliverability gate"
// that must pass before a campaign may send was grading a message no recipient
// would ever receive. Confirmed live 2026-09-29 — a hand-built plaintext message
// through the same mailbox, SMTP login and From address reached the Comcast
// inbox, while the app's own test sends did not.
//
// So this file asserts two different things, on purpose:
//
//   1. BEHAVIOUR of the builder (the parts a message needs to be deliverable).
//   2. That BOTH callers still route through it — a unit test on the builder
//      alone would pass happily while a future edit re-inlined a divergent copy
//      at one call site, which is precisely the bug being fixed here.

type Loader = {
  _load: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown;
};

/**
 * Deterministic stand-ins. `lib/env.ts` calls required() at import time and would
 * throw without the whole production environment, so it is replaced wholesale —
 * but with a REAL HMAC-usable sessionSecret, because unsubscribe-token.ts signs
 * with it and the token check below has to exercise real signing, not a stub.
 */
const FAKE_APP_BASE_URL = "https://spaceworker.test";
const FAKE_ENV = { env: { appBaseUrl: FAKE_APP_BASE_URL, sessionSecret: "test-secret-for-unit-tests" } };

function installRequireHook(): void {
  const loader = Module as unknown as Loader;
  const original = loader._load;
  loader._load = function patched(request, parent, isMain) {
    if (request === "server-only") return {};
    // Both spellings must be caught: campaign-message.ts imports "./env" while
    // unsubscribe-token.ts imports "@/lib/env". Node caches by resolved filename,
    // so whichever loads first wins for both — missing either one means the REAL
    // lib/env.ts loads and every test below dies at import with "Missing required
    // environment variable", which reads as a broken test rather than a missing stub.
    if (request === "./env" || request === "@/lib/env") return FAKE_ENV;
    return original.call(this, request, parent, isMain);
  };
}

installRequireHook();

/* eslint-disable @typescript-eslint/no-require-imports */
const cm = require("../lib/campaign-message") as typeof import("../lib/campaign-message");
const tokens = require("../lib/unsubscribe-token") as typeof import("../lib/unsubscribe-token");
const { htmlToPlainText } = require("../lib/html-to-text") as typeof import("../lib/html-to-text");
/* eslint-enable @typescript-eslint/no-require-imports */

const USER = "user_abc123";
const FROM = "admin@sindibad.cz";

function build(body = "<p>hello</p>", toEmail = "typple6@comcast.net") {
  return cm.buildCampaignMessage({
    subject: "Me to you",
    bodyHtml: body,
    from: FROM,
    toEmail,
    userId: USER,
  });
}

/**
 * `CampaignMessage.html` is OPTIONAL in the type because a text-only campaign has
 * no HTML part at all (Task 144). These helpers keep every html assertion honest:
 * they fail loudly on a missing part instead of silently asserting against
 * `undefined`, which is exactly the mistake the optional type exists to expose.
 */
function htmlOf(m: ReturnType<typeof cm.buildCampaignMessage>): string {
  assert.ok(m.html !== undefined, "an html-format message must carry an html part");
  return m.html;
}

test("the unsubscribe URL is byte-identical in the header, the html footer and the text footer", () => {
  const m = build();
  // One URL, three places. If they disagree, one-click breaks for clients that
  // use the header while the visible link points somewhere else — and a mismatch
  // is invisible in the UI.
  const headerUrl = /<(https:[^>]+)>/.exec(m.headers["List-Unsubscribe"])?.[1];
  assert.ok(headerUrl, "the https arm must be present in List-Unsubscribe");
  assert.ok(htmlOf(m).includes(headerUrl), "the html footer must link to the same URL");
  assert.ok(m.text.includes(headerUrl), "the text footer must name the same URL");
});

test("the unsubscribe token really encodes THIS recipient, so no one can unsubscribe anyone else", () => {
  const m = build();
  const url = /<(https:[^>]+)>/.exec(m.headers["List-Unsubscribe"])?.[1];
  assert.ok(url);
  const token = url.slice(`${FAKE_APP_BASE_URL}/api/unsubscribe/`.length);
  // Verified with the app's own verifier, not a string comparison: this is what
  // proves the link a recipient receives actually resolves to their own record.
  const decoded = tokens.verifyUnsubscribeToken(token);
  assert.deepEqual(decoded, { userId: USER, email: "typple6@comcast.net" });
});

test("two different recipients get different unsubscribe URLs", () => {
  const a = build("<p>hello</p>", "one@example.com");
  const b = build("<p>hello</p>", "two@example.com");
  assert.notEqual(a.headers["List-Unsubscribe"], b.headers["List-Unsubscribe"]);
});

test("a plaintext alternative is ALWAYS produced, and it contains no markup", () => {
  // This is the headline regression: an HTML-only single-part message is both a
  // spam heuristic and a compliance gap, and it is what every test send used to be.
  const html = "<div><p>Hello <strong>there</strong></p><p>Second line</p></div>";
  const m = build(html);
  assert.ok(m.text.length > 0, "a text part must never be empty");
  assert.ok(!/<[a-z/]/i.test(m.text), `the text part must not contain tags: ${JSON.stringify(m.text)}`);
  assert.ok(m.text.includes("Hello there"), "the visible words must survive conversion");
  assert.ok(m.text.includes("Second line"), "block boundaries must survive as line breaks");
  // ...and it must equal the shared converter's output, so the text part can never
  // be built by a second, divergent implementation.
  assert.ok(m.text.startsWith(htmlToPlainText(html)));
});

test("both RFC 8058 headers are present, with a one-click POST declaration", () => {
  const m = build();
  assert.match(m.headers["List-Unsubscribe"], /^<mailto:admin@sindibad\.cz\?subject=unsubscribe>, <https:/);
  assert.equal(m.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
});

test("the mailto arm uses the message's own From, so replies-to-unsubscribe reach the real sender", () => {
  const m = cm.buildCampaignMessage({
    subject: "s",
    bodyHtml: "<p>x</p>",
    from: "other@sindibad.cz",
    toEmail: "typple6@comcast.net",
    userId: USER,
  });
  assert.ok(m.headers["List-Unsubscribe"].includes("<mailto:other@sindibad.cz?subject=unsubscribe>"));
});

// Task 144 — plain-text-only campaigns.
//
// WHY THIS EXISTS: an HTML-only single-part message is a documented spam
// heuristic, and "send it as plain text" is the strongest lever available short
// of changing domain authentication. The failure mode that matters is subtle —
// a text campaign that STILL emits an html part is not text-only at all, and
// would look fine in every log while changing nothing about the recipient's
// verdict.

test("a text-format message has NO html part at all — that is the whole point", () => {
  const m = cm.buildCampaignMessage({
    subject: "Me to you",
    bodyHtml: "hello",
    from: FROM,
    toEmail: "typple6@comcast.net",
    userId: USER,
    format: "text",
  });
  assert.equal(m.html, undefined, "a text-only send must not carry an html part");
  assert.equal(m.text.includes("<p"), false, "the text part must not contain markup");
});

test("a text-format message takes the body literally, verbatim", () => {
  // The user chose text; if they typed markup it goes out as typed. Silently
  // stripping it would be a second, invisible rewrite of their content.
  const m = cm.buildCampaignMessage({
    subject: "s",
    bodyHtml: "line one\nline two",
    from: FROM,
    toEmail: "a@b.com",
    userId: USER,
    format: "text",
  });
  assert.ok(m.text.startsWith("line one\nline two"), "the body must lead the text part");
});

test("a text-format message still carries a usable unsubscribe route", () => {
  const m = cm.buildCampaignMessage({
    subject: "s",
    bodyHtml: "hi",
    from: FROM,
    toEmail: "a@b.com",
    userId: USER,
    format: "text",
  });
  const url = `${FAKE_APP_BASE_URL}/api/unsubscribe/${tokens.generateUnsubscribeToken(USER, "a@b.com")}`;
  assert.ok(m.text.includes(url), "the text footer must contain the unsubscribe URL");
  assert.equal(m.headers["List-Unsubscribe"].includes(url), true, "and so must the header");
});

test("format is optional and defaults to html — existing campaigns are untouched", () => {
  const withDefault = cm.buildCampaignMessage({
    subject: "s",
    bodyHtml: "<p>x</p>",
    from: FROM,
    toEmail: "a@b.com",
    userId: USER,
  });
  assert.ok(withDefault.html !== undefined, "omitting the format must keep the html part");
});

test("normalizeBodyFormat degrades an unknown value to html, never to text", () => {
  // A typo must never surprise-blast a campaign as text-only; it falls back to
  // the pre-existing behaviour instead.
  assert.equal(cm.normalizeBodyFormat("text"), "text");
  assert.equal(cm.normalizeBodyFormat("html"), "html");
  for (const bad of [undefined, null, "", "TEXT", "rich", 7, {}]) {
    assert.equal(cm.normalizeBodyFormat(bad), "html", `expected html for ${JSON.stringify(bad)}`);
  }
});

test("a body with no HTML at all still round-trips (the thin 'hello' campaign case)", () => {
  const m = build("hello");
  assert.ok(m.text.startsWith("hello"));
  assert.ok(htmlOf(m).startsWith("hello<p style="), "the footer is appended, never substituted");
});

test("the footer is appended to the html, not substituted for it", () => {
  const m = build("<p>body text here</p>");
  assert.ok(htmlOf(m).startsWith("<p>body text here</p>"), "the original html must come first, untouched");
  assert.ok(htmlOf(m).includes("unsubscribe here"), "the visible footer link must be present");
});

// ---------------------------------------------------------------------------
// The drift guard. Both of these read the real route/module source, because the
// failure mode being prevented is "someone re-inlines the message assembly at one
// call site" — which no behavioural test on the builder itself can detect.
// ---------------------------------------------------------------------------

const CALLERS = [
  "app/api/internal/mail-queue-drain/route.ts",
  "lib/deliverability.ts",
];

test("every send path assembles its message through the shared builder", () => {
  for (const rel of CALLERS) {
    const src = readFileSync(join(process.cwd(), rel), "utf8");
    assert.ok(
      src.includes("buildCampaignMessage"),
      `${rel} must build its message with buildCampaignMessage — a second, hand-rolled ` +
        `payload is exactly how the test send drifted away from the real send`
    );
  }
});

test("no send path hand-rolls its own unsubscribe headers or plaintext alternative", () => {
  for (const rel of CALLERS) {
    const src = readFileSync(join(process.cwd(), rel), "utf8");
    // The header name appearing as a STRING LITERAL means it is being built here.
    // (A comment mentioning it is fine and expected — hence the quote characters.)
    assert.ok(
      !src.includes('"List-Unsubscribe"') && !src.includes("'List-Unsubscribe'"),
      `${rel} constructs List-Unsubscribe inline; it must come from lib/campaign-message.ts`
    );
    assert.ok(
      !/htmlToPlainText\(/.test(src),
      `${rel} builds its own plaintext alternative; a message built in two places drifts`
    );
  }
});

