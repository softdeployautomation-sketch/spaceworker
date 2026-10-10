/**
 * TASK_195 S4 — the ONE server-side home of the secret admin path fragment.
 *
 * WHY THIS FILE EXISTS: the QA battery's `build-leak` probe greps every
 * world-readable chunk under `.next/static` for SECRET_ADMIN_FRAGMENT and
 * FAILs the deploy when the string is there. The three admin CLIENT
 * components (admin-shell, admin-login-form, devices-tab) used to hardcode
 * the path, so it compiled into downloadable chunks. Now the literal lives
 * ONLY in server code (this module + the app/admin=… route tree + server
 * libs), and client components receive the path as a PROP from their server
 * parent — props serialize into auth-gated RSC payloads at runtime; they are
 * never compiled into static assets.
 *
 * HONEST LIMIT (recorded in TASK_195_STEPS): tripwire-grade. Anyone holding
 * an admin session can read the path from their own payload — the real gate
 * remains the session cookie + proxy, proven by the battery's access probes.
 *
 * Server code ONLY. A client import of this module would re-introduce the
 * very leak it exists to prevent.
 */
export const ADMIN_PATH = "/admin=topsecret6199";
export const ADMIN_LOGIN_PATH = `${ADMIN_PATH}/login`;
