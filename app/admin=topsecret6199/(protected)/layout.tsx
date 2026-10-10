import { redirect } from "next/navigation";

import { AdminShell } from "@/components/admin/admin-shell";
import { getAdminSession } from "@/lib/admin-auth";
import { ADMIN_PATH } from "@/lib/admin-path";

/**
 * Gates the admin PAGES. NOTE: this does NOT cover the sibling app/api/admin/**
 * route tree — every admin API route (except login) must call
 * requireAdminSession() itself.
 */
export default async function AdminProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getAdminSession();
  if (!session) redirect("/admin=topsecret6199/login");
  // adminPath flows DOWN to the client shell as a prop (TASK_195 S4) so the
  // secret fragment never compiles into a world-readable client chunk.
  return <AdminShell adminPath={ADMIN_PATH}>{children}</AdminShell>;
}