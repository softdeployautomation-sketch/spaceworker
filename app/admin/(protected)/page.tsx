import type { Metadata } from "next";

export const metadata: Metadata = { title: "Admin" };

export const dynamic = "force-dynamic";

export default function AdminOverviewPage() {
  return (
    <div>
      <h1 className="text-2xl font-bold text-fg">Admin overview</h1>
      <p className="mt-2 text-sm text-fg-muted">
        Placeholder. Task 3/4/5 add the queue/lane controls, billing, and user
        management here.
      </p>
    </div>
  );
}