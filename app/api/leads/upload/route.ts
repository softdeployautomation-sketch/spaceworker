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

    // skipDuplicates mirrors the dispatcher's convention: the Lead unique
    // constraint is (searchJobId, sourceUrl, email) and sourceUrl is always null
    // for uploads, so duplicate emails within the one file collapse to a single row.
    const { count } = await tx.lead.createMany({
      data: parsed.leads.map((l) => ({
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
      })),
      skipDuplicates: true,
    });

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
}