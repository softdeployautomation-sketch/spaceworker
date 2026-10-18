import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

// ---------------------------------------------------------------------------
// TASK_202 B — every new signup alerts the ADMIN by email, matching the
// Telegram alert that already fires via notifyAdmin. The contract, and why
// each assertion exists:
//   1. THE ADMIN EMAIL GOES OUT on a valid signup (to env.adminEmail only —
//      never to the user), with the eventType NotificationLog keys on.
//   2. NO ADMIN EMAIL when env.adminEmail is unset (the guard must short-
//      circuit before sendEmail, or Resend gets a request with an empty
//      recipient).
//   3. BEST-EFFORT BOTH WAYS — a Resend failure must not fail the signup
//      (the account is already created; the verify-code email is the gate,
//      the alert is informational).
//
// Route-level with the house Module._load pattern: the REAL route runs, only
// its imports (@/lib/db, @/lib/env, @/lib/email, @/lib/telegram, …) are faked.
// ---------------------------------------------------------------------------

process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://test:test@127.0.0.1:5432/test";

const SIGNUP_ROUTE = "/app/api/auth/signup/route.ts";

const fakeNextResponse = {
  json: (data: unknown, init?: { status?: number }) => ({
    status: init?.status ?? 200,
    body: data,
    json: async () => data,
  }),
};

const state: {
  adminEmail: string;
  emailThrows: boolean;
  /** The sw_ref cookie the request carries (undefined = no access token at all). */
  refCookie?: string;
  /** What validateReferral(refCookie) resolves to — a universal referral link. */
  referralLink: { id: string; code: string; ownerEmail: string } | null;
  /** What getInviteByCode(refCookie) resolves to — a personalized Model C invite. */
  invite: {
    id: string;
    inviteeEmail: string;
    isActive: boolean;
    redeemedAt: string | null;
    referredById: string | null;
  } | null;
} = {
  adminEmail: "boss@example.com",
  emailThrows: false,
  refCookie: "REF12345",
  referralLink: null,
  invite: null,
};
const calls = {
  emails: [] as Array<Record<string, unknown>>,
  telegramAlerts: [] as string[],
  created: [] as Array<{ email: string }>,
};

const fakeDb = {
  user: {
    findUnique: async () => null, // no pre-existing account — the happy path
    create: async ({ data }: { data: { email: string } }) => {
      calls.created.push({ email: data.email });
      return { id: "u_new", email: data.email };
    },
  },
};

function freshRoute() {
  let overrides: Record<string, unknown> = {};
  const loader = Module as unknown as {
    _load: (r: string, p: NodeModule | undefined, m: boolean) => unknown;
  };
  const originalLoad = loader._load;
  loader._load = function patched(request, parent, isMain) {
    const from = (parent?.filename ?? "").replace(/\\/g, "/");
    if (from.endsWith(SIGNUP_ROUTE)) {
      if (request in overrides) return overrides[request];
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  overrides = {
    "next/server": { NextResponse: fakeNextResponse },
    "@/lib/db": { db: fakeDb },
    "@/lib/env": { env: { adminEmail: state.adminEmail, adminTelegramChatId: "" } },
    "@/lib/email": {
      sendEmail: async (opts: Record<string, unknown>) => {
        calls.emails.push(opts);
        if (state.emailThrows) throw new Error("resend down");
      },
      verificationEmailHtml: () => "<p>code</p>",
      tier1UpgradeEmailHtml: () => "<p>t1</p>",
    },
    "@/lib/auth": { hashPassword: async () => "hashed" },
    "@/lib/rate-limit": {
      allowAndRecord: async () => true,
      getClientIp: async () => "10.0.0.1",
    },
    "@/lib/telegram": {
      notifyAdmin: async (text: string) => void calls.telegramAlerts.push(text),
    },
    "@/lib/verify-code": { issueVerificationCode: async () => ({ code: "123456" }) },
    // Hidden-login / invite-only additions to the signup route — fake them so the
    // REAL @/lib/referral (which does `import "server-only"`) is never loaded here.
    // F8: the route resolves the sw_ref cookie to EITHER a valid universal referral
    // link OR a valid personalized invite, and refuses with 403 when it resolves to
    // neither. The cookies() + referral fakes below read `state`, so each test can
    // present a valid link, a valid invite, an unusable code, or no code at all.
    "next/headers": {
      cookies: async () => ({
        get: (name: string) =>
          name === "sw_ref" && state.refCookie
            ? { name: "sw_ref", value: state.refCookie }
            : undefined,
      }),
    },
    "@/lib/referral": {
      validateReferral: async () => state.referralLink,
      attributeReferral: async () => undefined,
      getUserReferralLink: async () => ({
        id: "link_1",
        code: "CODE1234",
        ownerEmail: "owner@x.dev",
        clicks: 0,
        conversions: 0,
      }),
      getInviteByCode: async () => state.invite,
      markInviteRedeemed: async () => undefined,
    },
  };
  const abs = require.resolve(`..${SIGNUP_ROUTE}`);
  delete require.cache[abs];
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    return require(abs) as {
      POST: (req: Request) => Promise<{ status: number; body: unknown }>;
    };
    /* eslint-enable @typescript-eslint/no-require-imports */
  } finally {
    loader._load = originalLoad;
  }
}

function signupReq(email = "newuser@x.dev") {
  return new Request("http://localhost/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password: "hunter2hunter2",
      acceptedTerms: true,
    }),
  });
}

