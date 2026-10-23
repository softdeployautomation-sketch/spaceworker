// Staleness gate for the PRIVATE-tier PowerShell install command.
//
// The command is minted by Vantra and CACHED on `VantraLink.privatePsCommand`
// (72h token). A deploy that fixes the generator does not rewrite rows already
// stored, so a user can be handed a command from an older generator — which is
// exactly what happened live on 2026-10-22: the cached command used the old
// TRMM flags (`--client/--site/--agenttype --copy --devicedeployment`), the
// agent's `-m install` rejected them, and nothing enrolled while the script
// still printed "installed".
//
// So the VIEW now only exposes a command that is:
//   1. unexpired, and
//   2. minted by the current generator (version marker), and
//   3. shaped for the agent version TRMM serves (`--client-id/--site-id/
//      --agent-type`).
// Anything else reads as "no command yet", and the panel asks for a fresh one.
// PURE (no db/env) so it is unit-tested directly.
export const PRIVATE_PS_MARKER = "# vantra-install v3";

const REQUIRED_FLAGS = ["--client-id", "--site-id", "--agent-type"] as const;

export function isCurrentPrivatePsCommand(
  command: string | null | undefined,
  expiresAt: Date | null | undefined,
  now: Date | number = Date.now(),
): boolean {
  if (!command || !expiresAt) return false;
  const nowMs = now instanceof Date ? now.getTime() : now;
  if (expiresAt.getTime() <= nowMs) return false;
  if (!command.includes(PRIVATE_PS_MARKER)) return false;
  return REQUIRED_FLAGS.every((flag) => command.includes(flag));
}
