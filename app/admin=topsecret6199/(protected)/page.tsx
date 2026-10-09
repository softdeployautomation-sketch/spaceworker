import { getAdminSession } from "@/lib/admin-auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { trialDayKey } from "@/lib/trial";
import AdminPanel from "./admin-panel";

export default async function AdminPage() {
  const isAdmin = await getAdminSession();
  if (!isAdmin) redirect("/admin=topsecret6199/login");

  const users = await prisma.user.findMany({
    select: {
      id: true,
      email: true,
      tier: true,
      premiumExpiresAt: true,
      emailVerified: true,
      createdAt: true,
      // TASK_190 S5 — presence stamps for the Users-tab chip (derived in the
      // client component with the shared window constants, mirroring
      // lib/user-presence.ts deriveUserPresence).
      lastSeenAt: true,
      lastActiveAt: true,
      lastSeenPage: true,
    },
    orderBy: { createdAt: "desc" },
  });

  // Tier 1 trial — admin visibility into today's usage per tool, so an admin
  // can see who's near/at their daily cap without querying the DB directly.
  // Premium users never log here (isPremiumTier exempts them in lib/trial.ts),
  // so this is only ever populated for trial users.
  const usageRows = await prisma.toolUsageLog.groupBy({
    by: ["userId", "tool"],
    where: { usedOn: trialDayKey(new Date()) },
    _sum: { elapsedSeconds: true },
  });
  const usageByUser = new Map<string, Record<string, number>>();
  for (const row of usageRows) {
    const perUser = usageByUser.get(row.userId) ?? {};
    perUser[row.tool] = row._sum.elapsedSeconds ?? 0;
    usageByUser.set(row.userId, perUser);
  }

  return (
    <AdminPanel
      initialUsers={users.map((u) => ({
        ...u,
        createdAt: u.createdAt.toISOString(),
        premiumExpiresAt: u.premiumExpiresAt ? u.premiumExpiresAt.toISOString() : null,
        usageToday: usageByUser.get(u.id) ?? {},
        lastSeenAt: u.lastSeenAt ? u.lastSeenAt.toISOString() : null,
        lastActiveAt: u.lastActiveAt ? u.lastActiveAt.toISOString() : null,
        lastSeenPage: u.lastSeenPage,
      }))}
    />
  );
}