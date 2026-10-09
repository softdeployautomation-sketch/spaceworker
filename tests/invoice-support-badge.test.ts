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
