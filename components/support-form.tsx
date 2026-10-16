"use client";

import { useState } from "react";

/**
 * Public support message form — reachable without an account. Used by visitors
 * who landed on the invite-only homepage and need to request a referral or ask
 * a question. Rate-limited by IP at the route handler.
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
    <section className="mb-12 rounded-xl border border-[#f4c2c2] bg-[#ffe4e2] p-6">
      <h2 className="text-base font-semibold mb-3">Need an invite?</h2>
      <p className="text-sm text-[#9f3434] mb-4">
        No referral link yet? Drop us a message and we'll get back to you.
      </p>
      <form onSubmit={submit} className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4">
        <div className="col-span-2 sm:col-span-1">
          <label className="block text-xs text-[#9f3434] mb-1">Name (optional)</label>
          <input
            className="w-full rounded border border-[#fca5a5] bg-[#fff5f5] px-3 py-2 text-sm text-[#7f1d1d] focus:outline-none focus:ring-2 focus:ring-[#ff4d4d]"
            placeholder="Your name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="col-span-2 sm:col-span-1">
          <label className="block text-xs text-[#9f3434] mb-1">Email (optional)</label>
          <input
            className="w-full rounded border border-[#fca5a5] bg-[#fff5f5] px-3 py-2 text-sm text-[#7f1d1d] focus:outline-none focus:ring-2 focus:ring-[#ff4d4d]"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="col-span-2">
          <label className="block text-xs text-[#9f3434] mb-1">Message</label>
          <textarea
            className="w-full rounded border border-[#fca5a5] bg-[#fff5f5] px-3 py-2 text-sm text-[#7f1d1d] focus:outline-none focus:ring-2 focus:ring-[#ff4d4d]"
            rows={4}
            placeholder="How can we help?"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
        </div>
        <button
          type="submit"
          disabled={status === "sending"}
          className="col-span-2 sm:col-span-1 rounded-lg bg-[#c0392b] px-4 py-2 text-sm font-medium text-white hover:bg-[#a93226] disabled:opacity-60"
        >
          {status === "sending" ? "Sending…" : "Send message"}
        </button>
        {status === "ok" && (
          <p className="col-span-2 mt-2 text-sm text-[#1e7a3c] font-medium">
            Message received — we&rsquo;ll get back to you.
          </p>
        )}
        {status === "bad" && (
          <p className="col-span-2 mt-2 text-sm text-[#b91c1c] font-medium">
            Couldn&rsquo;t send. Try again in a moment.
          </p>
        )}
      </form>
    </section>
  );
}
