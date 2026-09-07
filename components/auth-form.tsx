"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useState } from "react";

import { Button, Input, Label, Spinner } from "@/components/ui";

export function AuthForm(props: {
  mode: "login" | "signup";
  initialEmail?: string;
}) {
  const router = useRouter();
  const [email, setEmail] = useState(props.initialEmail ?? "");
  const [password, setPassword] = useState("");
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submitting = loading;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`/api/auth/${props.mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          props.mode === "signup" ? { email, password, acceptedTerms } : { email, password },
        ),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.needsVerification) {
          // Redirect to the verify page with the email so they can enter the code.
          router.push(`/verify?email=${encodeURIComponent(email)}`);
          return;
        }
        setError(data.error ?? "Something went wrong. Please try again.");
        return;
      }
      if (props.mode === "signup") {
        router.push(`/verify?email=${encodeURIComponent(email)}`);
        router.refresh();
        return;
      }
      router.push("/dashboard");
      router.refresh();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {error && (
        <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}
      {props.mode === "signup" && (
        <div className="rounded-lg bg-brand-50 px-3 py-2 text-sm text-brand-800">
          You&apos;ll need to verify your email to finish signing up.
        </div>
      )}
      <div>
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
        />
      </div>
      <div>
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          type="password"
          autoComplete={props.mode === "signup" ? "new-password" : "current-password"}
          required
          minLength={props.mode === "signup" ? 8 : undefined}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
        />
      </div>
      {props.mode === "signup" && (
        <label className="flex items-start gap-2 text-sm text-fg-muted">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={acceptedTerms}
            onChange={(e) => setAcceptedTerms(e.target.checked)}
          />
          <span>
            I agree to the{" "}
            <Link href="/terms" target="_blank" className="font-medium text-brand-600 hover:underline">
              Terms of Service &amp; Acceptable Use Policy
            </Link>
            .
          </span>
        </label>
      )}
      <Button
        type="submit"
        disabled={submitting || (props.mode === "signup" && !acceptedTerms)}
        className="w-full"
      >
        {submitting && <Spinner />}
        {props.mode === "signup" ? "Create account" : "Sign in"}
      </Button>
    </form>
  );
}