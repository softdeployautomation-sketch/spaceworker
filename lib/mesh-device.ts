// TASK_230 P4b — the mesh-only device discriminator. A MeshCentral node id is
// `node//<base64>` — a string shape no Tactical agent id can ever collide with
// (prefix + `//`), which is what makes it safe as a ZERO-SCHEMA capability
// signal: any surface can ask "is this a mesh-only public device?" straight
// from the id it already holds.
//
// Pure by design (no server-only / env / db) so BOTH client components and
// server routes import the same one truth — mirroring lib/sw-installer-names.

/** MeshCentral node id prefix — `node//` + base64 payload. */
export const MESH_ONLY_ID_PREFIX = "node//";

/**
 * True when the id is a MeshCentral node id, i.e. a standalone PUBLIC device
 * with a MeshAgent only — NO Tactical agent behind it. Such a device can run
 * commands (mesh runcommand), be hidden (same), and move to private; it does
 * NOT support remote control / browser session / stay-awake through our TRMM
 * paths (there is no TRMM agent record to mint against).
 */
export function isMeshOnlyDevice(vantraAgentId: string | null | undefined): boolean {
  return typeof vantraAgentId === "string" && vantraAgentId.startsWith(MESH_ONLY_ID_PREFIX);
}

// ---------------------------------------------------------------------------
// TASK_230 P4b — capability policy for a mesh-only PUBLIC device.
//
// Owner decision (2026-10-19, option C): do NOT hide the tabs — KEEP them
// visible, but render an inline "not available here → move to private" notice
// INSTEAD of a live connection. The user sees the feature exists and gets the
// honest path forward (move to private where Tactical backs everything), rather
// than a silently-dead button or a hidden menu.
//
// Tab key = the console's `tab` union (`summary|control|command|clone|
// activity|monitoring`). Kept as plain strings here so the pure lib stays
// importable by client + server without pulling the component's types.
// ---------------------------------------------------------------------------

/** Tabs whose live body needs a TRMM agent record → mesh-only shows a notice. */
export const MESH_ONLY_NOTICE_TABS = new Set<string>(["control", "clone", "monitoring"]);

/** Tabs that stay fully live on a mesh-only device (no TRMM agent needed). */
export const MESH_ONLY_LIVE_TABS = new Set<string>(["summary", "command", "activity"]);

/** Human noun per notice tab — names the capability the user is missing. */
const NOTICE_NOUNS: Record<string, string> = {
  control: "Remote control",
  clone: "Browser session",
  monitoring: "Screen monitoring",
};

/** True when this console tab renders the mesh-only notice instead of its tool. */
export function isMeshOnlyNoticeTab(tab: string): boolean {
  return MESH_ONLY_NOTICE_TABS.has(tab);
}

/**
 * The inline notice copy for a notice-tab on a mesh-only device, or `null` when
 * the tab is not a notice tab (so callers just fall through to the live tool).
 * Names the capability, states WHY it can't work here, and gives the move-to-
 * private path — never a dead end.
 */
export function meshOnlyNotice(tab: string): { title: string; body: string } | null {
  const noun = NOTICE_NOUNS[tab];
  if (!noun) return null;
  return {
    title: `${noun} isn't available on this device`,
    body:
      `This is a public device running only the MeshCentral agent — it has no ` +
      `Tactical agent behind it, so ${noun.toLowerCase()} can't work here. ` +
      `Move it to private to unlock ${noun.toLowerCase()} (remote control, ` +
      `browser session, screen monitoring, ping/power and stay-awake all live there).`,
  };
}