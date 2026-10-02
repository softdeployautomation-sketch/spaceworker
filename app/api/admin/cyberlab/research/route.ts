import { NextResponse } from "next/server";

import { requireAdminSession } from "@/lib/admin-auth";
import { ensureCatalogSeed } from "@/lib/lab/catalog-seed";
import { researchState } from "@/lib/lab/research";
import { listCatalog } from "@/lib/lab/tools";

// TASK_156 C1 (PLAN_TASK_156 §12.1 + §12.8) — GET /api/admin/cyberlab/research.
//
// The read-only Research page's data source. §12.8 scopes C1 to "the Research
// admin page (read-only feeds; no attack)": this route reads the pinned ATT&CK
// release, the feed list, the refresh/stale cadence and the LabToolCatalog — and
// performs NO network pull and NO attack (the scheduled pull job is C2+ work).
//
// It DOES seed the starter catalog on first view (`ensureCatalogSeed`, idempotent:
// `slug` is unique and existing rows are never overwritten), so the page is never
// an empty shell on a fresh DB while staying safe to call repeatedly.
//
// `catalogRows` is the FULL list (every row, WITH the computed `stale` flag) so
// the page can show "refresh required" for a stale row instead of silently
// hiding it — the §12.1 contract that a tool list must not quietly rot. It rides
// under a different key from the `catalog` SUMMARY (total/visible/stale/byClass)
// that researchState() already returns; merging it under the same key would clobber
// the summary.

export async function GET() {
  const isAdmin = await requireAdminSession();
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Best-effort seed — a warm catalog returns 0 and changes nothing.
  await ensureCatalogSeed();

  const [state, catalogRows] = await Promise.all([researchState(), listCatalog()]);

  return NextResponse.json({ ...state, catalogRows });
}
