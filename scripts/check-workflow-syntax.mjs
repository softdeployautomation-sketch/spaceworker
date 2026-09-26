#!/usr/bin/env node
/**
 * Validate the shell inside GitHub Actions `run:` blocks.
 *
 * Why this exists (live incident, 2026-09-25): a manual production deploy died
 * with exit 2 mid-run. The deploy step passed a long remote script to `ssh` as a
 * single-quoted ARGUMENT, and three apostrophes in the prose COMMENTS inside it
 * ("venv's", "bin/pip's") were parsed as quote delimiters — inside a single-quoted
 * string a `#` comment is not a comment, it is literal text. The string closed
 * early, so the pip install and the worker start executed ON THE GITHUB RUNNER
 * ("sudo: unknown user trmm"), and the trailing quote opened an unterminated
 * string. Result: `unexpected EOF while looking for matching '` at script line 60,
 * exit 2, extraction-worker left stopped, and the step AFTER it never ran.
 *
 * GitHub writes each `run:` block to a temp .sh and hands it to bash — so THAT is
 * what executes. `tsc` never sees it, `npm run build` never sees it, and the YAML
 * itself stays perfectly valid. Nothing in CI was capable of catching it.
 *
 * This script extracts every `run:` block the same way YAML's block-scalar rule
 * does (strip the block's own common indentation) and runs `bash -n` on the
 * result. A non-zero `bash -n` fails the build, long before any deploy starts.
 *
 * No dependencies, deliberately: block scalars are indentation-based, so the
 * dedent below is both sufficient and faithful for `run: |` / `run: >`.
 *
 * usage: node scripts/check-workflow-syntax.mjs [file-or-dir ...]
 *        (default: .github/workflows)
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_DIR = ".github/workflows";

function collectFiles(targets) {
  const out = [];
  for (const t of targets.length ? targets : [DEFAULT_DIR]) {
    if (!fs.existsSync(t)) continue;
    const stat = fs.statSync(t);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(t).sort()) {
        if (/\.ya?ml$/.test(name)) out.push(path.join(t, name));
      }
    } else {
      out.push(t);
    }
  }
  return out;
}

/**
 * The shell a `run:` block executes under. Walking back to the enclosing step
 * list item is enough here: GitHub only runs `run:` blocks through a shell, and
 * `shell:` (if set) appears within the same step. PowerShell steps must NOT be
 * fed to `bash -n`, so they are skipped rather than mis-reported.
 */
function stepShell(lines, runIdx) {
  const indentOf = (s) => s.length - s.trimStart().length;
  const runIndent = indentOf(lines[runIdx]);
  for (let k = runIdx - 1; k >= 0; k--) {
    const l = lines[k];
    if (l.trim() === "") continue;
    const item = /^(\s*)-\s/.exec(l);
    if (item && item[1].length < runIndent) {
      for (let n = k; n <= runIdx; n++) {
        const s = /^\s*(?:-\s+)?shell:\s*(\S+)/.exec(lines[n]);
        if (s) return s[1].replace(/^["']|["']$/g, "");
      }
      return null;
    }
  }
  return null;
}

function isBashShell(shell) {
  return shell === null || /^(bash|sh)$/i.test(shell);
}

/**
 * Return the `run:` scripts from one workflow file, as bash would receive them.
 * `name` is only used for the report; `line` is the 1-based YAML line the block
 * starts on, so a failure points at the real file.
 */
function extractRunBlocks(lines) {
  const blocks = [];
  const openRe = /^(\s*)(?:-\s+)?run:\s*([|>])([-+]?\d*)\s*$/;
  const inlineRe = /^(\s*)(?:-\s+)?run:\s*(\S.*)$/;

  for (let i = 0; i < lines.length; i++) {
    const shell = stepShell(lines, i);
    const m = openRe.exec(lines[i]);
    if (!m) {
      const inl = inlineRe.exec(lines[i]);
      // A single-line `run: cmd` is a one-line script; check it too. Skip YAML
      // flow forms (e.g. `run: [a, b]`) and any `run:` that is a mapping key.
      if (inl && !inl[2].startsWith("[") && !inl[2].startsWith("{")) {
        blocks.push({ line: i + 1, shell, script: inl[2].trim() + "\n" });
      }
      continue;
    }

    const parentIndent = m[1].length;
    const body = [];
    let j = i + 1;
    let blockIndent = null;
    for (; j < lines.length; j++) {
      const raw = lines[j];
      if (raw.trim() === "") {
        body.push("");
        continue;
      }
      const indent = raw.length - raw.trimStart().length;
      if (blockIndent === null) {
        // A block scalar must be MORE indented than its `run:` key; anything
        // at or below the key's own indent ends the block.
        if (indent <= parentIndent) break;
        blockIndent = indent;
      } else if (indent < blockIndent) {
        break;
      }
      body.push(raw.slice(blockIndent));
    }

    // A folded scalar (`>`) joins lines with spaces; nothing in these workflows
    // uses `>` for shell, but handle it rather than mis-report it.
    const script = m[2] === ">" ? body.join(" ").replace(/\n+$/, "") + "\n" : body.join("\n");
    blocks.push({ line: i + 1, shell, script });
    i = j - 1;
  }
  return blocks;
}

let checked = 0;
let skipped = 0;
const failures = [];

for (const file of collectFiles(process.argv.slice(2))) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const blocks = extractRunBlocks(lines);
  for (const { line, shell, script } of blocks) {
    if (!script.trim()) continue;
    // PowerShell/compat steps are not bash — `bash -n` on them would be a
    // false alarm, so they are counted and skipped, not validated.
    if (!isBashShell(shell)) {
      skipped++;
      continue;
    }
    checked++;
    const tmp = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "wf-syntax-")),
      "step.sh",
    );
    fs.writeFileSync(tmp, script);
    const res = spawnSync("bash", ["-n", tmp], { encoding: "utf8" });
    if (res.status !== 0) {
      failures.push({
        file,
        line,
        // bash names the temp file; say the real location instead.
        detail: (res.stderr || "").replaceAll(tmp, "<run block>").trim(),
      });
    }
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  }
}

if (failures.length) {
  console.error(
    `\nworkflow shell syntax: ${failures.length} of ${checked} run: block(s) are NOT valid bash.`,
  );
  for (const f of failures) {
    console.error(`\n  ${f.file}:${f.line}`);
    for (const l of f.detail.split("\n")) console.error(`    ${l}`);
  }
  console.error(
    "\nGitHub hands each run: block to bash verbatim, so this WILL fail the step." +
      "\nTip: an unbalanced quote is usually a bare apostrophe in a comment that sits" +
      "\ninside a single-quoted ssh argument. Prefer `ssh host 'bash -s' <<'EOF'`," +
      "\nwhere a quoted heredoc makes the whole body literal and quote-proof.\n",
  );
  process.exit(1);
}

console.log(
  `workflow shell syntax: ${checked} run: block(s) valid bash` +
    (skipped ? ` (${skipped} non-bash block(s) skipped).` : "."),
);
