import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_AGENT_LABEL,
  buildHideAgentScript,
  buildRevealAgentScript,
  isValidAgentLabel,
} from "../lib/agent-visibility";

// TASK_103 MISSING-3 — the Hide/Reveal builders, after the 2026-09-27 leak fix.
//
// WHY THIS FILE EXISTS: Hide was already covered by tests, and they passed — but
// they asserted the STEPS the script performs, never what a local user SEES. A
// walk of the real device (VM `sc`/`myrat`) then showed two live leaks:
//
//   LEAK 1 — only `DisplayName` was renamed, so services.msc still read
//            "TacticalRMM Agent Service" in the Description column of the very
//            row whose name had become "Microsoft System Services".
//   LEAK 2 — only `HKLM\...\Uninstall\*` was swept, so the Tactical uninstall
//            entry in the WOW6432Node twin kept `SystemComponent` unset and sat
//            in Settings → Apps as "Tactical RMM Agent" — the owner's words,
//            "why is the name showing tactical rmmmicrosoft".
//
// These tests are the standing guard for both. They assert the built PowerShell
// names the Description, reaches BOTH hives, and that Reveal is its inverse.
// The unit under test is the REAL module (imported directly — it is client-safe
// by design, no `server-only`, no DB/Vantra dependency to swap), and nothing
// here touches a device.

// The two hives an uninstall entry can live in. Both MUST appear in both
// builders — that is the whole of LEAK 2's fix.
const HIVE_64 =
  "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
const HIVE_WOW =
  "HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall";

// Ground truth, read off the real device BEFORE Hide ever wrote to it.
const GROUND_TRUTH_DESCRIPTIONS: Record<string, string> = {
  tacticalrmm: "TacticalRMM Agent Service",
  "Mesh Agent": "Mesh Agent background service",
};

test("hide writes the service Description, not just the DisplayName (LEAK 1)", () => {
  const script = buildHideAgentScript(DEFAULT_AGENT_LABEL);

  // The Description lives on the service's own key and must be written there —
  // Set-Service has no parameter for it.
  assert.ok(
    script.includes(
      "Set-ItemProperty -Path ($svcKey + $s.Name) -Name 'Description' -Value $label -Type String",
    ),
    "hide must write the service Description on the service registry key",
  );
  // `$svcKey` must actually be defined by the prelude, or that write is a
  // runtime error on the device rather than the intended fix.
  assert.ok(
    script.includes("$svcKey = 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\'"),
    "the prelude must define $svcKey for the Description write to target",
  );
  // It is the SAME validated label as the DisplayName — no second, unvalidated
  // piece of text is introduced into the script.
  assert.ok(script.includes("$label = 'Microsoft System Services'"));
  assert.ok(script.includes("STEP:redescribe:' + $s.Name + ' OK"));
});

test("hide sweeps BOTH uninstall hives (LEAK 2)", () => {
  const script = buildHideAgentScript(DEFAULT_AGENT_LABEL);

  assert.ok(script.includes(`'${HIVE_64}'`), "the 64-bit hive must be swept");
  assert.ok(
    script.includes(`'${HIVE_WOW}'`),
    "the WOW6432Node hive must be swept — the Tactical entry lives here",
  );
  assert.ok(script.includes("foreach ($root in $roots)"));
  assert.ok(script.includes("SystemComponent' -Value 1 -Type DWord"));
});

test("hide can never regress to the single-hive form that caused LEAK 2", () => {
  const script = buildHideAgentScript(DEFAULT_AGENT_LABEL);
  // The old bug was one hardcoded `$base` pointing at the 64-bit hive only.
  assert.ok(
    !script.includes("$base = "),
    "the single-hive $base variable IS the LEAK 2 bug — it must not return",
  );
});

test("hide still reports exactly one SKIP when no uninstall entry matches", () => {
  const script = buildHideAgentScript(DEFAULT_AGENT_LABEL);
  // Per-hive SKIPs would double-report on a box with neither entry; the $hits
  // counter preserves the original single-line contract.
  assert.equal(
    script.split("STEP:hide_uninstall SKIP:no matching uninstall key").length - 1,
    1,
  );
  assert.ok(script.includes("if ($hits -eq 0)"));
});

