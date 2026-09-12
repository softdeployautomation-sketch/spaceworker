import { redirect } from "next/navigation";

// Task 26, Piece 6 — the Mailboxes management UI moved into the Campaigns page
// as its own tab (`/dashboard/campaigns?tab=mailboxes`), so this legacy route
// just points there. The dashboard Shell/layout already gates this route behind
// auth + email verification before this runs; `redirect()` throws, so the page
// never renders and the browser address bar shows the real destination.
export default function MailboxesPage() {
  redirect("/dashboard/campaigns?tab=mailboxes");
}
