"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button, Spinner } from "@/components/ui";

export function LogoutButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function onLogout() {
    setLoading(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      router.push("/login");
      router.refresh();
    }
  }

  return (
    <Button variant="ghost" onClick={onLogout} disabled={loading} type="button">
      {loading && <Spinner />}
      Sign out
    </Button>
  );
}