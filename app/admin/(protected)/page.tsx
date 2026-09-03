import { getAdminSession } from "@/lib/admin-auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import AdminPanel from "./admin-panel";

export default async function AdminPage() {
  const isAdmin = await getAdminSession();
  if (!isAdmin) redirect("/admin/login");

  const users = await prisma.user.findMany({
    select: { id: true, email: true, tier: true, emailVerified: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });

  return (
    <AdminPanel
      initialUsers={users.map((u) => ({ ...u, createdAt: u.createdAt.toISOString() }))}
    />
  );
}