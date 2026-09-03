"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LogoutButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function onClick() {
    setLoading(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      router.push("/login");
      router.refresh();
    }
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      className="text-sm font-medium text-red-600 hover:underline disabled:opacity-50 dark:text-red-400"
    >
      {loading ? "Logging out…" : "Log out"}
    </button>
  );
}