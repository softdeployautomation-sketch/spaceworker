import { NextResponse } from "next/server";

import { hasEntitlement } from "@/lib/entitlements";
import { getCurrentUser } from "@/lib/session-user";
import { createHostedFile, listHostedFiles, resolveCapsForUser } from "@/lib/hosting/files";

// TASK_155 P1 — GET  /api/hosting/files   (list the caller's active files)
//                 POST /api/hosting/files   (multipart upload)
//
// The POST is a STREAMING multipart upload: the file is piped straight to the
// storage provider (never buffered whole in RAM) while bytes are metered and
// hashed in flight. Every user-caused refusal (not entitled, blocked type,
// over quota, engine not ready) comes back as a typed JSON 4xx — never a 500.
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const files = await listHostedFiles(user.id);
  const { caps } = await resolveCapsForUser(user.id);
  return NextResponse.json({ files, provider: caps.provider });
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const decision = await hasEntitlement(user.id, "hosting");
  if (!decision.allowed) {
    return NextResponse.json(
      { error: "Hosting isn’t included on your account yet.", code: "not_entitled" },
      { status: 403 }
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected a multipart form upload.", code: "bad_request" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: "No file was included.", code: "no_file" }, { status: 400 });
  }

  const filename = (form.get("filename") as string) || (file as File).name || "upload";
  const mime = file.type || "application/octet-stream";
  const acknowledgeGated = String(form.get("acknowledgeGated") ?? "") === "true";
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

  const result = await createHostedFile({
    userId: user.id,
    ip,
    filename,
    mime,
    declaredBytes: file.size,
    body: file.stream() as unknown as ReadableStream<Uint8Array>,
    acknowledgeGated,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.message, code: result.code }, { status: result.status });
  }
  return NextResponse.json({ file: result.value }, { status: 201 });
}
