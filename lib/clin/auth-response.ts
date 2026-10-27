import { NextResponse } from "next/server";
import type { ClinePollResult } from "./device-auth";

/**
 * TASK_246 — one HTTP mapping for both `/poll` and the legacy `/callback`.
 *
 * 200 connected · 202 still waiting (NOT a failure — the old UI treated every
 * `res.ok` as success, which is why the panel closed while still pending) ·
 * 410 expired · 403 denied · 502 Cline unreachable.
 */
export function clinePollResponse(result: ClinePollResult): NextResponse {
  switch (result.status) {
    case "connected":
      return NextResponse.json({
        ok: true,
        connected: true,
        email: result.email,
        accountId: result.accountId,
        expires: result.expires,
        message: "Cline account connected successfully",
      });
    case "pending":
      return NextResponse.json(
        {
          ok: false,
          connected: false,
          pending: true,
          error: result.message,
          message: result.message,
          retryAfterSeconds: result.retryAfterSeconds,
        },
        { status: 202 },
      );
    case "expired":
      return NextResponse.json(
        { ok: false, connected: false, expired: true, error: result.message, message: result.message },
        { status: 410 },
      );
    case "denied":
      return NextResponse.json(
        { ok: false, connected: false, denied: true, error: result.message, message: result.message },
        { status: 403 },
      );
    case "unreachable":
      return NextResponse.json(
        {
          ok: false,
          connected: false,
          retry: true,
          error: result.message,
          message: result.message,
          retryAfterSeconds: result.retryAfterSeconds,
        },
        { status: 502 },
      );
  }
}
