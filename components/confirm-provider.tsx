"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";

import { ConfirmDialog } from "@/components/modal";

// Replaces every window.confirm(...) in this app with the same in-app,
// themed dialog already used elsewhere (components/modal.tsx's ConfirmDialog)
// — a native browser confirm() breaks the illusion that this is a real app
// (it renders with the page's raw hostname in the title, "spaceworker.instaweb.top
// says", ignores the dark theme, and looks especially out of place once this
// app ships as a desktop EXE per Task 27, where there's no browser chrome to
// blame it on). Mounted once at the root layout, right next to ToastProvider.

interface ConfirmOptions {
  title: string;
  description: React.ReactNode;
  confirmLabel?: string;
  confirmVariant?: "primary" | "danger";
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<ConfirmOptions | null>(null);
  const [pending, setPending] = useState(false);
  const resolverRef = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((opts) => {
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
      setPending(false);
      setState(opts);
    });
  }, []);

  function settle(result: boolean) {
    resolverRef.current?.(result);
    resolverRef.current = null;
    setState(null);
    setPending(false);
  }

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <ConfirmDialog
        open={state !== null}
        onClose={() => settle(false)}
        onConfirm={() => settle(true)}
        title={state?.title ?? ""}
        description={state?.description ?? ""}
        confirmLabel={state?.confirmLabel ?? "Confirm"}
        confirmVariant={state?.confirmVariant ?? "danger"}
        confirming={pending}
      />
    </ConfirmContext.Provider>
  );
}

// Drop-in replacement for `if (!window.confirm("...")) return;`:
//   const confirm = useConfirm();
//   if (!(await confirm({ title: "...", description: "...", confirmLabel: "..." }))) return;
export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm() must be used within <ConfirmProvider>");
  return ctx;
}
