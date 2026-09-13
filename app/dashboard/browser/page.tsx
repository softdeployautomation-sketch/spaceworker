import Link from "next/link";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { listExitNodes } from "@/lib/exit-nodes";
import { connectUrlFor } from "@/lib/browser-session-serialize";
import BrowserSessionPanel from "@/components/browser-session-panel";
import BrowserProfilesPanel from "@/app/dashboard/browser-profiles/browser-profiles-panel";

const TABS = [
  { value: "session", label: "Private Browser" },
  { value: "profiles", label: "Browser Profiles" },
] as const;

export default async function BrowserPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  const { tab: rawTab } = await searchParams;
  const tab = rawTab === "profiles" ? "profiles" : "session";

  const [user, profiles, sessions] = await Promise.all([
    prisma.user.findUnique({ where: { id: session.userId }, select: { tier: true } }),
    prisma.browserProfile.findMany({
      where: { userId: session.userId },
      select: {
        id: true,
        name: true,
        status: true,
        byoProxyHost: true,
        byoProxyPort: true,
        byoProxyScheme: true,
        byoProxyUsername: true,
        lastUsedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.browserSession.findMany({
      where: { userId: session.userId, hiddenAt: null },
      select: {
        id: true,
        status: true,
        proxyMode: true,
        exitNodeId: true,
        byoProxyUsername: true,
        containerId: true,
        nekoPassword: true,
        startedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  if (!user) redirect("/login");

  return (
    <div>
      {/* Browser Profiles folded in here as a sub-tab (was its own top-level nav
          item) — both surfaces are about the same underlying browser-profile
          data, and the profile picker in the session panel already needs the
          list this tab manages, so keeping them on one page removes a nav
          entry without losing anything. */}
      <div className="mb-4 flex gap-1 border-b border-zinc-200 dark:border-zinc-800">
        {TABS.map((t) => (
          <Link
            key={t.value}
            href={t.value === "session" ? "/dashboard/browser" : `/dashboard/browser?tab=${t.value}`}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              tab === t.value
                ? "border-brand-600 text-brand-700 dark:border-brand-400 dark:text-brand-300"
                : "border-transparent text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
            }`}
          >
            {t.label}
          </Link>
        ))}
      </div>

      {tab === "profiles" ? (
        <BrowserProfilesPanel
          tier={user.tier}
          initialProfiles={profiles.map((p) => ({
            id: p.id,
            name: p.name,
            status: p.status as "idle" | "in_use",
            lastUsedAt: p.lastUsedAt?.toISOString() ?? null,
            createdAt: p.createdAt.toISOString(),
          }))}
        />
      ) : (
        <BrowserSessionPanel
          tier={user.tier}
          exitNodes={listExitNodes().map((n) => ({
            id: n.id,
            city: n.city,
            country: n.country,
            flag: n.flag,
          }))}
          initialProfiles={profiles.map((p) => ({
            id: p.id,
            name: p.name,
            status: p.status as "idle" | "in_use",
            byoHost: p.byoProxyHost,
            byoPort: p.byoProxyPort,
            byoScheme: p.byoProxyScheme,
            byoUser: p.byoProxyUsername,
          }))}
          initialSessions={sessions.map((s) => ({
            id: s.id,
            status: s.status,
            proxyMode: s.proxyMode,
            exitNodeId: s.exitNodeId,
            byoUser: s.byoProxyUsername,
            startedAt: s.startedAt?.toISOString() ?? null,
            createdAt: s.createdAt.toISOString(),
            connectUrl: s.status === "running" ? connectUrlFor(s.id, s.nekoPassword) : null,
          }))}
        />
      )}
    </div>
  );
}
