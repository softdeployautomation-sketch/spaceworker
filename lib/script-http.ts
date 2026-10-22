import { NextResponse } from "next/server";

import { ScriptInputError } from "./device-scripts";

/** Shared error mapping for the /api/scripts routes: validation → 400/404. */
export function scriptErrorResponse(err: unknown): NextResponse {
  if (err instanceof ScriptInputError) {
    const status = err.code.endsWith("_not_found") ? 404 : 400;
    return NextResponse.json({ error: err.code }, { status });
  }
  console.error("[scripts]", err instanceof Error ? err.message : err);
  return NextResponse.json({ error: "internal_error" }, { status: 500 });
}
