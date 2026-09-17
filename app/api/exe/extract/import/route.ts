import { NextResponse } from "next/server";
import { isLocalExeRuntime } from "@/lib/exe-runtime";
import { parseLeadFile } from "@/lib/lead-file-parser";

// Task 27 EXE feature-parity — client-driven lead import, the EXE sibling of the
// web's POST /api/leads/upload. The web route parses the upload server-side and
// persists a new "done" SearchJob; the EXE has no Postgres, so this route parses the
// uploaded file with the SAME permissive parser (lib/lead-file-parser.ts, already
// bundled in the EXE runtime) and returns the parsed leads as JSON. The client drops
// them into a new in-memory RunRecord and the user runs "Validate all" against them
// (POST /api/exe/extract/validate) instead of needing a real extraction pass.
//
// Parsing happens here, not in the browser, because lead-file-parser.ts takes a Node
// Buffer (it bytes-decodes and hands raw bytes to SheetJS for .xlsx) — same reason
// the web routes this through a server.

const MAX_IMPORT_BYTES = 20 * 1024 * 1024; // mirrors the web upload route's 20MB cap

export async function POST(req: Request) {
  if (!isLocalExeRuntime()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid upload" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }
  if (file.size > MAX_IMPORT_BYTES) {
    return NextResponse.json({ error: "File is larger than the 20MB limit." }, { status: 400 });
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const parsed = parseLeadFile(file.name, buf);

  return NextResponse.json({
    fileName: file.name,
    format: parsed.format,
    messages: parsed.messages,
    leads: parsed.leads,
  });
}