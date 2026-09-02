import { redirect } from "next/navigation";

import { AdminShell } from "@/components/admin/admin-shell";
import { getAdminSession } from "@/lib/admin-auth";

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
  if (!session) redirect("/admin/login");
  return <AdminShell>{children}</AdminShell>;
}