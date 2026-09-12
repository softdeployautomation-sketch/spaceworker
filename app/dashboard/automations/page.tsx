// Task 26, Piece 6 — new top-level nav destination. Intentionally a static
// placeholder ("Coming soon") behind the existing auth-gated dashboard layout;
// the real automation builder will land here later but there is nothing to
// render yet, so we keep this file dependency-free and hook-free.
export default function AutomationsPage() {
  return (
    <div className="flex flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Automations</h1>
        <p className="mt-1 text-sm text-fg-muted">
          Automate the repetitive parts of your outreach.
        </p>
      </div>

      <div className="rounded-xl border border-dashed border-zinc-300 p-10 text-center dark:border-zinc-700">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Coming soon — this is where scheduled, trigger-based sending and the
          rest of the automation tooling will live.
        </p>
      </div>
    </div>
  );
}