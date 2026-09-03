import type { ReactNode } from "react";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-100 px-4 py-8 dark:bg-zinc-950">
      <div className="w-full max-w-md rounded-xl bg-white p-8 shadow-lg dark:bg-zinc-900">
        {children}
      </div>
    </div>
  );
}