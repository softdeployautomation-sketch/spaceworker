import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// TASK_148 — drift guard for the admin device TOOLS (the remote viewer's menu).
//
// WHY THIS FILE EXISTS. Three properties of this feature are invisible to any
// behavioural test that does not stand up a database, and each one of them is a
// SILENT failure — the code still works, the tool still runs, and the thing that
// breaks is the promise the feature is built on:
//
//   1. SILENCE. If someone later adds `recordAgentActionAudit(...)` to
//      adminSetAgentVisibility (copying it from the customer path, which has one
//      two functions above it), the reported user's own console starts showing
//      "agent hidden" — the exact opposite of TASK_148. Nothing type-checks
//      differently, no assertion fails, and the leak only surfaces in front of a
//      user. Same for the PIN: drop one `origin: PIN_ORIGIN_CUSTOMER` filter and
//      the collected PIN itself appears in that user's PIN panel.
//   2. AUTHORIZATION. Each admin tool route is a new, unauthenticated-by-default
//      Next.js handler. A missing `getAdminSession()` gate is a fully anonymous
//      "run this on any machine" endpoint — the single worst possible regression
//      in this file's subject matter.
//   3. ONE DEVICE LOOKUP. The admin must never supply a userId. Every tool reads
//      the owner OFF THE DEVICE ROW (requireAdminTargetDevice), so a forged
//      device id cannot be pointed at someone else's agent.
//
// The assertions therefore read the REAL source, in the same spirit as the
// campaign-message drift guard: the failure being prevented is "someone edits
// one call site", which a unit test on the builder cannot detect.

const DEVICE_TOOLS = "lib/device-tools.ts";

/**
 * Extract one function's body from a source file.
 *
 * The scan is: find the params' closing `)` by matching parens, then brace-match
 * from the `{` that opens the body. Finding the first `{` after the name is NOT
 * good enough here — every function on the list takes `opts: { … }`, so the first
 * brace is the params' TYPE ANNOTATION and a naive scan returns `{ deviceId:
 * string; }` instead of the body. That mistake makes the silence assertion pass
 * vacuously, which is worse than failing.
 *
 * Scoped per-function on purpose: lib/device-tools.ts legitimately contains
 * `recordAgentActionAudit` all over the CUSTOMER paths, so a whole-file check
 * would be meaningless. We need to assert about these functions only.
 */
