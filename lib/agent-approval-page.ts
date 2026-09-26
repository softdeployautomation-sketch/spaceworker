import "server-only";

// Task 94 — a tiny, dependency-free HTML shell for the tap-endpoint result
// pages (opened from Telegram's in-app browser, no session, no JS needed).
// Deliberately not a React page — these are one-shot server responses hit
// by a URL button, not part of the Next.js app's authenticated surface.

export function renderApprovalPage(opts: {
  title: string;
  message: string;
  tone: "ok" | "error";
  detail?: string;
}): string {
  const color = opts.tone === "ok" ? "#16a34a" : "#dc2626";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(opts.title)} — SpaceWorker OS</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #17130f; color: #f2ede6; margin: 0; padding: 0; display: flex; min-height: 100vh; align-items: center; justify-content: center; }
  .card { max-width: 420px; margin: 24px; padding: 28px; border-radius: 16px; background: #211b15; border: 1px solid #382f24; text-align: center; }
  h1 { font-size: 20px; margin: 0 0 12px; color: ${color}; }
  p { font-size: 15px; line-height: 1.5; color: #cfc6ba; margin: 0 0 8px; }
  .detail { font-size: 13px; color: #8a8073; margin-top: 16px; }
</style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(opts.title)}</h1>
    <p>${escapeHtml(opts.message)}</p>
    ${opts.detail ? `<p class="detail">${escapeHtml(opts.detail)}</p>` : ""}
  </div>
</body>
</html>`;
}

export function renderReviewPage(opts: {
  kind: string;
  proposal: string;
  expiresAt: string;
  token: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Review proposal — SpaceWorker OS</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #17130f; color: #f2ede6; margin: 0; padding: 0; display: flex; min-height: 100vh; align-items: center; justify-content: center; }
  .card { max-width: 480px; width: 100%; margin: 24px; padding: 28px; border-radius: 16px; background: #211b15; border: 1px solid #382f24; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .kind { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: #8a8073; margin-bottom: 16px; }
  .proposal { font-size: 15px; line-height: 1.6; color: #cfc6ba; white-space: pre-wrap; background: #17130f; border: 1px solid #382f24; border-radius: 10px; padding: 14px; margin-bottom: 8px; }
  .expiry { font-size: 12px; color: #8a8073; margin-bottom: 20px; }
  form { display: inline-block; width: 48%; }
  button { width: 100%; padding: 12px; border-radius: 10px; border: none; font-size: 15px; font-weight: 600; cursor: pointer; }
  .approve { background: #16a34a; color: white; }
  .reject { background: #dc2626; color: white; margin-left: 4%; }
</style>
</head>
<body>
  <div class="card">
    <div class="kind">${escapeHtml(opts.kind)} proposal</div>
    <h1>Review before you decide</h1>
    <div class="proposal">${escapeHtml(opts.proposal)}</div>
    <div class="expiry">Expires ${escapeHtml(opts.expiresAt)}</div>
    <form method="POST" style="display:inline">
      <input type="hidden" name="decision" value="approve" />
      <button type="submit" class="approve">✅ Approve</button>
    </form>
    <form method="POST" style="display:inline">
      <input type="hidden" name="decision" value="reject" />
      <button type="submit" class="reject">❌ Reject</button>
    </form>
  </div>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
