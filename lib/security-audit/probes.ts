// TASK_217 D1 — the LAN/WiFi audit probe pack.
//
// Six READ-ONLY probes (P1–P6) that a device owner runs against the network
// THEIR device is on. Philosophy (task doc): "we need to be able to break
// better than someone trying to break us" — every step reports PASS / LEAK /
// INFO through the judging service (lib/security-audit/judge.ts), which is the
// layer that TELLS the owner a leak exists.
//
// Binding safety rules (task doc):
//   1. Read-only probes + single-packet sends only; execution rides the EXISTING
//      gated device-command path (lib/device-tools.runCommandNow) — this module
//      never gains its own execution privileges.
//   2. Secrets never land in evidence: P2 reads the stored WiFi key but emits
//      only length + 2-char prefix, and only ever writes its JSON to stdout —
//      raw netsh output (which contains the key) is captured into variables,
//      never printed. The judge double-scrubs defensively (hard test in D4).
//   3. No third-party probing: P4 sends ONE benign UDP broadcast packet and
//      passively listens for SSDP replies. Neighbor-host scanning/exploitation
//      is Phase 2 (attested lane) and is NOT in this pack.
//   4. tests/security-audit-scope.test.ts statically scans the script this file
//      builds against an attack-tool blocklist — a future edit that adds an
//      attack probe fails the suite until consciously approved.
//
// Documented OUT OF SCOPE (surfaced in the console UI too): deauth / PMKID /
// handshake capture (Windows has no monitor mode), flooding, password spraying,
// any credential attack, active probing of neighbor hosts.

export const AUDIT_PROBE_IDS = ["P1", "P2", "P3", "P4", "P5", "P6"] as const;
export type AuditProbeId = (typeof AUDIT_PROBE_IDS)[number];

// Markers the judge (and this script's ONLY stdout contract) keys on. The agent
// returns raw stdout; everything between the markers is the JSON result array.
export const AUDIT_JSON_BEGIN = "===SW_AUDIT_JSON===";
export const AUDIT_JSON_END = "===SW_AUDIT_END===";

// P1 — WiFi link audit. netsh wlan show interfaces: SSID / BSSID / auth /
// cipher. Captured into variables (netsh output never printed directly).
const P1_SCRIPT = String.raw`try {
  $swIf = netsh wlan show interfaces 2>$null | Out-String
  $swSsid = $null; $swBssid = $null; $swAuth = $null; $swCipher = $null
  foreach ($line in ($swIf -split "[\r\n]+")) {
    if ($line -match '^\s*SSID\s*:\s*(.+)$') { $swSsid = $Matches[1].Trim() }
    elseif ($line -match '^\s*BSSID\s*:\s*(.+)$') { $swBssid = $Matches[1].Trim() }
    elseif ($line -match '^\s*Authentication\s*:\s*(.+)$') { $swAuth = $Matches[1].Trim() }
    elseif ($line -match '^\s*Cipher\s*:\s*(.+)$') { $swCipher = $Matches[1].Trim() }
  }
  $swResults += @{ probe = "P1"; ssid = $swSsid; bssid = $swBssid; auth = $swAuth; cipher = $swCipher }
} catch {
  $swResults += @{ probe = "P1"; error = $_.Exception.Message }
}`;

// P2 — stored-key exposure. The PSK is readable via key=clear — that IS the
// finding ("every device that ever joined holds it"). The VALUE is captured
// into $swKeyVal for length/prefix ONLY and never emitted.
const P2_SCRIPT = String.raw`try {
  if (-not $swSsid) {
    $swResults += @{ probe = "P2"; ssid = $null; keyPresent = $null; keyLength = 0; keyPrefix = ""; note = "no wifi link in use" }
  } else {
    $swProf = netsh wlan show profile name="$swSsid" key=clear 2>$null | Out-String
    $swKeyVal = $null
    if ($swProf -match 'Key Content\s*:\s*(.+)') { $swKeyVal = $Matches[1].Trim() }
    if ($swKeyVal) {
      $swResults += @{ probe = "P2"; ssid = $swSsid; keyPresent = $true; keyLength = $swKeyVal.Length; keyPrefix = $swKeyVal.Substring(0, [Math]::Min(2, $swKeyVal.Length)); note = "" }
    } else {
      $swResults += @{ probe = "P2"; ssid = $swSsid; keyPresent = $false; keyLength = 0; keyPrefix = ""; note = "no recoverable key stored for this profile" }
    }
  }
} catch {
  $swResults += @{ probe = "P2"; error = $_.Exception.Message }
}`;

