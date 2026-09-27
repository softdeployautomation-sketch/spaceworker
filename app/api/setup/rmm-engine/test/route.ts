import { NextResponse } from "next/server";

import { getAdminSession } from "@/lib/admin-auth";
import { isSelfHosted } from "@/lib/exe-build-target";
import { readSetupState } from "@/lib/self-hosted-setup-state";

// POST /api/setup/rmm-engine/test — body: { url, token }
//
// TASK_130 §3. Live-tests the customer's device-management connection (internal
// codename "sw-rmm-core"; customer-facing "SpaceWorker RMM Engine") using the
// SUBMITTED url/token, never env (env.vantraInternalUrl defaults to Vantra's
// hosted URL and won't be set on a self-hosted box yet).
//
// Probe: GET <url>/api/internal/sw/orgs with the token as Bearer — the same
// /api/internal/sw/* surface every existing vantraFetch call uses, and the
// lightest one that needs no device/org id. NOTE for whoever lands Phase 3/4:
// the extracted sw-rmm-core must expose this (or an equivalent cheap
// authenticated GET) for this test to pass; if it ends up as a different path,
// change PROBE_PATH below and nowhere else.
//
// Deliberately does NOT persist anything (TASK_130 §2 step 6): every
// wizard-collected value is held in the client's React state until the single
// final "Confirm and finish setup". A successful test here only tells the UI
// it may continue.
const PROBE_PATH = "/api/internal/sw/orgs";

export async function POST(req: Request) {
  if (!isSelfHosted()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const state = await readSetupState();
  if (state.completedAt && !(await getAdminSession())) {
    return NextResponse.json({ error: "Setup already completed" }, { status: 403 });
  }

  let body: { url?: unknown; token?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const rawUrl = typeof body?.url === "string" ? body.url.trim() : "";
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  if (!rawUrl) return NextResponse.json({ error: "Enter the RMM Engine URL." }, { status: 400 });
  if (!token) return NextResponse.json({ error: "Enter the RMM Engine token." }, { status: 400 });

  let base: URL;
  try {
    base = new URL(rawUrl);
  } catch {
    return NextResponse.json({ error: "That doesn't look like a valid URL." }, { status: 400 });
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    return NextResponse.json({ error: "The URL must start with http:// or https://." }, { status: 400 });
  }
  const baseUrl = base.toString().replace(/\/$/, "");
  const probeUrl = `${baseUrl}${PROBE_PATH}`;

  let res: Response;
  try {
    res = await fetch(probeUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      cache: "no-store",
      // Never let a black-holed URL hang the wizard forever.
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return NextResponse.json({
      ok: false,
      error: `Could not reach the RMM Engine at ${base.host}. Check the URL and that the service is running.`,
    });
  }

  if (res.ok) {
    return NextResponse.json({ ok: true });
  }
  if (res.status === 401 || res.status === 403) {
    return NextResponse.json({
      ok: false,
      error: `The RMM Engine rejected that token (HTTP ${res.status}). Double-check the token and try again.`,
    });
  }
  if (res.status === 404) {
    return NextResponse.json({
      ok: false,
      error: `Reached ${base.host}, but ${PROBE_PATH} returned 404 — is this URL pointing at the RMM Engine itself?`,
    });
  }
  return NextResponse.json({
    ok: false,
    error: `The RMM Engine responded with an unexpected status (HTTP ${res.status}).`,
  });
}