test("hide still renames the DisplayName and keeps the honesty note", () => {
  const script = buildHideAgentScript(DEFAULT_AGENT_LABEL);
  assert.ok(script.includes("Set-Service -Name $s.Name -DisplayName $label"));
  assert.ok(script.includes("$found += $t"));
  assert.ok(script.includes("NOTE: cosmetic only"));
  // The verification pass must report the Description too, since that is
  // precisely what a local user reads in services.msc.
  assert.ok(script.includes("VERIFY:description:"));
});

test("hide rejects an invalid label instead of building a script", () => {
  assert.throws(() => buildHideAgentScript("bad;label"), /agent_label_invalid/);
  assert.throws(() => buildHideAgentScript(""), /agent_label_invalid/);
  assert.equal(isValidAgentLabel(DEFAULT_AGENT_LABEL), true);
  assert.equal(isValidAgentLabel("bad;label"), false);
});

test("hide single-quote-escapes the label (injection safety unchanged)", () => {
  // The regex forbids quotes, so this is belt-and-braces on the builder: a
  // quote-bearing label must be neutralised rather than break out of the
  // PowerShell string it is interpolated into.
  const script = buildHideAgentScript("Valid Label");
  assert.ok(script.includes("$label = 'Valid Label'"));
});

test("reveal restores the byte-exact ground-truth Descriptions (LEAK 1 inverse)", () => {
  const script = buildRevealAgentScript();

  for (const [name, desc] of Object.entries(GROUND_TRUTH_DESCRIPTIONS)) {
    assert.ok(
      script.includes(`${name}:\\"${desc}\\"`) ||
        script.includes(`"${name}":"${desc}"`),
      `reveal must carry the ground-truth Description for ${name} (${desc})`,
    );
  }
  assert.ok(script.includes("$restoreDesc = ConvertFrom-Json"));
  assert.ok(
    script.includes(
      "Set-ItemProperty -Path ($svcKey + $s.Name) -Name 'Description' -Value $wantD -Type String",
    ),
    "reveal must write the Description back, not only the DisplayName",
  );
});

test("reveal sweeps both hives and clears SystemComponent (LEAK 2 inverse)", () => {
  const script = buildRevealAgentScript();

  assert.ok(script.includes(`'${HIVE_64}'`));
  assert.ok(script.includes(`'${HIVE_WOW}'`));
  assert.ok(!script.includes("$base = "));
  assert.ok(script.includes("Remove-ItemProperty"));
  assert.ok(script.includes("STEP:reveal_uninstall:"));
});

test("reveal still restores the recorded DisplayNames", () => {
  const script = buildRevealAgentScript();
  assert.ok(script.includes("TacticalRMM Agent Service"));
  assert.ok(script.includes("$restore = ConvertFrom-Json"));
  assert.ok(script.includes("STEP:rename:' + $s.Name + ' OK:DisplayName="));
});

test("both builders fail closed when the agent service is missing", () => {
  for (const script of [
    buildHideAgentScript(DEFAULT_AGENT_LABEL),
    buildRevealAgentScript(),
  ]) {
    assert.ok(script.includes("FAIL:agent_service_missing"));
    assert.ok(script.includes("exit 1"));
  }
});

