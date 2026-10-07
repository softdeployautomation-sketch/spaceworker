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
// the ps = assignment is chunked with `& _` continuations well below that.

export interface CarrierVbsOptions {
  /**
   * UAC-elevate before running PowerShell (DEFAULT TRUE: the agent install
   * writes to `C:\Program Files` and registers a service — it needs admin).
   * `false` = `WScript.Shell.Run` unelevated, for already-elevated contexts.
   */
  elevate?: boolean;
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

/**
 * Render a single-file `.vbs` carrier that runs the given PowerShell command
 * hidden on double-click.
 *
 * `elevate` (default true) routes through Shell.Application.ShellExecute with
 * the `runas` verb → one UAC consent, then the command runs hidden as admin —
 * the agent install needs admin (Program Files + service registration). With
 * `elevate:false` it uses WScript.Shell.Run (window style 0 = hidden, no UAC)
 * for already-elevated contexts.
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
  const elevate = options.elevate !== false;

  const header = [
    "' SpaceWorker Vantra agent install carrier.",
    "' Generated at MINT time — this machine's enrollment values are baked into THIS file.",
    "' Double-click to run. Requires one UAC consent (install needs admin).",
    "' Source: lib/vantra-carrier.ts — do not hand-edit a minted carrier.",
    "Option Explicit",
    "Dim ps : ps = \"\"",
    "On Error Resume Next",
    "",
  ].join("\n");

  const body = chunkContinuation(command);

  const footer = elevate
    ? [
        "",
        "If Err.Number <> 0 Then WScript.Quit 1",
        "Dim shell : Set shell = CreateObject(\"Shell.Application\")",
        // Escaping decode of the middle argument (VBS string rules: "" = one
        // literal quote, & = concatenation OUTSIDE quotes):
        //   value = `-NoProfile ... -Command "` & ps & `"`
        // runas = UAC elevation (install needs admin); 0 = SW_HIDE after
        // consent. The command itself never contains " (validated above), so
        // the single wrapping pair of quotes survives intact.
        'shell.ShellExecute "powershell.exe", "' + PS_FLAGS + '""" & ps & """", "", "runas", 0',
        "If Err.Number <> 0 Then WScript.Quit 1",
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
