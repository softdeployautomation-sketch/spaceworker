import type { Metadata } from "next";

export const metadata: Metadata = { title: "Dashboard" };

export const dynamic = "force-dynamic";

export default function DashboardPage() {
  return (
    <div>
      <h1 className="text-2xl font-bold text-fg">Dashboard</h1>
      <p className="mt-2 text-sm text-fg-muted">
        Welcome to SpaceWorker. This is a placeholder — Task 2/3 fill it in with
        the actual extraction UI and queue/lane tooling.
      </p>
    </div>
  );
}