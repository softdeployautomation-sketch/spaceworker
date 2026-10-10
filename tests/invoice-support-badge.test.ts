// TASK_194 S4 — an admin-issued invoice must light the support button's badge.
//
// The badge is DERIVED: `unread` = "the thread's newest message is an admin's
// and newer than the customer's lastReadAt". The users-panel invoice composer
// wrote only a PremiumInvoice row, so the badge never moved. These pin the fix.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");

describe("TASK_194 S4 — invoice lands in the support thread", () => {
  const tickets = read("lib/support/tickets.ts");
  const route = read("app/api/admin/users/[id]/invoices/route.ts");

  it("exposes a find-or-create notice helper that binds the invoiceId", () => {
    assert.ok(
      tickets.includes("export async function postInvoiceNoticeToUser"),
      "postInvoiceNoticeToUser must exist",
    );
    // It must reuse the existing message path so the invoice binding + body
    // validation run exactly once.
    assert.ok(
      tickets.includes("return addAdminMessage(existing.id, body, adminId, invoiceId)"),
      "must post through addAdminMessage so the invoice is bound + validated",
    );
  });

  it("the invoice route actually calls it (otherwise the badge never lights)", () => {
    assert.ok(route.includes("postInvoiceNoticeToUser"), "the invoice route must post a support message");
    assert.ok(
      route.includes('from "@/lib/support/tickets"'),
      "the route must import the helper from lib/support/tickets",
    );
  });

  it("keeps the notice best-effort so a notice failure cannot fail a sent invoice", () => {
    assert.ok(route.includes(".catch(() =>"), "the notice must be fire-and-forget");
    // Wrapped in its own try too — the 201 that already created the invoice wins.
    assert.ok(route.includes("never let a notice failure fail the invoice"), "must be defensively wrapped");
  });
});

describe("TASK_197 S1 — one invoice, one card (no double-notice)", () => {
  const tickets = read("lib/support/tickets.ts");
  const route = read("app/api/admin/users/[id]/invoices/route.ts");
  const composer = read("components/admin/support-queue-panel.tsx");

  it("route accepts a threadNotice key (strict-body allowlist updated)", () => {
    assert.ok(
      route.includes('"methods", "threadNotice"'),
      "ALLOWED_KEYS must include threadNotice — otherwise the composer's opt-out 400s",
    );
  });

  it("threadNotice defaults true and must be a boolean", () => {
    assert.ok(
      route.includes("body.threadNotice === undefined ? true : body.threadNotice"),
      "absent ⇒ true (existing callers unchanged)",
    );
    assert.ok(
      route.includes('"threadNotice must be a boolean"'),
      "a string \"false\" must never silently pass as falsy-true",
    );
  });

  it("the server notice is gated behind the flag", () => {
    // The postInvoiceNoticeToUser block must live INSIDE `if (threadNotice)`.
    const gated = route.indexOf("if (threadNotice) {");
    const called = route.indexOf("void postInvoiceNoticeToUser(");
    assert.ok(gated > 0, "notice block must be gated");
    assert.ok(called > gated, "postInvoiceNoticeToUser must be called after (inside) the gate");
  });

  it("the support composer opts OUT (it posts its own invoice-bound note)", () => {
    assert.ok(
      composer.includes("body.threadNotice = false"),
      "support-queue-panel must send threadNotice:false or its own note + the route notice double-post",
    );
  });

  it("postInvoiceNoticeToUser is idempotent on invoiceId (belt, not just gate)", () => {
    // The gate stops the KNOWN double path; the belt stops any future caller or
    // a retry from binding the same invoice twice.
    const beltAt = tickets.indexOf("if (bound) return { ok: true, value: toMessageView(bound) }");
    assert.ok(beltAt > 0, "must return the existing binding instead of posting again");
    const queryAt = tickets.indexOf("prisma.supportMessage.findFirst({", tickets.indexOf("export async function postInvoiceNoticeToUser"));
    assert.ok(queryAt > 0 && queryAt < beltAt, "must look up by invoiceId before posting");
    assert.ok(
      tickets.slice(queryAt, beltAt).includes("where: { invoiceId }"),
      "the idempotency lookup must key on invoiceId",
    );
  });
});
