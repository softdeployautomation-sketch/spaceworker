import { NextResponse } from "next/server";
import { z } from "zod";

import { requireAdminSession } from "@/lib/admin-auth";
import { getAdminSettings } from "@/lib/admin-settings";
import { prisma } from "@/lib/prisma";
import {
  createPlatformAccount,
  disablePlatformAccount,
  getWorkersDevSubdomainState,
  listPlatformAccounts,
  setAccountWorkersDevSubdomain,
  updatePlatformAccount,
  verifyPlatformAccount,
} from "@/lib/hosting/platform-accounts";

// TASK_155 P6a (PLAN §19.4) — the admin's platform-account roster.
//
// A SIBLING route rather than an overload of /api/admin/hosting, so the caps
// route's subset-PATCH semantics stay exactly as they are.
//
//   GET    -> the roster in rotation order (+ the kill-switch state)
//   POST   -> add one (account id + token + label; the token is NEVER echoed)
//   PATCH  -> edit label/account/token, reorder `priority`, or disable
//   DELETE -> disable a row (soft: it is kept, never used)
//
// Every handler starts with `requireAdminSession`, the same admin gate the caps
// route uses. The token is never in a response body.

async function payload() {
  const [accounts, settings] = await Promise.all([listPlatformAccounts(), getAdminSettings()]);
  return {
    enabled: settings.hostingPlatformCfEnabled,
    accounts,
    live: {
      // How many sites would rotate onto OUR accounts right now — the number that
      // tells the owner whether the premium engine is actually in use.
      platformSites: await prisma.hostingSite.count({ where: { engine: "cloudflare", credentialId: null } }),
    },
  };
}

