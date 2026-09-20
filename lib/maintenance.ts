import "server-only";

import { getAdminSettings } from "./admin-settings";

// Task 56 — admin-toggleable maintenance windows. Two flags live on the
// AdminSetting singleton: maintenanceModeWeb (served by app/proxy.ts for
// everything except /admin/** and static assets) and maintenanceModeExeApi
// (/api/exe* + /api/exe-license* return 503 { maintenance: true }).
//
// These flags are read on the hot path (proxy runs on every page request), so we
// NEVER hit the DB per request — getMaintenanceFlags() caches the singleton read
// in-memory for a few seconds. A flipped toggle therefore takes effect within the
// cache TTL, which is fine: maintenance is a knowingly-scheduled window, not a
// millisecond-exact switch. Admin writes call invalidateMaintenanceCache() so the
// admin panel's own flip-back propagates immediately too.

let cache: { value: { web: boolean; exeApi: boolean }; at: number } | null = null;
const CACHE_TTL_MS = 8000; // 8s — per the task file's "5-10s is plenty" note.

export interface MaintenanceFlags {
  web: boolean;
  exeApi: boolean;
}

export async function getMaintenanceFlags(): Promise<MaintenanceFlags> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) {
    return cache.value;
  }
  const settings = await getAdminSettings();
  const value: MaintenanceFlags = {
    web: settings.maintenanceModeWeb,
    exeApi: settings.maintenanceModeExeApi,
  };
  cache = { value, at: now };
  return value;
}

/** Called by the admin write-path so a toggle flip is visible immediately. */
export function invalidateMaintenanceCache(): void {
  cache = null;
}

// Self-contained "we're updating" page. The same content ships as the nginx
// static file (deploy/maintenance.html → /opt/spaceworker/static/maintenance.html)
// that covers the literal restart window when the app process isn't listening at
// all (Mechanism 1). proxy.ts returns this inline when maintenanceModeWeb is on
// (Mechanism 2). The polling script reloads the instant the app answers with a
// real response instead of 5xx, satisfying "keeps reloading until it's cleared."
export const MAINTENANCE_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>We're updating — SpaceWorker</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 0.5rem;
        font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
        background: #0b0b0f;
        color: #e7e7ea;
        text-align: center;
      }
      .ring {
        border: 3px solid #6366f1;
        border-top-color: transparent;
        border-radius: 50%;
        width: 44px;
        height: 44px;
        animation: spin 1s linear infinite;
      }
      @keyframes spin { to { transform: rotate(360deg); } }
      h1 { margin: 0; font-size: 1.5rem; font-weight: 650; }
      p { margin: 0; font-size: 1rem; color: #a1a1aa; max-width: 30rem; }
    </style>
  </head>
  <body>
    <div class="ring" aria-hidden="true"></div>
    <h1>We're updating</h1>
    <p>SpaceWorker is getting better right now. This page reloads automatically — check back in a few minutes.</p>
    <script>
      // Poll the same URL (bypassing caches) and hard-reload the instant it
      // answers with a real 2xx/3xx page instead of another 5xx or connection
      // error. Keeps reloading until the update is cleared and the real page loads.
      (function () {
        var inFlight = false;
        setInterval(function () {
          if (document.visibilityState === "hidden" || inFlight) return;
          inFlight = true;
          fetch(location.href, { cache: "no-store" })
            .then(function (r) {
              if (r.ok || (r.status >= 300 && r.status < 400)) location.reload();
            })
            .catch(function () {})
            .finally(function () { inFlight = false; });
        }, 4000);
      })();
    </script>
  </body>
</html>
`;