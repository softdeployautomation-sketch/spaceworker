import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { parseLeadFile } from "@/lib/lead-file-parser";

// Task 26, Piece 3 — bulk lead upload. POST /api/leads/upload (multipart/form-data,
// one file in the "file" field). Parses a .txt/.csv/.tsv/.json/.xls/.xlsx file into
// SearchJob + Lead rows via lib/lead-file-parser.ts (permissive import, validation is
// a separate later step).
//
// An upload is modelled as a SearchJob so it shows up in the SAME job list and
// reuses the SAME leads-table UI (validate / merge / export) with zero extra work:
//   template: "upload", status: "done" (nothing to run — immediately complete),
//   lane: "light" (unused placeholder), workerJobId: null (no worker job ever claims it),
//   query: "Uploaded: <filename>", params: { template: "upload", fileName, originalRowCount }.

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20MB

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data with a file field." }, { status: 400 });
  }

  const fileEntry = form.get("file");
  if (!fileEntry || typeof fileEntry === "string") {
    return NextResponse.json({ error: "No file uploaded." }, { status: 400 });
  }

  const file = fileEntry as File;
  const fileName = file.name || String(form.get("name") ?? "upload");
  if (file.size === 0) {
    return NextResponse.json({ error: "The uploaded file is empty." }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: "File is larger than the 20MB limit." }, { status: 400 });
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  let parsed;
  try {
    parsed = parseLeadFile(fileName, bytes);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? `Failed to parse file: ${e.message}` : "Failed to parse file." },
      { status: 400 },
    );
  }

  if (parsed.leads.length === 0) {
    return NextResponse.json(
      { error: parsed.messages[0] ?? "No valid leads found in that file." },
      { status: 400 },
    );
  }

  const now = new Date();
  // Bug fix (2026-09-12): this whole block had no try/catch, so any real-world
  // Prisma error (duplicate email within the SAME file — see note below — a
  // transient connection blip, etc.) threw all the way out unhandled, and Next
  // returned a bare 500 with no `.error` field. The frontend's generic "Upload
  // failed." fallback (only shown when a response has no parseable `.error`)
  // is exactly what that produces — reported live as an unexplained upload
  // failure. Wrapping this and returning the real message fixes both the
  // silent-failure UX and gives a concrete error to act on if it recurs.
  try {
    const job = await prisma.$transaction(async (tx) => {
      const searchJob = await tx.searchJob.create({
        data: {
          userId: session.userId,
          query: `Uploaded: ${fileName}`,
          template: "upload",
          params: {
            template: "upload",
            fileName,
            originalRowCount: parsed.leads.length,
          } as Prisma.InputJsonValue,
          status: "done",
          lane: "light",
          workerJobId: null,
        },
        select: { id: true },
      });

      // NOTE: contrary to this route's original comment, `skipDuplicates` does
      // NOT collapse same-email rows here — the unique constraint is
      // (searchJobId, sourceUrl, email), and every uploaded row has
      // sourceUrl: null; standard SQL treats each NULL as distinct from every
      // other NULL for uniqueness purposes, so two rows with the same email
      // and both a null sourceUrl do NOT violate the constraint and are NOT
      // deduped by skipDuplicates. Dedup explicitly instead.
      const seen = new Set<string>();
      const rows = [];
      for (const l of parsed.leads) {
        const key = l.email.trim().toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({
          userId: session.userId,
          searchJobId: searchJob.id,
          email: l.email,
          businessName: l.businessName ?? null,
          contactName: l.contactName ?? null,
          phone: l.phone ?? null,
          website: l.website ?? null,
          sourceUrl: null,
          snippet: null,
          validationStatus: "unchecked",
          createdAt: now,
        });
      }

      const { count } = await tx.lead.createMany({ data: rows, skipDuplicates: true });

      return { searchJob, count };
    });

    return NextResponse.json(
      {
        jobId: job.searchJob.id,
        imported: job.count,
        requested: parsed.leads.length,
        format: parsed.format,
        messages: parsed.messages,
      },
      { status: 201 },
    );
  } catch (e) {
    console.error("[leads/upload] failed to save uploaded leads:", e);
    return NextResponse.json(
      { error: e instanceof Error ? `Couldn't save the uploaded leads: ${e.message}` : "Couldn't save the uploaded leads." },
      { status: 500 },
    );
  }
}