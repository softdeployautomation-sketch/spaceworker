import { redirect } from "next/navigation";

// TASK_100 MK5 (owner, 2026-09-22) — Advanced Search already exists as a real
// mode inside the Extract page (Lead Search / HR / Plain / Advanced tabs,
// same background-job engine as Lead Search since 2026-09-20). This
// standalone page — the older one-shot interactive checklist — is redundant;
// kept only as a redirect so existing links/bookmarks don't break.
export default function AdvancedSearchRedirect() {
  redirect("/dashboard/extract?template=advanced-search");
}
