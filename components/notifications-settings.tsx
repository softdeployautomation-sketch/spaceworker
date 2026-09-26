"use client";

import { useState } from "react";

import { Badge, Button } from "@/components/ui";
import { cn } from "@/lib/cn";
import { copyToClipboard } from "@/lib/clipboard";

interface NotificationPrefs {
  notifyEmail: boolean;
  notifyTelegram: boolean;
  notifyAgent: boolean;
  telegramApprovalsEnabled: boolean;
  telegramChatEnabled: boolean;
  digestEnabled: boolean;
  deviceTelemetryEnabled: boolean;
  agentActionsEnabled: boolean;
  linked: boolean;
  connectUrl: string | null;
  linkToken: string | null;
}

interface Props {
  prefs: NotificationPrefs;
}

// A small on/off switch (this codebase has no shared Toggle component).
function Toggle({
  label,
  description,
  checked,
  disabled,
  onToggle,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-border bg-bg-elevated p-3 text-sm",
        disabled ? "opacity-60 pointer-events-none" : "",
      )}
    >
      <div className="min-w-0">
        <span className="font-medium text-fg">{label}</span>
        <p className="mt-0.5 text-xs text-fg-muted">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked ? "true" : "false"}
        onClick={() => onToggle(!checked)}
        className={cn(
          "relative h-5.5 w-9.5 shrink-0 rounded-full transition-colors",
          checked ? "bg-brand-600" : "bg-gray-300 dark:bg-white/15",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 h-4.5 w-4.5 rounded-full bg-white transition-all",
            checked ? "left-[calc(100%-1.25rem)]" : "left-0.5",
          )}
        />
      </button>
    </label>
  );
}

export function NotificationsSettings({ prefs: initial }: Props) {
  const [prefs, setPrefs] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  async function patch(body: Record<string, unknown>, label: string) {
    setBusy(label);
    setError(null);
    setSaved(null);
    try {
      const res = await fetch("/api/settings/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        prefs?: NotificationPrefs;
      };
      if (!res.ok || !data.prefs) {
        setError(data.error ?? "Something went wrong. Please try again.");
        return;
      }
      setPrefs(data.prefs);
      setSaved(label);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  const telegramLabel =
    prefs.linked
      ? "Linked"
      : prefs.connectUrl ? "Not linked" : "Not available";

  return (
    <div className="flex flex-col gap-3">
      <Toggle
        label="Email"
        description="Send notification emails (kept on by default)."
        checked={prefs.notifyEmail}
        disabled={busy !== null}
        onToggle={(v) => void patch({ notifyEmail: v }, "Email preference saved")}
      />
      <Toggle
        label="Telegram"
        description="Send notifications to your Telegram chat (requires linking)."
        checked={prefs.notifyTelegram}
        disabled={busy !== null || !prefs.linked}
        onToggle={(v) => void patch({ notifyTelegram: v }, "Telegram preference saved")}
      />
      <Toggle
        label="Agent chat"
        description="Post notifications into your “Ask the agent” chat panel."
        checked={prefs.notifyAgent}
        disabled={busy !== null}
        onToggle={(v) => void patch({ notifyAgent: v }, "Agent chat preference saved")}
      />
      <Toggle
        label="Approvals via Telegram"
        description="Approve or reject agent proposals right from Telegram — no login needed, one tap."
        checked={prefs.telegramApprovalsEnabled}
        disabled={busy !== null || !prefs.linked}
        onToggle={(v) => void patch({ telegramApprovalsEnabled: v }, "Telegram approvals preference saved")}
      />
      <Toggle
        label="Chat with the agent on Telegram"
        description="Message the bot directly and get real answers back — the same agent as the dashboard chat, same daily AI limit applies. Off by default: a linked chat won't read your messages as agent input unless you turn this on."
        checked={prefs.telegramChatEnabled}
        disabled={busy !== null || !prefs.linked}
        onToggle={(v) => void patch({ telegramChatEnabled: v }, "Telegram chat preference saved")}
      />
      <Toggle
        label="Daily assistant digest"
        description="A once-a-day summary of your workspace and device activity."
        checked={prefs.digestEnabled}
        disabled={busy !== null}
        onToggle={(v) => void patch({ digestEnabled: v }, "Digest preference saved")}
      />
      <Toggle
        label="Device telemetry"
        description="Master switch for device heartbeats and reachability. Off stops all device ingest."
        checked={prefs.deviceTelemetryEnabled}
        disabled={busy !== null}
        onToggle={(v) => void patch({ deviceTelemetryEnabled: v }, "Telemetry preference saved")}
      />
      <Toggle
        label="Agent actions"
        description="Let the agent propose actions (jobs, campaigns, device commands) for you to approve. Off still lets you chat normally and use manual device tools — the agent just won't create anything to approve."
        checked={prefs.agentActionsEnabled}
        disabled={busy !== null}
        onToggle={(v) => void patch({ agentActionsEnabled: v }, "Agent actions preference saved")}
      />
      <div className="rounded-lg border border-border bg-bg-elevated p-3 text-sm">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <span className="font-medium text-fg">Telegram connection</span>
            <p className="mt-0.5 text-xs text-fg-muted">
              Link your Telegram so SpaceWorker can notify you there.
            </p>
          </div>
          <Badge tone={prefs.linked ? "success" : "neutral"}>{telegramLabel}</Badge>
        </div>

        {prefs.linked ? (
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="danger"
              disabled={busy !== null}
              onClick={() => void patch({ unlink: true }, "Telegram unlinked")}
            >
              Unlink Telegram
            </Button>
          </div>
        ) : prefs.connectUrl ? (
          <div className="mt-2 flex flex-col gap-2">
            <p className="text-xs text-fg-muted">
              Open this link in your Telegram app (or scan the QR from the
              Telegram app) and press <span className="font-mono">Start</span> to
              connect:
            </p>
            <div className="rounded-lg border border-border bg-black/5 px-2 py-1.5 font-mono text-[11px] break-all text-fg-muted dark:bg-white/5">
              {prefs.connectUrl}
            </div>
            <div className="flex flex-wrap gap-2">
              <a
                href={prefs.connectUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
              >
                Connect Telegram
              </a>
              <Button
                type="button"
                variant="secondary"
                disabled={busy !== null}
                onClick={() => void patch({ regenerate: true }, "New link generated")}
              >
                Regenerate link
              </Button>
            </div>

            {prefs.linkToken && (
              <div className="mt-1 rounded-lg border border-dashed border-border p-2.5">
                <p className="text-xs text-fg-muted">
                  Button not linking? This happens if you&apos;ve already chatted with
                  this bot before (e.g. via Vantra) — Telegram doesn&apos;t carry the
                  link code through in that case. Send this exact message to the bot
                  instead:
                </p>
                <div className="mt-1.5 flex items-center gap-2">
                  <code className="flex-1 truncate rounded-lg bg-black/5 px-2 py-1.5 font-mono text-[11px] text-fg-muted dark:bg-white/5">
                    {prefs.linkToken}
                  </code>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => void copyToClipboard(prefs.linkToken ?? "")}
                  >
                    Copy
                  </Button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <p className="mt-2 text-xs text-fg-muted">
            Telegram isn&apos;t configured on this instance. Email and agent-chat
            notifications still work.
          </p>
        )}
      </div>

      {error && <p className="text-xs text-red-500">{error}</p>}
      {saved && <p className="text-xs text-emerald-600">{saved}</p>}
    </div>
  );
}