beforeEach(() => {
  state.adminEmail = "boss@example.com";
  state.emailThrows = false;
  calls.emails.length = 0;
  calls.telegramAlerts.length = 0;
  calls.created.length = 0;
  // F8 access token: default to a resolvable universal referral link on sw_ref,
  // so every pre-existing happy-path test still reaches the 201 branch. The gate
  // tests below override these to present no code / an invite instead.
  state.refCookie = "REF12345";
  state.referralLink = { id: "link_1", code: "REF12345", ownerEmail: "owner@x.dev" };
  state.invite = null;
});

test("TASK_202 B: a valid signup emails the ADMIN (env.adminEmail) with the signup eventType", async () => {
  const route = freshRoute();
  const res = await route.POST(signupReq());
  assert.equal(res.status, 201);

  assert.equal(calls.telegramAlerts.length, 1, "the Telegram alert still fires");
  assert.ok(calls.telegramAlerts[0].includes("newuser@x.dev"));

  const adminMail = calls.emails.find((e) => e.to === "boss@example.com");
  assert.ok(adminMail, "the admin email went out");
  assert.equal(adminMail.subject, "New SpaceWorker signup: newuser@x.dev");
  assert.equal(adminMail.eventType, "admin_signup_alert");
  assert.ok(String(adminMail.html).includes("newuser@x.dev"));

  const toUser = calls.emails.filter((e) => e.to === "newuser@x.dev");
  assert.equal(toUser.length, 2, "the user still gets verify-code + tier1 only");
});

test("TASK_202 B: no adminEmail configured ⇒ no admin alert, the user flow is untouched", async () => {
  state.adminEmail = "";
  const route = freshRoute();
  const res = await route.POST(signupReq());
  assert.equal(res.status, 201);
  assert.equal(
    calls.emails.filter((e) => e.to === "").length,
    0,
    "no email is ever sent to an empty recipient",
  );
  assert.equal(calls.emails.filter((e) => e.to === "boss@example.com").length, 0);
  assert.equal(calls.emails.filter((e) => e.to === "newuser@x.dev").length, 2, "user emails intact");
});

test("TASK_202 B: Resend failing never fails the signup — account created, 201 returned", async () => {
  state.emailThrows = true;
  const route = freshRoute();
  const res = await route.POST(signupReq());
  assert.equal(res.status, 201, "an alert channel must never break the flow it reports on");
  assert.equal(calls.created.length, 1, "the account exists");
});

// ---------------------------------------------------------------------------
// F8 (TASK_221) — the invite-only gate, enforced at the API like the pages
// ---------------------------------------------------------------------------

test("F8: a signup with NO sw_ref code and NO invite is refused with 403 — the API matches the invite-only /signup gate", async () => {
  state.refCookie = undefined; // no ?ref= cookie, no invite token
  const route = freshRoute();
  const res = await route.POST(signupReq());
  assert.equal(res.status, 403, "a no-ref signup must not mint an account");
  assert.equal(calls.created.length, 0, "no account is created");
  assert.equal(calls.emails.length, 0, "no email is sent on a refused signup");
  assert.equal(calls.telegramAlerts.length, 0, "no admin alert on a refused signup");
  const body = res.body as { error?: string };
  assert.ok(typeof body.error === "string" && body.error.length > 0, "a human-readable reason is returned");
});

test("F8: a valid universal referral link (sw_ref → ReferralLink) still signs up — 201", async () => {
  // beforeEach already models a resolvable universal link on the cookie.
  assert.ok(state.refCookie && state.referralLink, "a universal link is the default access token");
  const route = freshRoute();
  const res = await route.POST(signupReq());
  assert.equal(res.status, 201, "a universal referral link grants access");
  assert.equal(calls.created.length, 1, "the account exists");
});

test("F8 / Model C: a valid personalized invite (matching email) signs up — 201", async () => {
  state.referralLink = null; // this code resolves to an invite, not a universal link
  state.invite = {
    id: "inv_1",
    inviteeEmail: "newuser@x.dev", // matches the signup email
    isActive: true,
    redeemedAt: null,
    referredById: null,
  };
  const route = freshRoute();
  const res = await route.POST(signupReq());
  assert.equal(res.status, 201, "the invited email may redeem its invite");
  assert.equal(calls.created.length, 1, "the account exists");
});

test("F8 / Model C: an invite for a DIFFERENT email is refused — 403 (email-match gate intact)", async () => {
  state.referralLink = null;
  state.invite = {
    id: "inv_2",
    inviteeEmail: "someone-else@x.dev",
    isActive: true,
    redeemedAt: null,
    referredById: null,
  };
  const route = freshRoute();
  const res = await route.POST(signupReq()); // signs up as newuser@x.dev
  assert.equal(res.status, 403, "only the exact invited email may redeem");
  assert.equal(calls.created.length, 0, "no account is created");
});

test("F8 / Model C: an already-used (inactive/redeemed) invite is refused — 403", async () => {
  state.referralLink = null;
  state.invite = {
    id: "inv_3",
    inviteeEmail: "newuser@x.dev",
    isActive: false, // redeemed / revoked
    redeemedAt: "2026-10-17T00:00:00.000Z",
    referredById: null,
  };
  const route = freshRoute();
  const res = await route.POST(signupReq());
  assert.equal(res.status, 403, "a consumed invite cannot create another account");
  assert.equal(calls.created.length, 0, "no account is created");
});
