import Link from "next/link";

export default function DashboardPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Welcome to SpaceWorker</h1>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        Connect mailboxes and launch outreach campaigns from your own domain.
      </p>

      <div className="mt-8 grid max-w-2xl gap-4 sm:grid-cols-2">
        <Link
          href="/dashboard/mailboxes"
          className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm transition-colors hover:border-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-600"
        >
          <h2 className="text-lg font-semibold">Mailboxes</h2>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Connect your own SMTP accounts. Credentials are encrypted, connections are tested before first use.
          </p>
        </Link>

        <Link
          href="/dashboard/campaigns"
          className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm transition-colors hover:border-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-600"
        >
          <h2 className="text-lg font-semibold">Campaigns</h2>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Draft campaigns, queue recipients, and send through your mailboxes under a safe daily cap.
          </p>
        </Link>
      </div>
    </div>
  );
}