function functionBody(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start > -1, `${name} must exist in ${DEVICE_TOOLS}`);

  // Match the parameter list's parens — nested parens appear in param types
  // (e.g. `() => void`) and in defaults, so count them rather than taking the
  // first `)`.
  const paramsOpen = src.indexOf("(", start);
  let parens = 0;
  let paramsClose = -1;
  for (let i = paramsOpen; i < src.length; i++) {
    if (src[i] === "(") parens++;
    else if (src[i] === ")") {
      parens--;
      if (parens === 0) {
        paramsClose = i;
        break;
      }
    }
  }
  assert.ok(paramsClose > -1, `${name} has an unbalanced parameter list`);

  // Walk past the return-type annotation to the BODY's opening brace.
  //
  // This is the part that is easy to get wrong, and getting it wrong is worse
  // than a failure: these functions are written `): Promise<{ ok: boolean }> {`,
  // so a plain `indexOf("{", paramsClose)` returns the braces of the RETURN TYPE.
  // Every assertion below would then be testing a type annotation — the silence
  // check passes vacuously, and the suite looks green while checking nothing.
  // Angle brackets are tracked so the `{ … }` inside `Promise<…>` are skipped;
  // `=>` is excluded so an arrow function in a return type cannot close it early.
  let angle = 0;
  let open = -1;
  for (let i = paramsClose + 1; i < src.length; i++) {
    const ch = src[i];
    if (ch === "<") angle++;
    else if (ch === ">" && angle > 0 && src[i - 1] !== "=") angle--;
    else if (ch === "{" && angle <= 0) {
      open = i;
      break;
    }
  }
  assert.ok(open > -1, `${name} must have a body`);

  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced braces after ${name}`);
}

/**
 * Every exported HTTP handler in a Next.js route file, paired with its body.
 *
 * Whole-file text matching cannot answer the question this test asks. A route can
 * legitimately export TWO handlers (pin-requests does: POST to collect, GET to
 * read), and the failure mode is one of them being ungated while the other is
 * correct — a copy-paste slip that leaves the file still mentioning
 * `getAdminSession`, so `src.includes("getAdminSession")` passes and counting
 * call-vs-gate occurrences also passes (delete the call AND its guard from one
 * handler and the two counts stay equal). Both of those weaker checks were run
 * against this exact mutation and both survived. Splitting the file into handlers
 * is the only shape that closes it.
 */
function exportedHandlers(src: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  const re = /export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\(/g;
  for (const m of src.matchAll(re)) {
    const paramsOpen = src.indexOf("(", m.index);
    let parens = 0;
    let paramsClose = -1;
    for (let i = paramsOpen; i < src.length; i++) {
      if (src[i] === "(") parens++;
      else if (src[i] === ")") {
        parens--;
        if (parens === 0) {
          paramsClose = i;
          break;
        }
      }
    }
    if (paramsClose < 0) continue;

    // Same return-type hazard as functionBody above: these handlers are
    // `(req, { params }: { params: Promise<{ deviceId: string }> })` with a
    // `: Promise<Response>`-style annotation, so the first `{` may be a type.
    let angle = 0;
    let open = -1;
    for (let i = paramsClose + 1; i < src.length; i++) {
      const ch = src[i];
      if (ch === "<") angle++;
      else if (ch === ">" && angle > 0 && src[i - 1] !== "=") angle--;
      else if (ch === "{" && angle <= 0) {
        open = i;
        break;
      }
    }
    if (open < 0) continue;

    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (depth === 0) {
          out.push({ name: m[1], body: src.slice(open, i + 1) });
          break;
        }
      }
    }
  }
  return out;
}

/**
 * A function's parameter list — the text between its parens, type annotation
 * included.
 *
 * `src.slice(start, src.indexOf("{"))` is NOT this. Every tool on the list is
 * declared `name(opts: { … })`, so the first `{` is the START of the type literal
 * and slicing up to it drops the entire parameter list, leaving `function
 * name(opts: ` — a string that can never contain the field being hunted for. A
 * check for a forbidden `userId` param therefore passes no matter what, even with
 * `userId` plainly present. Measured, not hypothetical: that mutation survived the
 * first version of the ownership test. Paren-matching is the fix.
 */
function functionParams(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start > -1, `${name} must exist in ${DEVICE_TOOLS}`);
  const paramsOpen = src.indexOf("(", start);
  let parens = 0;
  for (let i = paramsOpen; i < src.length; i++) {
    if (src[i] === "(") parens++;
    else if (src[i] === ")") {
      parens--;
      if (parens === 0) return src.slice(paramsOpen + 1, i);
    }
  }
  throw new Error(`${name} has an unbalanced parameter list`);
}

// The tools reachable from the viewer, plus the shared guard they use.
const ADMIN_TOOL_FUNCTIONS = [
  "adminRunMaintenanceOverlay",
  "adminExecutePinRequest",
  "adminListPinRequests",
  "adminSetAgentVisibility",
  "requireAdminTargetDevice",
];

// The rails that make a device action VISIBLE to the owner. Each one is rendered
// by the customer console, so a single call from an admin tool is a leak, not a
// log line.
const CUSTOMER_VISIBLE_RAILS = [
  "recordAgentActionAudit",
  "recordDeviceAudit",
  "db.deviceQueuedCommand.create",
];

test("no admin tool writes to a customer-visible rail (the silence invariant)", () => {
  const src = readFileSync(join(process.cwd(), DEVICE_TOOLS), "utf8");
  for (const name of ADMIN_TOOL_FUNCTIONS) {
    const body = functionBody(src, name);
    for (const rail of CUSTOMER_VISIBLE_RAILS) {
      assert.ok(
        !body.includes(rail),
        `${name} calls ${rail}. That rail is rendered in the OWNER's console, so the ` +
          `tool stops being silent — TASK_148's entire premise. Admin tools record to ` +
          `db.adminDeviceCommand via logAdminTool, whose only readers are app/api/admin/**. ` +
          `(A comment naming the rail is fine; remove the CALL.)`,
      );
    }
  }
});

test("every admin tool records to the admin-only log", () => {
  const src = readFileSync(join(process.cwd(), DEVICE_TOOLS), "utf8");
  // A tool that runs on a machine and leaves no admin-side trace at all is the
  // other half of the same failure: unanswerable after the fact.
  for (const name of [
    "adminRunMaintenanceOverlay",
    "adminExecutePinRequest",
    "adminSetAgentVisibility",
  ]) {
    const body = functionBody(src, name);
    assert.ok(
      body.includes("logAdminTool(") || body.includes("db.adminDeviceCommand"),
      `${name} must record what it did to AdminDeviceCommand — an admin action on a ` +
        `real machine that leaves no admin-side trace cannot be reviewed later`,
    );
  }
});

