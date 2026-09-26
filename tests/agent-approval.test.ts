// Task 94 — Telegram approval loop. Two things worth real evidence:
//   1. lib/agent-approval-token.ts's signed tokens: mint/parse round-trips,
//      tamper detection, expiry, and — the acceptance-critical case —
//      "unauthenticated/garbage tokens => no state change" is provable at
//      the token layer alone (a forged token never even parses).
//   2. lib/agent-approval-executor.ts, through the house require-hook stub:
//      approve/reject dispatch correctly by kind (job/campaign vs device),
//      and — the OTHER acceptance-critical case — a second tap on an
//      already-decided proposal never re-executes (the underlying atomic
//      transition, not a token ledger, is what makes this single-use).
//
// Run: npx tsx --test tests/agent-approval.test.ts

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import crypto from "node:crypto";

process.env.APP_BASE_URL = "https://spaceworker.test";
process.env.DATABASE_URL = "postgresql://t94:t94@localhost:5432/task94_placeholder";
process.env.SESSION_SECRET = "task94-test-session-secret";
process.env.RESEND_API_KEY = "task94-test-resend";
process.env.EMAIL_FROM = "t94@spaceworker.test";

// "server-only" is stubbed globally (not just for one module's own imports,
// the way the rest of this file's hook scopes it) because BOTH
// lib/agent-approval-token.ts and lib/agent-approval-executor.ts carry it,
// and the token module is require()'d directly below, before the
// module-scoped hook further down even matters for it.
{
  type Loader = { _load: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown };
  const loader = Module as unknown as Loader;
  const original = loader._load;
  loader._load = function patched(request, parent, isMain) {
    if (request === "server-only") return {};
    return original.call(this, request, parent, isMain);
  };
}

/* eslint-disable @typescript-eslint/no-require-imports */
const { mintApprovalToken, parseApprovalToken } =
  require("../lib/agent-approval-token") as typeof import("../lib/agent-approval-token");
/* eslint-enable @typescript-eslint/no-require-imports */

// --- lib/agent-approval-token.ts — pure, no stubbing needed. ---------------

test("mintApprovalToken/parseApprovalToken: round-trips pendingActionId + decision", () => {
  const token = mintApprovalToken("action-1", "approve");
  const parsed = parseApprovalToken(token);
  assert.deepEqual(parsed, { pendingActionId: "action-1", decision: "approve" });
});

test("parseApprovalToken: a tampered signature is rejected", () => {
  const token = mintApprovalToken("action-1", "approve");
  const tampered = token.slice(0, -2) + (token.slice(-2) === "AA" ? "BB" : "AA");
  assert.equal(parseApprovalToken(tampered), null);
});

test("parseApprovalToken: a token minted for a DIFFERENT action/decision never matches", () => {
  const token = mintApprovalToken("action-1", "approve");
  // Forge a token claiming a different pendingActionId, keeping the same
  // (now-invalid) signature — proves the signature is over the whole
  // payload, not just checked independently of it.
  const dot = token.lastIndexOf(".");
  const forgedPayload = Buffer.from("action-2.approve.99999999999999").toString("base64url");
  const forged = `${forgedPayload}.${token.slice(dot + 1)}`;
  assert.equal(parseApprovalToken(forged), null);
});

test("parseApprovalToken: acceptance — garbage/malformed input never parses, never throws", () => {
  assert.equal(parseApprovalToken(""), null);
  assert.equal(parseApprovalToken("not-a-token"), null);
  assert.equal(parseApprovalToken("....."), null);
  assert.equal(parseApprovalToken("a.b"), null);
});

test("parseApprovalToken: acceptance — an expired token is rejected even with a valid signature", () => {
  // Mint normally, then hand-forge an ALREADY-EXPIRED payload with a real
  // signature over it (proves expiry is enforced independently of the sig).
  const past = Date.now() - 1000;
  const payload = `action-1.approve.${past}`;
  const key = crypto.createHash("sha256").update("task94-test-session-secret:agent-approval-v1").digest();
  const sig = crypto.createHmac("sha256", key).update(payload).digest("base64url");
  const token = `${Buffer.from(payload).toString("base64url")}.${sig}`;
  assert.equal(parseApprovalToken(token), null);
});

test("mintApprovalToken: rejects/reviews get their own distinct tokens (never confusable)", () => {
  const approve = parseApprovalToken(mintApprovalToken("action-1", "approve"));
  const reject = parseApprovalToken(mintApprovalToken("action-1", "reject"));
  const review = parseApprovalToken(mintApprovalToken("action-1", "review"));
  assert.equal(approve?.decision, "approve");
  assert.equal(reject?.decision, "reject");
  assert.equal(review?.decision, "review");
});

// --- lib/agent-approval-executor.ts, through the house require-hook stub --

interface PendingRow {
  id: string;
  userId: string;
  kind: string;
  status: string;
  expiresAt: Date;
  proposal: string | null;
}

