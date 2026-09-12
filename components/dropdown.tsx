"use client";
import { cn } from "@/lib/cn";
import { useEffect, useRef, useState } from "react";

// Task 26, Piece 7e — a plain, reusable dropdown-menu primitive (button trigger +
// absolutely-positioned menu panel, closed on outside-click / Escape). Introduced
// for the Extract detail-pane's collapsed Actions menu, and written as a public
// component so any future page reuses it instead of building a second one.
//
// There WAS a dropdown in this repo before (components/menu-bar.tsx's MenuDropdown),
// but it is menu-bar-specific (bound to a MenuKey enum, OS-style File/Window/Help
// sizing), not a usable generic — so this is the one 7e calls for ("use it here
// first"), not a duplicate of it.

export interface DropdownItem {
  label: string;
  // Exactly one of href / onSelect should be set. href renders an <a> (so a
  // download= export link works naturally); onSelect renders a <button>.
  href?: string;
  download?: boolean | string;
  onSelect?: () => void;
  disabled?: boolean;
  // Shows a small inline spinner before the label while an action runs (e.g. a
  // running validation) — gives a long action a visible busy state inside the menu.
  busy?: boolean;
  // "danger" tints the label red (e.g. a destructive action); default is plain.
  tone?: "default" | "danger";
}

export function Dropdown({
  label,
  items,
  className,
  align = "right",
}: {
  label: string;
  items: DropdownItem[];
  // Trigger-button classes, so the caller keeps full control of sizing/styling.
  className?: string;
  // Which side the menu panel hangs from the trigger. Right = right-edge aligned
  // (for a trigger near the pane's right edge); left = left-edge aligned.
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  // If any item is busy, show a small spinner on the trigger too — the menu closes
  // as soon as an action is chosen, so the trigger is where a few-second action
  // (e.g. running a validation) keeps signaling "working" rather than looking stalled.
  const anyBusy = items.some((i) => i.busy);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1 text-xs font-medium",
          open && "bg-black/10 dark:bg-white/10",
          className,
        )}
      >
        {anyBusy && (
          <span
            className="animate-[spin_0.8s_linear_infinite] inline-block h-3 w-3 rounded-full border-2 border-brand-600 border-t-transparent"
            aria-hidden="true"
          />
        )}
        {label}
        <span className="text-[10px] text-fg-muted" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div
          role="menu"
          aria-label={label}
          className={cn(
            "absolute z-50 mt-1 min-w-[190px] rounded-lg border border-border bg-bg-elevated py-1 shadow-lg",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          {items.map((item) => (
            <DropdownEntry key={item.label} item={item} onDone={() => setOpen(false)} />
          ))}
        </div>
      )}
    </div>
  );
}

function DropdownEntry({ item, onDone }: { item: DropdownItem; onDone: () => void }) {
  const rowClass = cn(
    "flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-xs",
    item.disabled
      ? "cursor-not-allowed text-fg-muted"
      : (item.tone === "danger" ? "text-red-500 hover:bg-red-50" : "text-fg hover:bg-black/5 dark:hover:bg-white/5"),
  );
  const labelWithBusy = item.busy ? (
    <span className="flex items-center gap-2">
      <span
        className="animate-[spin_0.8s_linear_infinite] inline-block h-3 w-3 rounded-full border-2 border-brand-600 border-t-transparent"
        aria-hidden="true"
      />
      {item.label}
    </span>
  ) : (
    item.label
  );
  if (item.href) {
    return (
      <a
        role="menuitem"
        href={item.href}
        download={item.download}
        aria-disabled={item.disabled}
        className={rowClass}
        onClick={onDone}
      >
        {labelWithBusy}
      </a>
    );
  }
  return (
    <button
      role="menuitem"
      type="button"
      disabled={item.disabled}
      className={rowClass}
      onClick={() => {
        if (item.disabled) return;
        item.onSelect?.();
        onDone();
      }}
    >
      {labelWithBusy}
    </button>
  );
}