# TASK_177 — OpenFrame one-click carrier (FEASIBILITY FIRST, 2026-10-07)

Owner: tested OpenFrame RMM on a free account (willing to pay/license). It
issues a per-device PowerShell one-liner and offers no EXE/MSI download.
A customer asked for a single-click agent connection. Question: can that
command be bound as an EXE/MSI/VBS that runs silently on one click and
can later be code-signed?

SECRET HYGIENE (binding): the pasted script contains live initialKey,
orgId, userId, machine-id values. NEVER paste them into a doc, test,
log, or committed file. All work uses REDACTED placeholders (<SERVER>,
<ORG>, <USER>, <KEY>, <MACHINE>). Recommend the owner ROTATE the
exposed key after this task (it was pasted into chat).

## 1. THE GATE (pass/fail for the whole task)

Prove the OpenFrame command can be bound + run DYNAMICALLY per customer
on one click. ONE carrier whose per-customer values (serverUrl,
initialKey, orgId, userId, machine-id) are supplied AT MINT TIME per
link/customer, NOT baked once at build time.

PASS: mint twice with different placeholder sets, show the diff, both
run the RIGHT values silently on a Windows VM (or owner hardware).
FAIL = static bake: one EXE with one device key compiled in. If only
static works, STOP, report FAIL, do not build further.
## 2. What exists today (verified 2026-10-07, not assumed)

- Generator builds branded EXE carriers: build-exe.sh compiles
  msi-builder/src/launcher.c (MinGW) with an embedded launcher.vbs
  RCDATA resource into installer.exe (requireAdministrator manifest,
  wscript hidden run). VBS template downloads + msiexec /quiet.
- Generator mints silent PS-bridge .lnk carriers (TASK_176 live).
- Code-signing exists on paper only: msi-builder/signing/SIGNING.md
  (OV vs EV, osslsigncode on operator machine). NOTHING signed today.
- OpenFrame command shape (redacted): Set-Location ~; Invoke-WebRequest
  -Uri 'https://<SERVER>/v0/api/assets/download?agent=client' -Headers
  @{ 'x-machine-id' = '<MACHINE>' }; Expand-Archive; & client install
  --serverUrl <SERVER> --initialKey <KEY> --orgId <ORG> --userId <USER>

## 3. Feasibility spike (FIRST, before any carrier build)

1. Classify the values: mint two device scripts on the dashboard, diff
   them. Which are per-device vs per-org vs per-user? If all per-device
   single-use, the carrier MUST accept values at run/mint time.
2. Probe the manual path to OUR platform: can the same carrier shape
   run OUR install command instead of OpenFrame's (stopgap not fork)?
3. Pick the carrier (ranked): (a) VBS-to-EXE via existing build-exe.sh
   (cheapest, VBS text per-mint dynamic); (b) PS-bridge .lnk + zip
   (proven, but keeps the zip); (c) MSI via build.sh/wixl (heaviest,
   only if customer needs MSI now).
4. Sign reality check: unsigned WILL SmartScreen-warn first run. Does
   the customer tolerate one Unknown-Publisher prompt until the cert
   lands? Report effort + lead time, never buy anything.

## 4. Build ONLY if gate passes (additive, no migration)

- New generator input: OpenFrame params per mint; NEVER log or persist
  plaintext beyond job TTL (same posture as authToken today).
- Reuse build-exe.sh + launcher.c unchanged; new template file
  (openframe-install.vbs.template), never edit the MSI one.
- SpaceWorker/Vantra UI: NOTHING until spike passes. UI is follow-up.

## 5. Verify

- Two redacted value-sets, two renders, diff shows ONLY values differ;
  both run right on Windows VM (or exact break: UAC/Policy/Defender).
- osslsigncode dry-run shape documented; state unsigned UX precisely.
- Regressions: generator tsc, TASK_176 proofs green, suites untouched.

## 6. Out of scope

- No cert purchase, no keys in repo, no OpenFrame automation.
- No grant fix (0c), no W6, no tier split — queued BEHIND this per
  owner 2026-10-07 priority. NOT the grant. TASK_133 untouched.

Sized RESEARCH-SMALL (spike) + SMALL build only if PASS.
