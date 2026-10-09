import { redirect } from "next/navigation";

import { getAdminSession } from "@/lib/admin-auth";

import { SecretDevicesHost } from "./host";

// TASK_188 S2 — the PRIVATE devices page. This route deliberately lives OUTSIDE
// the (protected) route group, so it does not inherit that group's layout guard:
// it carries its own copy of the check (same `getAdminSession()` → redirect to
// the admin login). That is the UX-level lock; the real one is proxy.ts, which
// gates the whole admin root behind the admin session cookie before any page
// runs, and every /api/admin/** route which asserts the session ITSELF.
//
// Secrecy is a feature here: nothing links to this URL (no nav, no dashboard,
// no admin panel entry, no footer, no sitemap/robots). Reachability is by
// knowing the path, nothing else — hence the unlisted segment.
export const dynamic = "force-dynamic";

export default async function SecretAdminDevicesPage() {
  const session = await getAdminSession();
  if (!session) redirect("/admin=topsecret6199/login");

  // Owner state lives HERE (the page), not in the admin panel: the devices
  // component is shared code and must not assume where it is mounted.
  return (
    <div className="min-h-screen bg-zinc-100 dark:bg-zinc-950">
      <main className="mx-auto max-w-6xl p-6">
        <SecretDevicesHost />
      </main>
    </div>
  );
}
