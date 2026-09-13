"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Check } from "lucide-react";

import { useNavItems } from "@/components/dashboard-nav";
import { Modal } from "@/components/modal";
import { cn } from "@/lib/cn";

type MenuKey = "file" | "window" | "help";

interface MenuItemDef {
  label: string;
  href?: string;
  onSelect?: () => void;
  active?: boolean;
}

// Real File/Window/Help dropdowns for the OS-style menu bar — these used to be
// plain, unclickable <span> labels (decorative only). Window's list is built
// from useNavItems(), the same single source of truth the dock and mobile nav
// already render from, so it can never list a destination those don't have.
export function MenuBar() {
  const [openMenu, setOpenMenu] = useState<MenuKey | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const navItems = useNavItems();

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpenMenu(null);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  const fileItems: MenuItemDef[] = [
    { label: "New Extraction Job", href: "/dashboard/extract" },
    { label: "New Campaign", href: "/dashboard/campaigns" },
    { label: "New Mailbox", href: "/dashboard/mailboxes" },
    { label: "New Browser Profile", href: "/dashboard/browser?tab=profiles" },
  ];

  const windowItems: MenuItemDef[] = navItems.map((item) => ({
    label: item.label,
    href: item.href,
    active: item.active,
  }));

  const helpItems: MenuItemDef[] = [
    { label: "About SpaceWorker OS", onSelect: () => setAboutOpen(true) },
    { label: "Terms of Service", href: "/terms" },
  ];

  return (
    <div ref={containerRef} className="hidden items-center gap-1 md:flex">
      <MenuDropdown
        label="File"
        menuKey="file"
        openMenu={openMenu}
        setOpenMenu={setOpenMenu}
        items={fileItems}
        footer={{ label: "Sign Out", onSelect: signOut }}
      />
      <MenuDropdown
        label="Window"
        menuKey="window"
        openMenu={openMenu}
        setOpenMenu={setOpenMenu}
        items={windowItems}
      />
      <MenuDropdown
        label="Help"
        menuKey="help"
        openMenu={openMenu}
        setOpenMenu={setOpenMenu}
        items={helpItems}
      />

      <Modal open={aboutOpen} onClose={() => setAboutOpen(false)} title="About SpaceWorker OS">
        <p className="text-sm text-fg-muted">
          Your automation desktop — find leads, keep your browser identities
          clean, and send outreach, all from one place.
        </p>
      </Modal>
    </div>
  );
}

function MenuDropdown({
  label,
  menuKey,
  openMenu,
  setOpenMenu,
  items,
  footer,
}: {
  label: string;
  menuKey: MenuKey;
  openMenu: MenuKey | null;
  setOpenMenu: (k: MenuKey | null) => void;
  items: MenuItemDef[];
  footer?: MenuItemDef;
}) {
  const open = openMenu === menuKey;
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpenMenu(open ? null : menuKey)}
        className={cn(
          "rounded px-1.5 py-0.5 text-[12.5px] transition-colors",
          open ? "bg-black/10 text-fg dark:bg-white/10" : "text-fg-muted hover:text-fg",
        )}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {label}
      </button>
      {open && (
        <div
          role="menu"
          aria-label={label}
          className="absolute left-0 top-full z-50 mt-1 min-w-[190px] rounded-lg border border-border bg-bg-elevated py-1 shadow-lg"
        >
          {items.map((item) => (
            <MenuEntry key={item.label} item={item} onDone={() => setOpenMenu(null)} />
          ))}
          {footer && (
            <>
              <div className="my-1 h-px bg-border" />
              <MenuEntry item={footer} onDone={() => setOpenMenu(null)} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function MenuEntry({ item, onDone }: { item: MenuItemDef; onDone: () => void }) {
  const className =
    "flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-[12.5px] text-fg hover:bg-black/5 dark:hover:bg-white/5";
  const content = (
    <>
      <span>{item.label}</span>
      {item.active && <Check className="h-3.5 w-3.5 text-brand-500" aria-hidden="true" />}
    </>
  );
  if (item.href) {
    return (
      <Link role="menuitem" href={item.href} className={className} onClick={onDone}>
        {content}
      </Link>
    );
  }
  return (
    <button
      role="menuitem"
      type="button"
      className={className}
      onClick={() => {
        item.onSelect?.();
        onDone();
      }}
    >
      {content}
    </button>
  );
}
