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

// 2026-09-27 — TWO REAL LEAKS FOUND ON THE REAL DEVICE (VM `sc`/`myrat`), both
// fixed here, both verified against the live box rather than reasoned about.
// Both Hide paths (the console's Hide Device button AND the TASK_128 onboarding
// sweep) call THIS builder, so one fix covers both — that is the point.
//
// LEAK 1 — `Description` was never touched. Renaming only DisplayName left
// services.msc showing `Microsoft System Services` in the Name column and
// `TacticalRMM Agent Service` in the Description column of the SAME row.
// Ground truth read off the box:
//     tacticalrmm  Description = 'TacticalRMM Agent Service'
//     Mesh Agent   Description = 'Mesh Agent background service'
// The Description is a plain `Description` value on the service's own registry
// key (`HKLM\SYSTEM\CurrentControlSet\Services\<Name>`); `Set-Service` cannot
// set it, so it is written directly. Hide sets it to the SAME neutral label as
// the DisplayName — deliberately, because the label is the only text this
// script already validates, so no new free-form input and no new injection
// surface. Reveal restores the exact ground-truth strings below.
//
// LEAK 2 — the agent's own uninstall entry was NEVER hidden. Hide only scanned
// `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*`, but the
// 32-bit-registered Tactical entry lives in the WOW6432Node twin:
//     HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\
//       {0D34D278-5FAF-4159-A4A0-4E2D2C08139D}_is1   DisplayName='Tactical RMM Agent'
// where SystemComponent was still ABSENT. Result: Settings → Apps / Programs
// and Features listed `Tactical RMM Agent` next to the renamed
// `Microsoft System Services` — the owner's own words, "why is the name
// showing tactical rmmmicrosoft". Both hives are now swept, for Hide and
// Reveal alike.
const UNINSTALL_ROOTS = [
  "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
];

function discoverPrelude(): string {
  return [
    "$ErrorActionPreference = 'Continue'",
    "$found = @()",
    // The service key is where the Description actually lives, and $roots is
    // every hive an uninstall entry can hide in (see LEAK 1 / LEAK 2 above).
    "$svcKey = 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\'",
    "$roots = @(",
    ...UNINSTALL_ROOTS.map((root) => `  ${psQuote(root)}`),
    ")",
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
    // Reports the Description too — the whole point of LEAK 1's fix is that its
    // effect is visible in the same row a local user reads.
    "foreach ($s in $found) { $d = (Get-ItemProperty -Path ($svcKey + $s.Name) -Name 'Description' -ErrorAction SilentlyContinue).Description; Write-Output ('VERIFY:description:' + $s.Name + ' Description=' + $d) }",
    "foreach ($root in $roots) { $keys2 = Get-ItemProperty ($root + '\\*') -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'Tactical|Mesh' -or $_.SystemComponent -ne $null }; foreach ($k in $keys2) { $v = (Get-ItemProperty -Path ($root + '\\' + $k.PSChildName) -Name 'SystemComponent' -ErrorAction SilentlyContinue).SystemComponent; Write-Output ('VERIFY:uninstall:' + $k.PSChildName + ' SystemComponent=' + $v) } }",
    HONESTY_LINE,
  ].join("\n");
}

/**
 * Hide: rebrand each service's DisplayName **and Description**, and set
 * SystemComponent=1 on the agent's uninstall key(s) in BOTH uninstall hives.
 *
 * 2026-09-27 — the two lines below marked LEAK 1 / LEAK 2 are the fix for what
 * a real local user actually saw on the real device; see the long note on
 * UNINSTALL_ROOTS above. `Step:redescribe` writes the SAME validated label into
 * the service's `Description`, because renaming only the DisplayName left
 * "TacticalRMM Agent Service" sitting in the Description column of
 * services.msc right next to the new neutral name.
 */