export async function GET(request?: Request) {
  if (!(await requireAdminSession())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // TASK_157 Phase 1 — `?subdomain=<accountRowId>` reads the workers.dev state for
  // ONE account. It is a query parameter rather than part of the roster payload
  // because answering it costs a live Cloudflare call, and the panel should not
  // pay that for every row on every render.
  //
  // The request is optional and the parse is guarded for the same reason DELETE
  // guards its own: the roster still renders for any caller that has a session but
  // no URL, instead of the whole panel breaking on a malformed request.
  let subdomainFor: string | null = null;
  try {
    subdomainFor = request ? new URL(request.url).searchParams.get("subdomain") : null;
  } catch {
    subdomainFor = null;
  }
  if (subdomainFor) {
    const state = await getWorkersDevSubdomainState(subdomainFor);
    if (!state.ok) {
      return NextResponse.json({ error: state.message, code: state.code }, { status: state.status });
    }
    // The WHOLE state, not just `live`. `configured` is what we last stamped and
    // `live` is what Cloudflare answers with today, so an out-of-band rename in
    // the dashboard shows up here instead of the panel quietly asserting a name
    // that no longer exists. The panel decides what to display.
    return NextResponse.json({ workersDevSubdomain: state.value });
  }
  return NextResponse.json(await payload());
}

const postSchema = z.object({
  accountId: z.string().min(1).max(200),
  label: z.string().min(1).max(120),
  token: z.string().min(1).max(500),
  /**
   * TASK_155 P6c — the optional Workers/DNS token for LINK redirects. Optional so
   * an admin can add an account exactly as before; a row without one is Pages
   * only and links keep the local /r/<token> fallback.
   */
  workerToken: z.string().min(1).max(500).optional(),
  priority: z.number().int().min(1).max(10_000).optional(),
});

export async function POST(request: Request) {
  if (!(await requireAdminSession())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let parsed;
  try {
    parsed = postSchema.parse(await request.json());
  } catch (e) {
    const msg = e instanceof z.ZodError ? e.errors[0]?.message : "Invalid request body";
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  const result = await createPlatformAccount(parsed);
  if (!result.ok) {
    return NextResponse.json({ error: result.message, code: result.code }, { status: result.status });
  }
  // The button says "Add and verify", so it VERIFIES — an admin who pastes a
  // token with the wrong scope must see a red row now, not at 3am when a deploy
  // rotates onto it. A failed verify still returns 201: the row is saved (it is
  // kept, disabled from rotation by its red state) and the payload carries
  // `verifyError`, which is what the panel renders.
  await verifyPlatformAccount(result.value.id);
  return NextResponse.json(await payload(), { status: 201 });
}

const patchSchema = z.object({
  /** The premium-engine kill switch — one card in the panel, toggled not edited. */
  switch: z.boolean().optional(),
  id: z.string().min(1).max(200).optional(),
  accountId: z.string().min(1).max(200).optional(),
  label: z.string().min(1).max(120).optional(),
  token: z.string().min(1).max(500).optional(),
  /** TASK_155 P6c — send to REPLACE the stored Workers/DNS token. */
  workerToken: z.string().min(1).max(500).optional(),
  priority: z.number().int().min(1).max(10_000).optional(),
  status: z.enum(["active", "disabled"]).optional(),
  /** Verify right now and stamp the row, the way the BYO card does. */
  verify: z.boolean().optional(),
  /**
   * TASK_157 Phase 1 — set the account's workers.dev subdomain. One DNS label;
   * the service validates it again and checks availability with Cloudflare before
   * writing, so a taken name is a clean 409 rather than a half-configured account.
   */
  workersDevSubdomain: z.string().min(1).max(63).optional(),
});

export async function PATCH(request: Request) {
  if (!(await requireAdminSession())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let parsed;
  try {
    parsed = patchSchema.parse(await request.json());
  } catch (e) {
    const msg = e instanceof z.ZodError ? e.errors[0]?.message : "Invalid request body";
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  // The kill switch rides on the same route: the panel has one card for it, and
  // this keeps the toggle and the roster impossible to desynchronise.
  if (parsed.switch !== undefined) {
    await prisma.adminSetting.upsert({
      where: { id: "singleton" },
      update: { hostingPlatformCfEnabled: parsed.switch },
      create: { hostingPlatformCfEnabled: parsed.switch },
    });
    return NextResponse.json(await payload());
  }

  const { id, verify, workersDevSubdomain, ...fields } = parsed;

  if (!id) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }

  // TASK_157 Phase 1 — the workers.dev subdomain is an ACCOUNT-LEVEL Cloudflare
  // setting, not a plain column: it needs a live availability check before the
  // write, and a rename re-points EVERY Worker in the account at once. So it is
  // its own verb here rather than a field in `fields`, which stays a pure DB
  // subset patch with no network call in it.
  if (workersDevSubdomain !== undefined) {
    const result = await setAccountWorkersDevSubdomain(id, workersDevSubdomain);
    if (!result.ok) {
      return NextResponse.json({ error: result.message, code: result.code }, { status: result.status });
    }
    // Return the fresh LIVE state alongside the roster, so the panel renders what
    // Cloudflare confirms rather than what we hoped we set.
    const state = await getWorkersDevSubdomainState(id);
    return NextResponse.json({
      ...(await payload()),
      workersDevSubdomain: state.ok ? state.value : null,
    });
  }

  // Edit first, then verify — so "save a new token AND check it" is one action.
  if (Object.keys(fields).length > 0) {
    const updated = await updatePlatformAccount({ id, ...fields });
    if (!updated.ok) {
      return NextResponse.json({ error: updated.message, code: updated.code }, { status: updated.status });
    }
  }
  if (verify) {
    const verified = await verifyPlatformAccount(id);
    if (!verified.ok) {
      return NextResponse.json({ error: verified.message, code: verified.code }, { status: verified.status });
    }
  } else if (fields.status === "active") {
    // Re-enabling a row the admin previously disabled (or that went red) must not
    // hand rotation an unconfirmed token: verify immediately so the row either
    // turns green or goes straight back to red with a reason the admin can read.
    await verifyPlatformAccount(id);
  } else if (Object.keys(fields).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  return NextResponse.json(await payload());
}

export async function DELETE(request: Request) {
  if (!(await requireAdminSession())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Accept BOTH id shapes: the panel posts a JSON body ({ id }), a script or a
  // bookmark may use ?id=. Reading only the query string meant the panel's
  // "Remove" silently 400'd on every click — the roster looked broken when it was
  // just a contract mismatch. (Verified in tests/hosting-platform-accounts.test.ts.)
  let id = "";
  try {
    const body = (await request.json().catch(() => null)) as { id?: unknown } | null;
    if (body && typeof body.id === "string") id = body.id.trim();
  } catch {
    // no body — fall through to the query string
  }
  if (!id) {
    try {
      id = new URL(request.url).searchParams.get("id")?.trim() ?? "";
    } catch {
      id = "";
    }
  }
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  const result = await disablePlatformAccount(id);
  if (!result.ok) {
    return NextResponse.json({ error: result.message, code: result.code }, { status: result.status });
  }
  return NextResponse.json(await payload());
}