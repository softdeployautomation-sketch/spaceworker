// TASK_103 MISSING-3 — Hide/Reveal agent script builders.
//
// Client-safe (no `server-only`): the console imports the builders, and the
// run-command route imports the label validator for server-side enforcement.
// The ONLY per-device dynamic input is the display `label`; everything else
// is fixed script text. Transport reuses POST /api/devices/[deviceId]/run-command
// (powershell, 90 s timeout) — no new route, no new Vantra action kind.
//
// Intent (owner 2026-09-24): reduce ACCIDENTAL discovery/stop/uninstall by a
// curious local user — NOT a security boundary. A local admin undoes every
// step in seconds; both scripts say so in their own output, and Hide always
// ships with its exact inverse (Reveal).

export const DEFAULT_AGENT_LABEL = "Microsoft System Services";

// Server-enforced (run-command route 400s anything else): 1–80 chars,
// letters/digits/spaces/hyphens only.
export const AGENT_LABEL_RE = /^[A-Za-z0-9 \-]{1,80}$/;

export function isValidAgentLabel(value: unknown): value is string {
  return typeof value === "string" && AGENT_LABEL_RE.test(value.trim());
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const HONESTY_LINE =
  "Write-Output 'NOTE: cosmetic only — a local admin can still stop/reveal/uninstall; use Reveal to undo.'";

function discoverPrelude(): string {
  return [
    "$ErrorActionPreference = 'Continue'",
    "$found = @()",
    "try { $t = Get-Service -Name 'tacticalrmm' -ErrorAction Stop; $found += $t } catch { }",
    "if ($found.Count -eq 0) { Write-Output 'STEP:agent_service FAIL:agent_service_missing'; " + HONESTY_LINE + "; exit 1 }",
    "Write-Output 'STEP:agent_service OK:tacticalrmm'",
    "$mesh = Get-Service -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'Mesh Agent*' -or $_.DisplayName -like 'Mesh Agent*' } | Select-Object -First 1",
    "if ($null -ne $mesh) { $found += $mesh; Write-Output ('STEP:mesh_service OK:' + $mesh.Name) } else { Write-Output 'STEP:mesh_service SKIP:not installed' }",
  ].join("\n");
}

function verifySuffix(): string {
  return [
    "foreach ($s in $found) { $cur = Get-Service -Name $s.Name -ErrorAction SilentlyContinue; if ($cur) { Write-Output ('VERIFY:service:' + $cur.Name + ' DisplayName=' + $cur.DisplayName + ' Status=' + $cur.Status) } }",
    "$base = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'",
    "$keys2 = Get-ItemProperty ($base + '\\*') -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'Tactical|Mesh' }",
    "foreach ($k in $keys2) { $v = (Get-ItemProperty -Path ($base + '\\' + $k.PSChildName) -Name 'SystemComponent' -ErrorAction SilentlyContinue).SystemComponent; Write-Output ('VERIFY:uninstall:' + $k.PSChildName + ' SystemComponent=' + $v) }",
    HONESTY_LINE,
  ].join("\n");
}

/** Hide: rebrand service DisplayName(s) + SystemComponent=1 on the agent's uninstall key(s). */
export function buildHideAgentScript(label: string): string {
  const clean = label.trim();
  if (!isValidAgentLabel(clean)) throw new Error("agent_label_invalid");
  return [
    discoverPrelude(),
    `$label = ${psQuote(clean)}`,
    "foreach ($s in $found) { try { Set-Service -Name $s.Name -DisplayName $label -ErrorAction Stop; Write-Output ('STEP:rename:' + $s.Name + ' OK') } catch { Write-Output ('STEP:rename:' + $s.Name + ' FAIL:' + $_.Exception.Message) } }",
    "$base = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'",
    "$keys = Get-ItemProperty ($base + '\\*') -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'Tactical|Mesh' }",
    "if ($keys) { foreach ($k in $keys) { try { Set-ItemProperty -Path ($base + '\\' + $k.PSChildName) -Name 'SystemComponent' -Value 1 -Type DWord -ErrorAction Stop; Write-Output ('STEP:hide_uninstall:' + $k.PSChildName + ' OK') } catch { Write-Output ('STEP:hide_uninstall:' + $k.PSChildName + ' FAIL:' + $_.Exception.Message) } } } else { Write-Output 'STEP:hide_uninstall SKIP:no matching uninstall key' }",
    verifySuffix(),
  ].join("\n");
}

/**
 * Reveal: the exact inverse. DisplayNames are restored to the values captured
 * as GROUND TRUTH on a real Windows install (2026-09-24, VM `sc\myrat`):
 *   `Get-Service tacticalrmm, "Mesh Agent*"` →
 *     tacticalrmm → "TacticalRMM Agent Service"   (NOT "Tactical Agent")
 *     Mesh Agent  → "Mesh Agent"
 * The earlier hardcoded "Tactical Agent" would have left the service renamed to
 * a name that never existed on the box — the inverse has to restore the real
 * one. Any service we do not carry a recorded name for falls back to its own
 * internal Name (best-effort; the script prints exactly what it set); records
 * are never touched by Hide, so the internal Name is always intact.
 * SystemComponent is removed so the Apps-list entry returns.
 */
const RESTORE_DISPLAY_NAMES: Record<string, string> = {
  tacticalrmm: "TacticalRMM Agent Service",
  "Mesh Agent": "Mesh Agent",
};

export function buildRevealAgentScript(): string {
  const map = JSON.stringify(RESTORE_DISPLAY_NAMES);
  return [
    discoverPrelude(),
    `$restore = ConvertFrom-Json ${psQuote(map)}`,
    "foreach ($s in $found) { $prop = $restore.PSObject.Properties[$s.Name]; $want = if ($prop) { $prop.Value } else { $s.Name }; try { Set-Service -Name $s.Name -DisplayName $want -ErrorAction Stop; Write-Output ('STEP:rename:' + $s.Name + ' OK:DisplayName=' + $want) } catch { Write-Output ('STEP:rename:' + $s.Name + ' FAIL:' + $_.Exception.Message) } }",
    "$base = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'",
    "$keys = Get-ItemProperty ($base + '\\*') -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'Tactical|Mesh' }",
    "if ($keys) { foreach ($k in $keys) { try { Remove-ItemProperty -Path ($base + '\\' + $k.PSChildName) -Name 'SystemComponent' -ErrorAction Stop; Write-Output ('STEP:reveal_uninstall:' + $k.PSChildName + ' OK') } catch { Write-Output ('STEP:reveal_uninstall:' + $k.PSChildName + ' SKIP:already visible') } } } else { Write-Output 'STEP:reveal_uninstall SKIP:no matching uninstall key' }",
    verifySuffix(),
  ].join("\n");
}
