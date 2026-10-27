/**
 * TASK_246 — single source of truth for the Cline API host.
 *
 * The 2026-10 Cyber Lab regression ("fetch failed" on Confirm) was a typo'd
 * `.com` default that does not even resolve in DNS. The SDK's own production
 * config (@cline/core `dw.production`) and Cline's docs use the `.bot` host
 * below. Read the override once here so login/poll/callback cannot drift apart.
 */
export const CLINE_DEFAULT_API_BASE_URL = "https://api.cline.bot";

export function getClineApiBaseUrl(): string {
  const configured = process.env.CLINE_API_BASE_URL?.trim();
  const base = configured && configured.length > 0 ? configured : CLINE_DEFAULT_API_BASE_URL;
  return base.replace(/\/+$/, "");
}