let pendingRows: Map<string, PendingRow>;
let deviceActionRows: Map<string, { pendingActionId: string; status: string }>;
let audits: { action: string; status: string; approvalChannel?: string; pendingActionId?: string }[];
let approveDeviceActionCalls: { pendingActionId: string; approvalChannel?: string }[];
let approvePendingActionCalls: { actionId: string }[];
let approveDeviceActionShouldThrow: Error | null;
let approvePendingActionShouldThrow: Error | null;

beforeEach(() => {
  pendingRows = new Map();
  deviceActionRows = new Map();
  audits = [];
  approveDeviceActionCalls = [];
  approvePendingActionCalls = [];
  approveDeviceActionShouldThrow = null;
  approvePendingActionShouldThrow = null;
});

const fakeDb = {
  agentPendingAction: {
    findUnique: async ({ where }: { where: { id: string } }) => pendingRows.get(where.id) ?? null,
    updateMany: async ({
      where,
      data,
    }: {
      where: { id: string; status?: string; userId?: string; expiresAt?: { gt: Date } };
      data: Partial<PendingRow>;
    }) => {
      const row = pendingRows.get(where.id);
      if (!row) return { count: 0 };
      if (where.status !== undefined && row.status !== where.status) return { count: 0 };
      if (where.expiresAt && row.expiresAt.getTime() <= where.expiresAt.gt.getTime()) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    },
  },
  deviceAction: {
    updateMany: async ({
      where,
      data,
    }: {
      where: { pendingActionId: string; status?: string };
      data: { status: string };
    }) => {
      const row = deviceActionRows.get(where.pendingActionId);
      if (!row) return { count: 0 };
      if (where.status !== undefined && row.status !== where.status) return { count: 0 };
      row.status = data.status;
      return { count: 1 };
    },
  },
};

type Loader = { _load: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown };
const MODULE_UNDER_TEST = "lib/agent-approval-executor.ts";

function installRequireHook(): void {
  const loader = Module as unknown as Loader;
  const original = loader._load;
  loader._load = function patched(request, parent, isMain) {
    if (request === "server-only") return {};
    const from = (parent?.filename ?? "").replace(/\\/g, "/");
    if (from.endsWith(`/${MODULE_UNDER_TEST}`)) {
      if (request === "./db") return { db: fakeDb };
      if (request === "./devices") {
        return {
          recordAgentActionAudit: async (call: (typeof audits)[number]) => {
            audits.push(call);
          },
        };
      }
      if (request === "./agent-executor") {
        class AgentActionError extends Error {
          code: string;
          status: number;
          constructor(code: string, message: string, status: number) {
            super(message);
            this.code = code;
            this.status = status;
          }
        }
        return {
          AgentActionError,
          // Mirrors the REAL approvePendingAction's own atomic guard (an
          // updateMany scoped to status:"pending", 0 rows => throw) — a
          // dumb stub that always "succeeds" would hide exactly the bug
          // this suite's re-tap test exists to catch.
          approvePendingAction: async (opts: { userId: string; actionId: string }) => {
            approvePendingActionCalls.push(opts);
            if (approvePendingActionShouldThrow) throw approvePendingActionShouldThrow;
            const row = pendingRows.get(opts.actionId);
            if (!row || row.status !== "pending" || row.expiresAt.getTime() <= Date.now()) {
              throw new AgentActionError("not_pending", "This proposal is no longer pending.", 409);
            }
            row.status = "approved";
            return { ok: true };
          },
        };
      }
      if (request === "./vantra-link") {
        return {
          // Mirrors the REAL approveDeviceAction's own atomic claim (same
          // reasoning as approvePendingAction's stub above).
          approveDeviceAction: async (opts: { pendingActionId: string; approvalChannel?: string }) => {
            approveDeviceActionCalls.push(opts);
            if (approveDeviceActionShouldThrow) throw approveDeviceActionShouldThrow;
            const row = pendingRows.get(opts.pendingActionId);
            if (!row || row.status !== "pending") throw new Error("not_pending");
            row.status = "approved";
            return { output: null };
          },
        };
      }
    }
    return original.call(this, request, parent, isMain);
  };
}

installRequireHook();

/* eslint-disable @typescript-eslint/no-require-imports */
const { executeAgentApprovalTap, AgentApprovalError } =
  require("../lib/agent-approval-executor") as typeof import("../lib/agent-approval-executor");
/* eslint-enable @typescript-eslint/no-require-imports */

function seedPending(overrides: Partial<PendingRow> = {}): PendingRow {
  const row: PendingRow = {
    id: "pending-1",
    userId: "user-1",
    kind: "job",
    status: "pending",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    proposal: "Find plumbers in Austin",
    ...overrides,
  };
  pendingRows.set(row.id, row);
  return row;
}

