import { redirect } from "next/navigation";

// Browser Profiles folded into the Private Browser page as a sub-tab (removed
// as its own top-level nav item) — same "old URL keeps working" precedent as
// /dashboard/mailboxes -> /dashboard/campaigns?tab=mailboxes.
export default function BrowserProfilesRedirect() {
  redirect("/dashboard/browser?tab=profiles");
}