test("hide and reveal sweep the hives once, plus one read-only verify pass", () => {
  // Guards against a future edit that nests the hive loop twice and silently
  // doubles every STEP/VERIFY line the UI and these tests read.
  //
  // TWO occurrences per script is correct, and both are needed:
  //   1. the WRITING loop in the action body   -> $keys  (sets SystemComponent)
  //   2. the READ-ONLY loop in verifySuffix()  -> $keys2 (reports what landed)
  // So the guard is on the loop count AND on which loop is which: a nested
  // writing loop would make `$keys = Get-ItemProperty` appear twice.
  const hide = buildHideAgentScript(DEFAULT_AGENT_LABEL);
  const reveal = buildRevealAgentScript();

  assert.equal(hide.split("foreach ($root in $roots)").length - 1, 2);
  assert.equal(reveal.split("foreach ($root in $roots)").length - 1, 2);

  // Exactly one writing loop each — nesting it would make this 2. (`$keys2`
  // does not match this needle; it requires the space that only `$keys =` has.)
  assert.equal(hide.split("$keys = Get-ItemProperty").length - 1, 1);
  assert.equal(reveal.split("$keys = Get-ItemProperty").length - 1, 1);
});

// TASK_148 — REVEAL IS THE INVERSE OF HIDE, NOT A BROADER SWEEP.
//
// Found live on a real device (CSFD-CHECKOUT, 2026-09-30) while exercising the
// new admin remote-viewer tool menu. Reveal's uninstall sweep read
//
//   Where-Object { $_.DisplayName -match 'Tactical|Mesh' -or $_.SystemComponent -ne $null }
//
// while Hide's read
//
//   Where-Object { $_.DisplayName -match 'Tactical|Mesh' }
//
// The `-or $_.SystemComponent -ne $null` tail is not a superset of Hide's
// targets — it is a different set: every programme that hides itself from
// Programs and Features. That box had 82 such entries (Office patches, NVIDIA
// driver components, Adobe, Connection Manager, RDM…) and the run un-hid all 82
// while matching NONE of the agent's own keys (they reported SKIP:already
// visible). So Reveal left a visible footprint on the user's machine — the
// opposite of the silent-monitoring intent — and never touched the agent.
//
// These two tests pin the filters together so the tail cannot return. The unit
// under test is the REAL builder; nothing here touches a device.

/** Every `Where-Object { ... }` clause in a PowerShell string, trimmed. */
function filtersIn(script: string): string[] {
  return [...script.matchAll(/Where-Object \{ ([^}]*)\}/g)].map((m) => m[1].trim());
}

test("neither builder matches uninstall entries by SystemComponent presence (TASK_148)", () => {
  // Asserted on the BUILT POWERSHELL, not on the TypeScript source: this is the
  // text that actually runs on the machine.
  assert.ok(
    !buildRevealAgentScript().includes("$_.SystemComponent -ne $null"),
    "reveal must not sweep by SystemComponent presence — that un-hides " +
      "unrelated programmes and matches no agent key",
  );
  assert.ok(
    !buildHideAgentScript(DEFAULT_AGENT_LABEL).includes("$_.SystemComponent -ne $null"),
    "hide is the reference filter; it must never grow the catch-all either",
  );
});

test("hide and reveal sweep the identical uninstall filter (true inverses)", () => {
  const agentFilters = (script: string) =>
    filtersIn(script).filter((f) => f.includes("Tactical|Mesh"));

  const hide = agentFilters(buildHideAgentScript(DEFAULT_AGENT_LABEL));
  const reveal = agentFilters(buildRevealAgentScript());

  // Two each: the writing sweep and the read-only verify pass.
  assert.equal(hide.length, 2, "hide: one writing filter + one verify filter");
  assert.equal(reveal.length, 2, "reveal: one writing filter + one verify filter");
  assert.deepEqual(
    reveal,
    hide,
    "reveal's uninstall filters must equal hide's, or reveal is not its inverse",
  );
});

test("the verify pass reports only agent entries, not every hidden programme (TASK_148)", () => {
  const verifyLine = buildRevealAgentScript()
    .split("\n")
    .find((l) => l.includes("VERIFY:uninstall:"));
  assert.ok(verifyLine, "the verify pass must report uninstall state");
  assert.ok(
    verifyLine!.includes("Where-Object { $_.DisplayName -match 'Tactical|Mesh' }"),
    "verify must use the same agent filter as the sweeps",
  );
  assert.ok(
    !verifyLine!.includes("-or $_.SystemComponent"),
    "verify must not list unrelated SystemComponent entries as agent state",
  );
});