test("executeAgentApprovalTap: approve on a job/campaign kind calls approvePendingAction and audits (no existing audit trail there)", async () => {
  seedPending({ kind: "job" });
  const result = await executeAgentApprovalTap({
    pendingActionId: "pending-1",
    decision: "approve",
    approvalChannel: "telegram",
  });
  assert.deepEqual(result, { ok: true, decision: "approve" });
  assert.equal(approvePendingActionCalls.length, 1);
  assert.equal(approvePendingActionCalls[0].actionId, "pending-1");
  assert.equal(audits.length, 1);
  assert.equal(audits[0].approvalChannel, "telegram");
  assert.equal(audits[0].status, "approved");
});

test("executeAgentApprovalTap: approve on a device kind calls approveDeviceAction with the channel, no duplicate audit here (it audits internally)", async () => {
  seedPending({ kind: "device" });
  const result = await executeAgentApprovalTap({
    pendingActionId: "pending-1",
    decision: "approve",
    approvalChannel: "telegram",
  });
  assert.deepEqual(result, { ok: true, decision: "approve" });
  assert.equal(approveDeviceActionCalls.length, 1);
  assert.equal(approveDeviceActionCalls[0].approvalChannel, "telegram");
  assert.equal(approvePendingActionCalls.length, 0);
  // No audit written by THIS module for device kind — approveDeviceAction
  // (stubbed here) is responsible for its own, already-established audit.
  assert.equal(audits.length, 0);
});

test("executeAgentApprovalTap: acceptance — re-tapping an already-approved action never re-executes", async () => {
  // Already approved (e.g. by an earlier tap, or the web UI) — a re-tap DOES
  // reach the real approvePendingAction (there is no separate pre-check;
  // the executor's own atomic updateMany, scoped to status:"pending", is
  // what refuses it), but it must claim ZERO rows and throw, never flip
  // anything a second time.
  seedPending({ kind: "job", status: "approved" });
  await assert.rejects(
    executeAgentApprovalTap({ pendingActionId: "pending-1", decision: "approve", approvalChannel: "telegram" }),
    (err: unknown) => err instanceof AgentApprovalError && err.code === "not_pending",
  );
  assert.equal(approvePendingActionCalls.length, 1, "the real executor is still called, but claims 0 rows and throws");
  assert.equal(pendingRows.get("pending-1")?.status, "approved", "status must not change from the failed re-tap");
  assert.equal(audits.length, 0, "a refused re-tap must not be recorded as a fresh approval");
});

test("executeAgentApprovalTap: acceptance — re-tapping an already-approved DEVICE action never re-executes either", async () => {
  seedPending({ kind: "device", status: "approved" });
  await assert.rejects(
    executeAgentApprovalTap({ pendingActionId: "pending-1", decision: "approve", approvalChannel: "telegram" }),
    (err: unknown) => err instanceof AgentApprovalError && err.code === "not_pending",
  );
  assert.equal(approveDeviceActionCalls.length, 1, "the real executor still gets called once, but claims 0 rows and throws");
});

test("executeAgentApprovalTap: reject on a device kind flips both AgentPendingAction and its DeviceAction row", async () => {
  seedPending({ kind: "device" });
  deviceActionRows.set("pending-1", { pendingActionId: "pending-1", status: "requested" });
  const result = await executeAgentApprovalTap({
    pendingActionId: "pending-1",
    decision: "reject",
    approvalChannel: "telegram",
  });
  assert.deepEqual(result, { ok: true, decision: "reject" });
  assert.equal(pendingRows.get("pending-1")?.status, "rejected");
  assert.equal(deviceActionRows.get("pending-1")?.status, "rejected");
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "agent_device_reject");
});

test("executeAgentApprovalTap: reject on an expired proposal fails closed", async () => {
  seedPending({ expiresAt: new Date(Date.now() - 1000) });
  await assert.rejects(
    executeAgentApprovalTap({ pendingActionId: "pending-1", decision: "reject", approvalChannel: "telegram" }),
    (err: unknown) => err instanceof AgentApprovalError && err.code === "not_pending",
  );
});

test("executeAgentApprovalTap: an unknown pendingActionId (garbage/forged token target) fails closed with not_found, no state change", async () => {
  await assert.rejects(
    executeAgentApprovalTap({ pendingActionId: "does-not-exist", decision: "approve", approvalChannel: "telegram" }),
    (err: unknown) => err instanceof AgentApprovalError && err.code === "not_found",
  );
  assert.equal(approvePendingActionCalls.length, 0);
  assert.equal(approveDeviceActionCalls.length, 0);
});

test("executeAgentApprovalTap: a failed device approval re-throws as AgentApprovalError, not a raw executor error", async () => {
  seedPending({ kind: "device" });
  approveDeviceActionShouldThrow = new Error("vantra_not_configured");
  await assert.rejects(
    executeAgentApprovalTap({ pendingActionId: "pending-1", decision: "approve", approvalChannel: "telegram" }),
    (err: unknown) => err instanceof AgentApprovalError && err.code === "vantra_not_configured",
  );
});
