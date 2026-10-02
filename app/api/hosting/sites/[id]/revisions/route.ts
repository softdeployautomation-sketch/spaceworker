import { NextResponse } from "next/server";

import { hasEntitlement } from "@/lib/entitlements";
import { getCurrentUser } from "@/lib/session-user";
import { resolveCapsForUser } from "@/lib/hosting/files";
import { createRevisionFromArchive, writeIncomingArchive } from "@/lib/hosting/sites";

// TASK_155 P3 — POST /api/hosting/sites/<id>/revisions.
//
// The §16.1 upload: a `.zip` (or a folder zipped by the browser) is STREAMED to a
// private incoming file, then extract+analyse+PREVIEW run behind the single-slot
// heavy-job lock. Every user-caused refusal (not entitled, oversize, bad archive,
// busy, over quota) is a typed JSON 4xx — never a 500. A rejected archive leaves
// zero partial state (createRevisionFromArchive wipes its own staging).
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const decision = await hasEntitlement(user.id, "hosting");
  if (!decision.allowed) {
    return NextResponse.json(
      { error: "Hosting isn’t included on your account yet.", code: "not_entitled" },
      { status: 403 }
    );
  }

  const { id } = await params; // MUST await — async in Next.js 16

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected a multipart form upload.", code: "bad_request" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: "No archive was included.", code: "no_file" }, { status: 400 });
  }

  const { caps } = await resolveCapsForUser(user.id);
  const maxBytes = caps.maxZipMb * 1024 * 1024;

  const incoming = await writeIncomingArchive(
    user.id,
    file.stream() as unknown as ReadableStream<Uint8Array>,
    { maxBytes, declaredBytes: file.size }
  );
  if (!incoming.ok) {
    return NextResponse.json({ error: incoming.message, code: incoming.code }, { status: incoming.status });
  }

  const result = await createRevisionFromArchive({
    userId: user.id,
    siteId: id,
    archivePath: incoming.value.archivePath,
    archiveName: (form.get("filename") as string) || (file as File).name || "site.zip",
    archiveBytes: incoming.value.bytes,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.message, code: result.code }, { status: result.status });
  }
  return NextResponse.json({ revision: result.value }, { status: 201 });
}
