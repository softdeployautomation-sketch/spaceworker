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