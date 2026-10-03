"use client";

import { useState } from "react";

// TASK_155 P6c — the "how do I make this token?" help, in ONE place.
//
// Both credential surfaces need it (the admin platform roster and the user's own
// Settings card) and both must say the SAME thing, or the docs and the UI drift.
// Cloudflare shows the permission summary in an almost-unreadable screenshot, and
// the actual failure ("that API token could not be verified") never tells anyone
// WHICH permission is missing — so we spell the two scopes out here.
//
// COLLAPSED BY DEFAULT because it is reference material, not a form label: the
// fields above are the thing people are doing; this is what they read when one of
// them is rejected. <details> gives keyboard/expand-for-free behaviour with no
// extra state.

export interface WorkerTokenHelpProps {
  /**
   * Whose token this is. The wording differs only in who is creating it — the
   * steps and the required permissions are identical, which is exactly why they
   * live in one component.
   */
  audience: "admin" | "user";
  className?: string;
}

/**
 * The three scopes P6c needs, with the reason each one exists.
 *
 * Workers Routes:Edit is separate from Scripts:Edit on purpose. Cloudflare's
 * token UI makes them look like one capability ("Workers"), and a token built
 * with only the one uploads the script but silently fails to attach the route —
 * the script runs, the domain just never reaches it. Spelling out all three is
 * the difference between a token that works and a support ticket.
 */
const PERMISSIONS = [
  { group: "Account", name: "Workers Scripts", access: "Edit", why: "uploads the redirect script" },
  { group: "Zone", name: "Workers Routes", access: "Edit", why: "sends your domain to it" },
  { group: "Zone", name: "DNS", access: "Edit", why: "points your domain at it" },
];

export function WorkerTokenHelp({ audience, className = "" }: WorkerTokenHelpProps) {
  const [copied, setCopied] = useState(false);

  async function copyPermissions() {
    try {
      await navigator.clipboard.writeText(
        PERMISSIONS.map((p) => `${p.group} — ${p.name}: ${p.access}`).join("\n")
      );
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be blocked (insecure context / denied permission). The list
      // is on screen either way, so failing quietly beats an error banner.
      setCopied(false);
    }
  }
return (
    <details
      className={`rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900/50 ${className}`}
    >
      <summary className="cursor-pointer select-none font-medium text-zinc-700 dark:text-zinc-200">
        How do I create this token? (required permissions)
      </summary>

      <div className="mt-3 space-y-3 text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">
        <p>
          {audience === "admin"
            ? "Create it in your Cloudflare account, then paste it into the field above."
            : "Create it in your own Cloudflare account, then paste it into the field above."}{" "}
          Cloudflare tokens are <strong>scoped</strong> — a token can do only what its permissions allow, which is
          why the Pages token cannot publish link redirects and needs this separate one.
        </p>

        <ol className="list-decimal space-y-1 pl-4">
          <li>
            Sign in to the Cloudflare dashboard and open <strong>My Profile → API Tokens</strong> (or{" "}
            <code className="rounded bg-zinc-200 px-1 dark:bg-zinc-800">dash.cloudflare.com/profile/api-tokens</code>).
          </li>
          <li>
            Click <strong>Create Token</strong> → <strong>Create Custom Token</strong> (not &ldquo;Edit zone DNS
            token&rdquo;, which only covers the single zone it was made from).
          </li>
          <li>
            Give it a name you&rsquo;ll recognise, such as <code>SpaceWorker Workers</code>.
          </li>
          <li>
            Under <strong>Permissions</strong>, add exactly these three:
            <ul className="mt-1 space-y-0.5">
              {PERMISSIONS.map((p) => (
                <li key={p.name} className="flex flex-wrap items-baseline gap-x-2">
                  <span>
                    <strong>
                      {p.group} — {p.name}: {p.access}
                    </strong>
                  </span>
                  <span className="text-zinc-500 dark:text-zinc-400">({p.why})</span>
                </li>
              ))}
            </ul>
          </li>
          <li>
            Under <strong>Account Resources</strong>, include <strong>All accounts</strong>; under{" "}
            <strong>Zone Resources</strong>, include <strong>All zones</strong> — or pick only the specific account
            and domain you want, which is safer.
          </li>
          <li>
            Click <strong>Continue to summary</strong> → <strong>Create Token</strong>, then copy the token. It is
            shown only once.
          </li>
        </ol>

        <div>
          <div className="flex items-center justify-between gap-2">
            <p className="font-medium text-zinc-700 dark:text-zinc-200">
              Summary — the token&rsquo;s title bar should read:
            </p>
            <button
              type="button"
              onClick={() => void copyPermissions()}
              className="rounded border border-zinc-300 px-2 py-0.5 text-[11px] text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <ul className="mt-1 space-y-0.5 font-medium">
            {PERMISSIONS.map((p) => (
              <li key={p.name}>
                All accounts — <strong>{p.name}:{p.access}</strong>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <p className="font-medium text-zinc-700 dark:text-zinc-200">If a token is rejected:</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            <li>
              <strong>&ldquo;could not be verified&rdquo;</strong> — the token is wrong, revoked, or expired. Create a
              new one.
            </li>
            <li>
              <strong>Nothing happens when publishing a link</strong> — the token is most likely missing{" "}
              <strong>Workers Scripts: Edit</strong>, the permission Cloudflare never names in an error message.
            </li>
            <li>
              <strong>The script uploads but the domain never reaches it</strong> — the token is missing{" "}
              <strong>Workers Routes: Edit</strong> on the zone. Scripts:Edit and Routes:Edit are separate, and
              Routes:Edit is the one Cloudflare never names in an error message.
            </li>
            <li>
              <strong>The domain doesn&rsquo;t point anywhere</strong> — the token needs <strong>DNS: Edit</strong>{" "}
              on the zone, and the domain must actually be in that Cloudflare account.
            </li>
            <li>
              You can leave this field blank — links then keep working through the plain{" "}
              <code className="rounded bg-zinc-200 px-1 dark:bg-zinc-800">/r/…</code> address, and only custom domains
              need the token.
            </li>
          </ul>
        </div>

        <p className="text-zinc-500 dark:text-zinc-400">
          The token is encrypted before it is stored and is never shown again — only the last four characters. If it
          ever leaks, revoke it in Cloudflare and paste a new one.
        </p>
      </div>
    </details>
  );
}