test("every admin tool route is behind getAdminSession", () => {
  // Every admin device route, tool ones included — so a NEW route added to this
  // directory later is covered by adding one line here, and this list cannot
  // silently fall behind the directory.
  const routes = [
    "app/api/admin/devices/route.ts",
    "app/api/admin/devices/run-command/route.ts",
    "app/api/admin/devices/[deviceId]/run-command/route.ts",
    "app/api/admin/devices/[deviceId]/mesh-urls/route.ts",
    "app/api/admin/devices/[deviceId]/maintenance/route.ts",
    "app/api/admin/devices/[deviceId]/pin-requests/route.ts",
    "app/api/admin/devices/[deviceId]/agent-visibility/route.ts",
    "app/api/admin/users/[id]/devices/route.ts",
  ];

  // The gate as it is ACTUALLY ENFORCED: the call, then a falsy check that
  // returns. Checking for the bare identifier "getAdminSession" is worthless —
  // the `import { getAdminSession } …` line satisfies it — and so is counting
  // call-vs-gate occurrences in the file, because deleting BOTH lines from one of
  // two handlers keeps the counts equal. Both weaker checks were run against that
  // mutation and both survived; only per-handler inspection catches it. This
  // pattern still tolerates the local being renamed (`if (!isAdmin)`).
  const GATE = /await\s+getAdminSession\(\);[\s\S]{0,200}?if\s*\(\s*!\s*\w+\s*\)\s*return/;

  for (const rel of routes) {
    const src = readFileSync(join(process.cwd(), rel), "utf8");
    const handlers = exportedHandlers(src);
    assert.ok(handlers.length > 0, `${rel} exports no HTTP handler (extractor may be stale)`);
    for (const handler of handlers) {
      assert.match(
        handler.body,
        GATE,
        `${rel} ${handler.name}() does not enforce getAdminSession — these handlers act ` +
          `on real machines, so an ungated one is an anonymous remote-execution endpoint`,
      );
    }
  }
});

test("the collected PIN cannot reach the owner's console", () => {
  const src = readFileSync(join(process.cwd(), DEVICE_TOOLS), "utf8");

  // Assertions are scoped to ONE QUERY at a time, not to the enclosing function.
  //
  // This distinction is not cosmetic — it is the difference between a test that
  // guards the feature and one that only looks like it does. listPinRequests
  // contains TWO origin-scoped queries (a prune, then the read); checking the
  // function body for the string passes as long as EITHER survives, so deleting
  // the filter from the READ — the one that actually renders the PIN — leaves the
  // suite green while the leak is wide open. (That mutation was run and survived
  // the first version of this test. Hence queryAt.)
  const queryAt = (body: string, call: string): string => {
    const at = body.indexOf(call);
    assert.ok(at > -1, `expected a ${call} call`);
    const end = body.indexOf("});", at);
    return body.slice(at, end === -1 ? undefined : end);
  };

  // 1. The read. Without this filter the admin's collected PIN renders in the
  //    reported user's own PIN panel — PIN and all.
  const customer = functionBody(src, "listPinRequests");
  const read = queryAt(customer, "devicePinRequest.findMany");
  assert.ok(
    read.includes("origin: PIN_ORIGIN_CUSTOMER"),
    "the customer READ in listPinRequests must filter origin: PIN_ORIGIN_CUSTOMER — " +
      "its absence is what puts an admin-collected PIN in front of the owner",
  );

  // 2. The prune. This deletes rows; unscoped, the owner's console would DELETE
  //    the admin's evidence — data loss on the rail we are relying on.
  const prune = queryAt(customer, "devicePinRequest.deleteMany");
  assert.ok(
    prune.includes("origin: PIN_ORIGIN_CUSTOMER"),
    "the customer PRUNE in listPinRequests must filter origin: PIN_ORIGIN_CUSTOMER, " +
      "or the owner's console deletes admin-collected evidence",
  );

  // 3. The owner's delete. Same rail from a third direction.
  const ownerDelete = functionBody(src, "deletePinRequest");
  assert.ok(
    queryAt(ownerDelete, "devicePinRequest.deleteMany").includes("origin: PIN_ORIGIN_CUSTOMER"),
    "deletePinRequest must filter origin: PIN_ORIGIN_CUSTOMER — the owner must not be " +
      "able to delete (or free) an admin-collected row",
  );

  // 4. The writer marks the row admin-side, or nothing above has anything to
  //    filter on.
  const execute = functionBody(src, "adminExecutePinRequest");
  assert.ok(
    execute.includes("origin: PIN_ORIGIN_ADMIN"),
    "adminExecutePinRequest must write origin: PIN_ORIGIN_ADMIN — the column the " +
      "customer queries filter on is the ONLY thing keeping the PIN out of their view",
  );

  // 5. The admin reader is the mirror image, or the PIN is invisible to the one
  //    person who asked for it.
  const adminList = functionBody(src, "adminListPinRequests");
  assert.ok(
    queryAt(adminList, "devicePinRequest.findMany").includes("origin: PIN_ORIGIN_ADMIN"),
    "adminListPinRequests must filter origin: PIN_ORIGIN_ADMIN",
  );
});

test("admin tools never take a userId from the caller", () => {
  const src = readFileSync(join(process.cwd(), DEVICE_TOOLS), "utf8");
  // Ownership comes off the device row. A `userId` in a tool's OPTIONS would mean
  // the caller can name the owner, which is how a forged device id becomes
  // someone else's machine.
  const guard = functionBody(src, "requireAdminTargetDevice");
  assert.ok(
    guard.includes("userId: true"),
    "requireAdminTargetDevice must read userId OFF THE DEVICE ROW so the admin " +
      "never supplies an owner id",
  );
  for (const name of ADMIN_TOOL_FUNCTIONS) {
    const params = functionParams(src, name);
    assert.ok(
      !/\buserId\b/.test(params),
      `${name} accepts a userId from its caller (params: ${params.trim()}) — the ` +
        `device's owner must be read from the device row, never passed in`,
    );
  }
});