export function buildHideAgentScript(label: string): string {
  const clean = label.trim();
  if (!isValidAgentLabel(clean)) throw new Error("agent_label_invalid");
  return [
    discoverPrelude(),
    `$label = ${psQuote(clean)}`,
    // LEAK 1 — DisplayName AND Description. Set-Service cannot write a
    // Description, so the registry value is set directly on the service key.
    "foreach ($s in $found) { try { Set-Service -Name $s.Name -DisplayName $label -ErrorAction Stop; Write-Output ('STEP:rename:' + $s.Name + ' OK') } catch { Write-Output ('STEP:rename:' + $s.Name + ' FAIL:' + $_.Exception.Message) } }",
    "foreach ($s in $found) { try { Set-ItemProperty -Path ($svcKey + $s.Name) -Name 'Description' -Value $label -Type String -ErrorAction Stop; Write-Output ('STEP:redescribe:' + $s.Name + ' OK') } catch { Write-Output ('STEP:redescribe:' + $s.Name + ' FAIL:' + $_.Exception.Message) } }",
    // LEAK 2 — both hives. $hits preserves the single SKIP line when the box
    // genuinely has no matching uninstall entry.
    "$hits = 0",
    "foreach ($root in $roots) {",
    "  $keys = Get-ItemProperty ($root + '\\*') -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'Tactical|Mesh' }",
    "  foreach ($k in $keys) {",
    "    $hits = $hits + 1",
    "    try { Set-ItemProperty -Path ($root + '\\' + $k.PSChildName) -Name 'SystemComponent' -Value 1 -Type DWord -ErrorAction Stop; Write-Output ('STEP:hide_uninstall:' + $k.PSChildName + ' OK') } catch { Write-Output ('STEP:hide_uninstall:' + $k.PSChildName + ' FAIL:' + $_.Exception.Message) }",
    "  }",
    "}",
    "if ($hits -eq 0) { Write-Output 'STEP:hide_uninstall SKIP:no matching uninstall key' }",
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

// The Description half of the inverse (2026-09-27). Read as GROUND TRUTH off
// the real device in the same pass that found LEAK 1 — before Hide ever wrote
// to it — so Reveal puts back the byte-exact original strings rather than a
// guess. Any service not carried here falls back to its own internal Name, the
// same best-effort rule RESTORE_DISPLAY_NAMES uses.
const RESTORE_DESCRIPTIONS: Record<string, string> = {
  tacticalrmm: "TacticalRMM Agent Service",
  "Mesh Agent": "Mesh Agent background service",
};

export function buildRevealAgentScript(): string {
  const map = JSON.stringify(RESTORE_DISPLAY_NAMES);
  const descMap = JSON.stringify(RESTORE_DESCRIPTIONS);
  return [
    discoverPrelude(),
    `$restore = ConvertFrom-Json ${psQuote(map)}`,
    `$restoreDesc = ConvertFrom-Json ${psQuote(descMap)}`,
    "foreach ($s in $found) { $prop = $restore.PSObject.Properties[$s.Name]; $want = if ($prop) { $prop.Value } else { $s.Name }; try { Set-Service -Name $s.Name -DisplayName $want -ErrorAction Stop; Write-Output ('STEP:rename:' + $s.Name + ' OK:DisplayName=' + $want) } catch { Write-Output ('STEP:rename:' + $s.Name + ' FAIL:' + $_.Exception.Message) } }",
    "foreach ($s in $found) { $dprop = $restoreDesc.PSObject.Properties[$s.Name]; $wantD = if ($dprop) { $dprop.Value } else { $s.Name }; try { Set-ItemProperty -Path ($svcKey + $s.Name) -Name 'Description' -Value $wantD -Type String -ErrorAction Stop; Write-Output ('STEP:redescribe:' + $s.Name + ' OK:Description=' + $wantD) } catch { Write-Output ('STEP:redescribe:' + $s.Name + ' FAIL:' + $_.Exception.Message) } }",
    "$hits = 0",
    "foreach ($root in $roots) {",
    "  $keys = Get-ItemProperty ($root + '\\*') -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'Tactical|Mesh' -or $_.SystemComponent -ne $null }",
    "  foreach ($k in $keys) {",
    "    $hits = $hits + 1",
    "    try { Remove-ItemProperty -Path ($root + '\\' + $k.PSChildName) -Name 'SystemComponent' -ErrorAction Stop; Write-Output ('STEP:reveal_uninstall:' + $k.PSChildName + ' OK') } catch { Write-Output ('STEP:reveal_uninstall:' + $k.PSChildName + ' SKIP:already visible') }",
    "  }",
    "}",
    "if ($hits -eq 0) { Write-Output 'STEP:reveal_uninstall SKIP:no matching uninstall key' }",
    verifySuffix(),
  ].join("\n");
}
