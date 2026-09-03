"use client";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

function VerifyForm() {
  const searchParams = useSearchParams();
  const [email, setEmail] = useState(searchParams.get("email") ?? "");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const router = useRouter();

  async function onVerify(e: React.FormEvent) {
    e.preventDefault();
    if (!email) {
      setError("Enter the email you signed up with");
      return;
    }
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch("/api/auth/verify", {
        method: "POST",
        body: JSON.stringify({ email, code }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        router.push("/dashboard");
        return;
      }
      setError(typeof data.error === "string" ? data.error : "Verification failed");
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  async function onResend() {
    if (!email) {
      setError("Enter the email you signed up with");
      return;
    }
    setResending(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch("/api/auth/resend-code", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setNotice("A new code has been sent. It expires in 15 minutes.");
      } else {
        setError(typeof data.error === "string" ? data.error : "Could not resend code");
      }
    } catch {
      setError("Network error");
    } finally {
      setResending(false);
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Check your email</h1>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        Enter the 6-digit code we sent to verify your account.
      </p>

      <form onSubmit={onVerify} className="mt-6 flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm font-medium">
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            required
            autoComplete="email"
            className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-normal outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm font-medium">
          Verification code
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            placeholder="123456"
            required
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
            className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-normal tracking-widest outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
          />
        </label>

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        {notice && <p className="text-sm text-emerald-600 dark:text-emerald-400">{notice}</p>}

        <button
          type="submit"
          disabled={loading || code.length !== 6}
          className="mt-2 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          {loading ? "Verifying…" : "Verify and continue"}
        </button>
      </form>

      <button
        type="button"
        onClick={onResend}
        disabled={resending}
        className="mt-4 w-full rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium transition-colors hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
      >
        {resending ? "Sending…" : "Resend code"}
      </button>

      <p className="mt-6 text-center text-sm text-zinc-500 dark:text-zinc-400">
        <Link href="/login" className="font-medium text-zinc-900 underline-offset-4 hover:underline dark:text-zinc-100">
          Back to log in
        </Link>
      </p>
    </div>
  );
}

export default function VerifyPage() {
  return (
    <Suspense fallback={<div className="text-center text-sm text-zinc-500">Loading…</div>}>
      <VerifyForm />
    </Suspense>
  );
}