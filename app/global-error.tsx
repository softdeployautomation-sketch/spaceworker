"use client";

import { useEffect } from "react";

// Last-resort boundary — catches an error thrown by the ROOT layout itself
// (app/error.tsx can't; it only wraps children of the root layout). Next.js
// requires this file to render its own <html>/<body> since the real root
// layout is exactly what failed. Reports the same way as app/error.tsx.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    fetch("/api/client-error-report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: error.message,
        stack: error.stack,
        digest: error.digest,
        url: typeof window !== "undefined" ? window.location.href : undefined,
      }),
    }).catch(() => {
      // Best-effort — never let the reporting call itself compound the crash.
    });
  }, [error]);

  return (
    <html>
      <body style={{ background: "#0a0a0a", color: "#e5e5e5" }}>
        <div
          style={{
            display: "flex",
            minHeight: "100vh",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "1rem",
            padding: "0 1rem",
            textAlign: "center",
            fontFamily: "sans-serif",
          }}
        >
          <h1 style={{ fontSize: "1.25rem", fontWeight: 600 }}>SpaceWorker OS hit an unexpected error</h1>
          <p style={{ maxWidth: "28rem", fontSize: "0.875rem", color: "#a3a3a3" }}>
            It&apos;s been reported. Try reloading.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              borderRadius: "0.5rem",
              background: "#fafafa",
              color: "#18181b",
              padding: "0.5rem 1rem",
              fontSize: "0.875rem",
              fontWeight: 500,
              border: "none",
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
