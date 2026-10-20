"use client";

/**
 * TASK_234 — the thin "Insert" token menu shown ON TOP of a campaign editor
 * (subject/body), so a user can see the exact placeholder to type instead of
 * guessing and risking a token that never renders.
 *
 * `onPick` receives the raw token string; the hosting page decides where it
 * goes (see `insertTokenAtCursor` — caret of the focused field, else the first
 * body). `onMouseDown` prevents default on each chip so clicking never steals
 * focus out of the editor the caret lives in.
 *
 * What each token renders is owned by lib/render-merge.ts: `{{name}}`/`((name))`
 * resolve from the stored name columns first, then from the RECIPIENT'S EMAIL
 * ADDRESS alone (local-part parsing), then the `|default`, then empty — a token
 * is never shown literally.
 */

export const MERGE_TOKENS: { token: string; title: string }[] = [
  {
    token: "{{name}}",
    title: "Recipient's name — from their name column, or derived from their email address when there is none",
  },
  {
    token: "((name))",
    title: "Same as {{name}} — the double-paren spelling also works",
  },
  {
    token: "{{firstName}}",
    title: "First-name column (casing/spacing/separators are ignored)",
  },
  { token: "{{contactName}}", title: "Contact name (picked leads)" },
  { token: "{{company}}", title: "Company / business name column" },
  { token: "{{email}}", title: "The recipient's own email address" },
  {
    token: "{{name|there}}",
    title: "Name with a fallback — renders 'there' when no name and no usable email name exist",
  },
];

/**
 * Splice `token` into `value` at the caret of `el` (selection), or append it at
 * the end when nothing is selected/available. Pure string math — the caller
 * feeds the result straight into its controlled setter.
 */
export function insertTokenAtCursor(
  el: HTMLTextAreaElement | HTMLInputElement | null | undefined,
  token: string,
  value: string,
): string {
  if (!el) return value + token;
  const start = el.selectionStart ?? value.length;
  const end = el.selectionEnd ?? value.length;
  return value.slice(0, start) + token + value.slice(end);
}

export function MergeTokenBar({
  onPick,
  className,
}: {
  onPick: (token: string) => void;
  className?: string;
}) {
  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className ?? ""}`}>
      <span className="text-xs font-normal text-zinc-400">Insert:</span>
      {MERGE_TOKENS.map(({ token, title }) => (
        <button
          key={token}
          type="button"
          title={title}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(token)}
          className="rounded-md border border-zinc-300 bg-white px-1.5 py-0.5 font-mono text-xs text-zinc-600 transition-colors hover:border-zinc-400 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:border-zinc-600 dark:hover:bg-zinc-900"
        >
          {token}
        </button>
      ))}
      <span className="text-xs font-normal text-zinc-400">
        — the name is taken from the recipient&apos;s email when there is no name
        column; clicking inserts at your cursor
      </span>
    </div>
  );
}
