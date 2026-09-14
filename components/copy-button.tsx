"use client";

import { useState } from "react";

// A small copy-to-clipboard button used wherever a tall value (like an EXE
// license key) should be easy to grab in full.
export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }
  return (
    <button
      type="button"
      onClick={copy}
      className="rounded-lg border border-border bg-bg-elevated px-3 py-1 text-xs font-medium text-fg transition-colors hover:bg-black/5 dark:hover:bg-white/5"
    >
      {copied ? "Copied!" : label}
    </button>
  );
}