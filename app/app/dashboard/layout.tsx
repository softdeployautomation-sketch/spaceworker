import { getSession } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import Link from "next/link";
import LogoutButton from "./logout-button";

const NAV = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/mailboxes", label: "Mailboxes" },
  { href: "/dashboard/campaigns", label: "Campaigns" },
  { href: "/dashboard/browser-profiles", label: "Profiles" },
  { href: "/dashboard/billing", label: "Billing" },
];

export default async function DashboardLayout(props: LayoutProps<"/dashboard">) {
  const session = await getSession();
  if (!session) redirect("/login");

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { email: true, emailVerified: true },
  });
  if (!user) redirect("/login");
  if (!user.emailVerified) redirect("/verify");

  return (
    <div className="flex h-screen">
      <aside className="flex w-60 shrink-0 flex-col border-r border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex h-10 items-center">
          <span className="text-lg font-semibold tracking-tight">SpaceWorker</span>
        </div>
        <nav className="mt-6 flex flex-col gap-1">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-lg px-3 py-2 text-sm text-zinc-600 transition-colors hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="mt-auto rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800/60">
          <p className="truncate text-sm text-zinc-600 dark:text-zinc-400">{user.email}</p>
          <div className="mt-2">
            <LogoutButton />
          </div>
        </div>
      </aside>
      <main className="flex-1 overflow-auto p-6">{props.children}</main>
    </div>
  );
}