import type { Metadata } from "next";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  return (
    <div>
      <h1 className="text-2xl font-bold text-fg">Settings</h1>
      <p className="mt-2 text-sm text-fg-muted">
        Placeholder — account settings land here in a later task.
      </p>
    </div>
  );
}