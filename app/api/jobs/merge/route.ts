import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";

// Merge SESSIONS (SearchJobs), not individual leads within one session — the
// original ask here (superseding the earlier per-lead merge feature on the
// Extract page, which combined near-duplicate rows inside a single job) was
// always to combine 2+ separate search runs — possibly from different
// queries — into one consolidated session. A user selects 2+ jobs from the
// job list; this creates ONE new "merged" SearchJob holding the union of
// their leads (deduped by email, preferring an already-validated row over an
// unchecked/invalid duplicate), then deletes the source jobs — all in one
// transaction so the operation is all-or-nothing.
//
// POST /api/jobs/merge
// Body: { jobIds: string[] (>=2) }

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { jobIds?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const jobIds = Array.from(
    new Set(
      (Array.isArray(body?.jobIds) ? body.jobIds : [])
        .filter((x): x is string => typeof x === "string")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
  );
  if (jobIds.length < 2) {
    return NextResponse.json({ error: "Select at least two sessions to merge." }, { status: 400 });
  }

  // Load every source job at once, then verify ownership — any id that doesn't
  // resolve (gone, or belongs to another user) is a 404, not a 403, matching
  // this app's "don't leak existence" convention everywhere else.
  const sourceJobs = await prisma.searchJob.findMany({
    where: { id: { in: jobIds } },
    select: { id: true, query: true, status: true },
  });
  if (sourceJobs.length !== jobIds.length) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const owned = await prisma.searchJob.count({ where: { id: { in: jobIds }, userId: session.userId } });
  if (owned !== jobIds.length) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  // A job still queued/running has leads landing on it in real time — merging it
  // away mid-run would race the dispatcher writing to a SearchJob this request
  // is about to delete. Require every selected session to already be finished.
  const active = sourceJobs.filter((j) => j.status === "queued" || j.status === "running");
  if (active.length > 0) {
    return NextResponse.json(
      { error: "One or more selected sessions are still running — stop or wait for them to finish first." },
      { status: 400 },
    );
  }

  const sourceLeads = await prisma.lead.findMany({
    where: { searchJobId: { in: jobIds } },
    select: {
      email: true, phone: true, contactName: true, businessName: true,
      website: true, sourceUrl: true, snippet: true,
      validationStatus: true, validationError: true, validatedAt: true,
    },
  });

  // Dedupe by email (case-insensitive) across ALL selected sessions — a lead
  // with no email has nothing to key on, so every no-email row is kept as-is.
  // When the same email appears in more than one session, keep whichever copy
  // is furthest along in validation (valid > unchecked > invalid) rather than
  // an arbitrary "first seen" pick, so merging doesn't discard a session's
  // already-done validation work in favor of an unchecked duplicate.
  const rank = (status: string | null) => (status === "valid" ? 2 : status === "invalid" ? 0 : 1);
  const byEmail = new Map<string, (typeof sourceLeads)[number]>();
  const noEmail: typeof sourceLeads = [];
  for (const lead of sourceLeads) {
    const email = lead.email?.trim();
    if (!email) {
      noEmail.push(lead);
      continue;
    }
    const key = email.toLowerCase();
    const existing = byEmail.get(key);
    if (!existing || rank(lead.validationStatus) > rank(existing.validationStatus)) {
      byEmail.set(key, lead);
    }
  }
  const dedupedLeads = [...byEmail.values(), ...noEmail];

  // Short, readable label built from each source session's own first query
  // segment (the same short form the Extract page's summarizeQuery derives
  // from params.findTerms/locationTerms client-side) — capped so a merge of
  // many sessions doesn't produce an unreadable name; the full source list is
  // kept in params for reference.
  const labels = sourceJobs.map((j) => j.query.split(" | ")[0]).filter((s) => s.trim().length > 0);
  const shown = labels.slice(0, 3).join(" + ");
  const extra = labels.length > 3 ? ` + ${labels.length - 3} more` : "";
  const mergedQuery = `Merged: ${shown}${extra}`;

  const now = new Date();
  const merged = await prisma.$transaction(async (tx) => {
    const newJob = await tx.searchJob.create({
      data: {
        userId: session.userId,
        query: mergedQuery,
        template: "merged",
        params: {
          template: "merged",
          sourceJobIds: jobIds,
          sourceQueries: sourceJobs.map((j) => j.query),
        } as Prisma.InputJsonValue,
        status: "done",
        lane: "light",
        workerJobId: null,
      },
      select: { id: true },
    });

    if (dedupedLeads.length > 0) {
      await tx.lead.createMany({
        data: dedupedLeads.map((l) => ({
          userId: session.userId,
          searchJobId: newJob.id,
          email: l.email,
          phone: l.phone,
          contactName: l.contactName,
          businessName: l.businessName,
          website: l.website,
          sourceUrl: l.sourceUrl,
          snippet: l.snippet,
          validationStatus: l.validationStatus,
          validationError: l.validationError,
          validatedAt: l.validatedAt,
          createdAt: now,
        })),
        skipDuplicates: true,
      });
    }

    // Delete the source sessions LAST, children first (Lead, then the optional
    // JobQueueEntry, then the SearchJob itself) — same FK order the retention
    // sweep already uses for exactly this reason (Lead.searchJob/
    // JobQueueEntry.searchJob are real relations with no cascade configured).
    await tx.lead.deleteMany({ where: { searchJobId: { in: jobIds } } });
    await tx.jobQueueEntry.deleteMany({ where: { searchJobId: { in: jobIds } } });
    await tx.searchJob.deleteMany({ where: { id: { in: jobIds } } });

    return newJob;
  });

  return NextResponse.json({ jobId: merged.id, leadCount: dedupedLeads.length, mergedSessions: jobIds.length });
}
