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

const state = { adminEmail: "boss@example.com", emailThrows: false };
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
