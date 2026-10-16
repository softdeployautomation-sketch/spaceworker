"use client";

import { useState } from "react";

/**
 * Public support message form (owner, 2026-10-16: text-free gate edition).
 * Appears only after the joker scramble is solved. No headings or
 * explanation — bare fields and a send button, styled for the dark gate.
 * Rate-limited by IP at the route handler.
 */
export default function SupportForm() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "ok" | "bad">(
    "idle",
  );

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus("sending");
    try {
      const res = await fetch("/api/support/public", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, message }),
      });
      if (res.ok) {
        setStatus("ok");
        setName("");
        setEmail("");
        setMessage("");
      } else {
        setStatus("bad");
      }
    } catch {
      setStatus("bad");
    }
  };

  return (
    <form
      onSubmit={submit}
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 rounded-xl border border-white/10 bg-white/[0.04] p-5 backdrop-blur"
    >
      <input
        className="rounded border border-white/15 bg-black/40 px-3 py-2.5 text-sm text-white placeholder:text-white/35 focus:outline-none focus:ring-2 focus:ring-[#ff3c3c]"
        placeholder="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        className="rounded border border-white/15 bg-black/40 px-3 py-2.5 text-sm text-white placeholder:text-white/35 focus:outline-none focus:ring-2 focus:ring-[#ff3c3c]"
        placeholder="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <textarea
        className="sm:col-span-2 rounded border border-white/15 bg-black/40 px-3 py-2.5 text-sm text-white placeholder:text-white/35 focus:outline-none focus:ring-2 focus:ring-[#ff3c3c]"
        rows={4}
        placeholder="Message"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
      />
      <button
        type="submit"
        disabled={status === "sending"}
        className="sm:col-span-2 rounded-lg bg-[#c0392b] px-4 py-2.5 text-sm font-medium text-white hover:bg-[#a93226] disabled:opacity-60 transition-colors"
      >
        {status === "sending" ? "…" : status === "ok" ? "✓" : "Send"}
      </button>
      {status === "bad" && (
        <p className="sm:col-span-2 text-sm text-[#ff6b6b] font-medium">!</p>
      )}
    </form>
  );
}
