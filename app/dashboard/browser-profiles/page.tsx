import { getSession } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import BrowserProfilesPanel from "./browser-profiles-panel";

export default async function BrowserProfilesPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const [user, profiles] = await Promise.all([
    prisma.user.findUnique({ where: { id: session.userId }, select: { tier: true } }),
    prisma.browserProfile.findMany({
      where: { userId: session.userId },
      select: { id: true, name: true, status: true, lastUsedAt: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  if (!user) redirect("/login");

  return (
    <BrowserProfilesPanel
      tier={user.tier}
      initialProfiles={profiles.map((p) => ({
        ...p,
        status: p.status as "idle" | "in_use",
        lastUsedAt: p.lastUsedAt?.toISOString() ?? null,
        createdAt: p.createdAt.toISOString(),
      }))}
    />
  );
}