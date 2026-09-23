# scripts/set-acls.ps1 — harden NTFS ACLs on the clone data directories
# (directive §8 INJECT CHECK 3 on Windows; the Go pipeline sets owner-only
# POSIX modes 0700/0600, which production Windows inherits from these ACLs).
#
#   powershell -ExecutionPolicy Bypass -File scripts\set-acls.ps1
#
# After this, only SYSTEM and Administrators can traverse staged clones,
# audit logs and the clone registry area; interactive users get nothing.

$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'set-acls.ps1 must run elevated (Administrator).'
}

$dirs = @(
    'C:\ProgramData\TacticalRMM\Clones',
    'C:\ProgramData\TacticalRMM\audit',
    'C:\ProgramData\TacticalRMM\CloneRegistry'
)
foreach ($d in $dirs) {
    New-Item -ItemType Directory -Force -Path $d | Out-Null
}

foreach ($d in $dirs) {
    # Disable inheritance, drop existing ACEs, then grant admin+system only.
    icacls $d /inheritance:r `
        /grant 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' | Out-Null
    Write-Host "acl hardened: $d"
}

Write-Host 'done. Interactive users have no access to clone data.'
