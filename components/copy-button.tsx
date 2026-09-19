"use client";

import { useState } from "react";

import { copyToClipboard } from "@/lib/clipboard";

// A small copy-to-clipboard button used wherever a tall value (like an EXE
// license key) should be easy to grab in full.
export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  async function copy() {
    const ok = await copyToClipboard(value);
    if (ok) {
      setCopied(true);
      setFailed(false);
      setTimeout(() => setCopied(false), 2000);
    } else {
      setFailed(true);
      setTimeout(() => setFailed(false), 2000);
    }
  }
  return (
    <button
      type="button"
      onClick={copy}
      className="rounded-lg border border-border bg-bg-elevated px-3 py-1 text-xs font-medium text-fg transition-colors hover:bg-black/5 dark:hover:bg-white/5"
    >
      {copied ? "Copied!" : failed ? "Copy failed — select manually" : label}
    </button>
  );
}