// P3 — gateway / ARP view. Snapshot of the neighbor table + the default-route
// gateway and its MAC. Oddities (multiple default gateways, unresolvable
// gateway MAC) are judged server-side.
const P3_SCRIPT = String.raw`try {
  $swGw = $null; $swGwCount = 0
  try {
    $swRoutes = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction Stop
    $swGwCount = @($swRoutes).Count
    $swGw = ($swRoutes | Sort-Object RouteMetric | Select-Object -First 1).NextHop
  } catch {}
  $swArp = arp -a 2>$null | Out-String
  $swEntries = @(); $swGwMac = $null
  foreach ($line in ($swArp -split "[\r\n]+")) {
    if ($line -match '^\s*(\d{1,3}(?:\.\d{1,3}){3})\s+([0-9a-f]{2}(?:-[0-9a-f]{2}){5})') {
      $swEntries += @{ ip = $Matches[1]; mac = $Matches[2] }
      if ($swGw -and $Matches[1] -eq $swGw) { $swGwMac = $Matches[2] }
    }
  }
  $swResults += @{ probe = "P3"; gatewayIp = $swGw; gatewayMac = $swGwMac; gatewayCount = $swGwCount; neighborCount = $swEntries.Count; entries = $swEntries }
} catch {
  $swResults += @{ probe = "P3"; error = $_.Exception.Message }
}`;

// P4 — broadcast reach. ONE benign UDP broadcast packet (single send, discard
// port 9, payload is just our marker string), then a PASSIVE 4-second listener
// on the SSDP multicast group for service advertisements. No scanning, no
// flooding: one send, one short listen. This is the owner's "spread broadcast
// info" test, done safely.
const P4_SCRIPT = String.raw`try {
  $swNotes = @()
  $swUdp = New-Object System.Net.Sockets.UdpClient
  try {
    $swUdp.EnableBroadcast = $true
    $swBytes = [System.Text.Encoding]::ASCII.GetBytes("spaceworker-lan-audit-probe")
    [void]$swUdp.Send($swBytes, $swBytes.Length, [System.Net.IPAddress]::Broadcast, 9)
    $swNotes += "broadcast-sent"
  } catch {
    $swNotes += "send-failed"
  } finally {
    $swUdp.Close()
  }
  $swServices = @()
  $swLis = New-Object System.Net.Sockets.UdpClient
  try {
    $swLis.Client.SetSocketOption([System.Net.Sockets.SocketOptionLevel]::Socket, [System.Net.Sockets.SocketOptionName]::ReuseAddress, $true)
    $swLis.Client.Bind((New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Any, 1900)))
    try { $swLis.JoinMulticastGroup("239.255.255.250") } catch {}
    $swLis.Client.ReceiveTimeout = 1000
    $swEnd = (Get-Date).AddSeconds(4)
    while ((Get-Date) -lt $swEnd -and $swServices.Count -lt 5) {
      $swEp = New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Any, 0)
      try {
        $swData = $swLis.Receive([ref]$swEp)
        $swText = [System.Text.Encoding]::ASCII.GetString($swData)
        $swHint = ""
        if ($swText -match 'SERVER:\s*([^\r\n]+)') { $swHint = $Matches[1].Trim() }
        elseif ($swText -match 'ST:\s*([^\r\n]+)') { $swHint = $Matches[1].Trim() }
        elseif ($swText -match 'NOTIFY') { $swHint = "ssdp-notify" }
        if ($swHint -and ($swServices -notcontains $swHint)) { $swServices += $swHint }
      } catch {
        break
      }
    }
  } catch {
    $swNotes += "listen-skip"
  } finally {
    $swLis.Close()
  }
  $swResults += @{ probe = "P4"; sent = $true; services = $swServices; notes = $swNotes }
} catch {
  $swResults += @{ probe = "P4"; error = $_.Exception.Message }
}`;

