"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { useToast } from "@/components/toast";

// TASK_190 S3 — the header also owns the admin's own notification channels:
// two compact toggles (GREYED OUT when the channel's env is missing, per the
// `configured` flags from GET — a clickable toggle for an impossible channel
// is a bug) plus the write-only "paste chat id" field that links Telegram.
// The chat id is sent to PATCH and NEVER read back: the response exposes only
// the boolean `telegramLinked`.
type PrefsView = {
  telegramEnabled: boolean;
  emailEnabled: boolean;
  telegramLinked: boolean;
  configured: { telegram: boolean; email: boolean };
};

// TASK_126 (2026-09-26) — this used to also render a sidebar + mobile nav
// strip with a single "Overview" link (from Task 1, when the whole admin
// panel WAS one page). AdminPanel has had its own real tab bar for a long
// time now, so that outer nav was just a second, redundant "Overview" sitting
// beside the real one — removed. This shell now only owns the page chrome
// every admin route shares: the top header and Log out.
export function AdminShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const toast = useToast();
  const [loggingOut, setLoggingOut] = useState(false);
  const [prefs, setPrefs] = useState<PrefsView | null>(null);
  const [chatDraft, setChatDraft] = useState("");
  const [savingChat, setSavingChat] = useState(false);

  // Read the channel prefs once on mount. setState only ever runs AFTER the
  // await — never synchronously in the effect body (the set-state-in-effect
  // lint rule); a failed read leaves the toggles in their disabled default
  // instead of breaking the panel chrome.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch("/api/admin/notification-prefs");
        if (!res.ok) return;
        const data = (await res.json()) as PrefsView;
        if (live) setPrefs(data);
      } catch {
        // Header chrome — an unreadable prefs row must never break the panel.
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  /** PATCH the singleton; true when the server confirmed (and returned the new view). */
  async function patchPrefs(patch: Record<string, unknown>): Promise<boolean> {
    try {
      const res = await fetch("/api/admin/notification-prefs", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast.push(
          (data as { error?: string } | null)?.error ?? "Couldn't save notification settings.",
          "error",
        );
        return false;
      }
      setPrefs(data as PrefsView);
      return true;
    } catch {
      toast.push("Network error while saving notification settings.", "error");
      return false;
    }
  }

  async function saveChatId(e: React.FormEvent) {
    e.preventDefault();
    const chatId = chatDraft.trim();
    if (chatId.length === 0) return;
    setSavingChat(true);
    const saved = await patchPrefs({ telegramChatId: chatId });
    setSavingChat(false);
    if (saved) setChatDraft(""); // linked ⇒ the field is replaced by the linked chip
  }

  async function logout() {
    setLoggingOut(true);
    try {
      const res = await fetch("/api/admin/logout", { method: "POST" });
      if (!res.ok) toast.push("Couldn't log out — try again.", "error");
    } catch {
      toast.push("Network error while logging out.", "error");
    } finally {
      setLoggingOut(false);
    }
    router.push("/admin=topsecret6199/login");
    router.refresh();
  }

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-border bg-bg-elevated/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4">
          <div className="flex items-center gap-3">
            <Link href="/admin=topsecret6199" className="text-lg font-bold text-brand-600 dark:text-brand-400">
              SpaceWorker · Admin
            </Link>
          </div>
          {/* TASK_190 S3 — Notifications [Telegram] [Email] + the write-only
              paste-chat-id link. Hidden on small screens (header chrome); the
              toggles are disabled until GET reports their channel configured. */}
          <div className="hidden items-center gap-2 md:flex">
            <span className="mr-1 text-xs font-semibold uppercase tracking-wide text-fg-muted">
              Notifications
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={prefs?.telegramEnabled ?? false}
              aria-label="Telegram"
              disabled={prefs ? !prefs.configured.telegram : true}
              onClick={() => void patchPrefs({ telegramEnabled: !(prefs?.telegramEnabled ?? false) })}
              className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                (prefs?.telegramEnabled ?? false)
                  ? "border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700"
                  : "border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              }`}
            >
              Telegram
            </button>
            <button
              type="button"
              role="switch"
              aria-checked={prefs?.emailEnabled ?? false}
              aria-label="Email"
              disabled={prefs ? !prefs.configured.email : true}
              onClick={() => void patchPrefs({ emailEnabled: !(prefs?.emailEnabled ?? false) })}
              className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                (prefs?.emailEnabled ?? false)
                  ? "border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700"
                  : "border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              }`}
            >
              Email
            </button>
            {prefs?.telegramLinked ? (
              <span className="ml-1 text-xs text-emerald-600 dark:text-emerald-400">
                Telegram: linked ✓
              </span>
            ) : (
              <form onSubmit={saveChatId} className="ml-1 flex items-center gap-1.5">
                <label
                  htmlFor="admin-telegram-chat-id"
                  className="whitespace-nowrap text-xs text-fg-muted"
                >
                  Telegram: not connected →
                </label>
                <input
                  id="admin-telegram-chat-id"
                  type="text"
                  inputMode="numeric"
                  value={chatDraft}
                  onChange={(e) => setChatDraft(e.target.value)}
                  placeholder="paste chat id"
                  className="w-32 rounded-lg border border-border bg-transparent px-2 py-1 text-xs"
                />
                <button
                  type="submit"
                  disabled={savingChat || chatDraft.trim().length === 0}
                  className="rounded-lg border border-border px-2 py-1 text-xs font-medium text-fg-muted hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/5"
                >
                  {savingChat ? "Saving…" : "Save"}
                </button>
              </form>
            )}
          </div>
          <button
            type="button"
            onClick={logout}
            disabled={loggingOut}
            className="rounded-lg px-3 py-2 text-sm font-medium text-fg-muted hover:bg-black/5 hover:text-fg dark:hover:bg-white/5"
          >
            {loggingOut ? "Logging out…" : "Log out"}
          </button>
        </div>
      </header>

      <main>{children}</main>
    </div>
  );
}