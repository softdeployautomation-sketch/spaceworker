import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";

// Reported by app/error.tsx / app/global-error.tsx — this app has NO client-side
// error boundary or crash reporting anywhere else, so an uncaught render error
// has always cascaded silently with zero server-side visibility: diagnosing one
// meant asking the user to screenshot DevTools' Console tab every time. This
// logs straight to stdout (captured by journalctl on the deployed box) so a
// crash can be found immediately after it happens, no screenshot required.
// Deliberately no auth requirement — a crash can happen on a page reached
// before login too, and this is a diagnostic sink, not a mutating endpoint.
export async function POST(req: Request) {
  let body: { message?: unknown; stack?: unknown; digest?: unknown; url?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const session = await getSession().catch(() => null);

  console.error(
    "[client-error]",
    JSON.stringify({
      message: typeof body.message === "string" ? body.message.slice(0, 2000) : null,
      stack: typeof body.stack === "string" ? body.stack.slice(0, 4000) : null,
      digest: typeof body.digest === "string" ? body.digest.slice(0, 200) : null,
      url: typeof body.url === "string" ? body.url.slice(0, 500) : null,
      userId: session?.userId ?? null,
      at: new Date().toISOString(),
    }),
  );

  return NextResponse.json({ ok: true });
}