// P5 — poisoning / relay surface. Four registry/config reads that decide the
// responder-class (LLMNR on = LEAK), relay-class (SMB signing off = LEAK) and
// weak-NTLM (LmCompatibilityLevel <= 2 = LEAK) verdicts in the judge.
const P5_SCRIPT = String.raw`try {
  $swLlmnr = 1
  try { $swLlmnr = (Get-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Services\Dnscache\Parameters" -Name EnableMulticast -ErrorAction Stop).EnableMulticast } catch {}
  $swNodeType = $null
  try { $swNodeType = (Get-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Services\NetBT\Parameters" -Name NodeType -ErrorAction Stop).NodeType } catch {}
  $swSrvSign = $null; $swCliSign = $null
  try { $swSrvSign = (Get-SmbServerConfiguration -ErrorAction Stop).RequireSecuritySignature } catch {}
  try { $swCliSign = (Get-SmbClientConfiguration -ErrorAction Stop).RequireSecuritySignature } catch {}
  $swLm = 3
  try { $swLm = (Get-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\Lsa" -Name LmCompatibilityLevel -ErrorAction Stop).LmCompatibilityLevel } catch {}
  $swResults += @{ probe = "P5"; llmnrEnabled = ($swLlmnr -ne 0); netbiosNodeType = $swNodeType; smbServerSigningRequired = $swSrvSign; smbClientSigningRequired = $swCliSign; lmCompatibilityLevel = $swLm }
} catch {
  $swResults += @{ probe = "P5"; error = $_.Exception.Message }
}`;

// P6 — listening sockets. netstat -an LISTENING lines as INFO (count + a
// bounded sample; the judge renders the "what is exposed" list).
const P6_SCRIPT = String.raw`try {
  $swLines = netstat -an 2>$null | Out-String
  $swListen = @()
  foreach ($line in ($swLines -split "[\r\n]+")) {
    if ($line -match 'LISTENING' -and $line -match '^\s*(TCP|UDP)\s+(\S+)\s+(\S+)') {
      $swListen += @{ proto = $Matches[1]; local = $Matches[2] }
    }
  }
  $swShown = @(); $swI = 0
  foreach ($e in $swListen) { if ($swI -ge 40) { break }; $swShown += $e; $swI++ }
  $swResults += @{ probe = "P6"; count = $swListen.Count; listening = $swShown }
} catch {
  $swResults += @{ probe = "P6"; error = $_.Exception.Message }
}`;

/**
 * The complete audit batch as ONE PowerShell script. Read-only probes plus
 * P4's single benign broadcast send; the ONLY stdout contract is the marker-
 * delimited JSON array assembled at the end. Executed through the existing
 * gated device-command path with a PowerShell shell — the script string is
 * assembled SERVER-side only; the console never ships raw commands for this.
 */
export function buildAuditScript(): string {
  return [
    '$ErrorActionPreference = "SilentlyContinue"',
    "$swResults = @()",
    P1_SCRIPT,
    P2_SCRIPT,
    P3_SCRIPT,
    P4_SCRIPT,
    P5_SCRIPT,
    P6_SCRIPT,
    `Write-Output "${AUDIT_JSON_BEGIN}"`,
    'Write-Output ($swResults | ConvertTo-Json -Depth 6 -Compress)',
    `Write-Output "${AUDIT_JSON_END}"`,
  ].join("\n");
}

