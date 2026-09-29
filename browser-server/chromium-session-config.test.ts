import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import {
  CHROMIUM_BINARY_DEFAULT,
  CONTAINER_CDP_PORT,
  CONTAINER_DEVTOOLS_PORT,
  CONTAINER_PROFILE_DIR_CDP,
  CONTAINER_PROFILE_DIR_DEFAULT,
  CONTAINER_SWFWD_PATH,
  assertPinnedBrowserPath,
  buildChromiumSupervisorConf,
  cdpDockerArgs,
  containerProfileDir,
  pinnedBrowserBinary,
  pinnedDockerArgs,
  shellArg,
} from "./chromium-session-config";
import { CONTAINER_PINNED_ROOT, containerPinnedBinaryPath, containerPinnedVersionRoot } from "./pinned-chromium";

/**
 * GOLDEN TEST. This is the exact string server.ts generated for every session
 * before this module existed (captured from the merged code), with no proxy —
 * the private-browser path that has been live-verified since 2026-09-08. Any
 * change to it is a behaviour change on a working feature.
 */
const GOLDEN_NO_OPTIONS = [
  "[program:chromium]",
  'environment=HOME="/home/%(ENV_USER)s",USER="%(ENV_USER)s",DISPLAY="%(ENV_DISPLAY)s"',
  'command=/bin/sh -c "rm -f /home/neko/.config/chromium/Singleton* && exec /usr/bin/chromium --no-sandbox --window-position=0,0 --display=%(ENV_DISPLAY)s --user-data-dir=/home/neko/.config/chromium --no-first-run --start-maximized --bwsi --force-dark-mode --disable-file-system --disable-gpu --disable-software-rasterizer --disable-dev-shm-usage"',
  "stopsignal=INT",
  "autorestart=true",
  "priority=800",
  "user=%(ENV_USER)s",
  "stdout_logfile=/var/log/neko/chromium.log",
  "stdout_logfile_maxbytes=100MB",
  "stdout_logfile_backups=10",
  "redirect_stderr=true",
  "",
].join("\n");

test("a non-clone session with no proxy generates the unchanged conf", () => {
  const conf = buildChromiumSupervisorConf({
    proxyServerValue: "",
    cdp: false,
    cloneMode: false,
  });
  assert.equal(conf, GOLDEN_NO_OPTIONS);
});

test("parity flags are absent unless asked for, so the golden conf still holds", () => {
  // An existing caller that passes nothing extra (or explicit nulls) must be
  // byte-identical — this is the promise that the live private browser is
  // untouched by the clone work.
  for (const opts of [
    { proxyServerValue: "", cdp: false, cloneMode: false },
    { proxyServerValue: "", cdp: false, cloneMode: false, userAgent: null, lang: null },
    { proxyServerValue: "", cdp: false, cloneMode: false, userAgent: "", lang: "  " },
  ]) {
    assert.equal(buildChromiumSupervisorConf(opts), GOLDEN_NO_OPTIONS);
  }
});

test("parity flags are emitted for a clone that asks for them", () => {
  const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0.0.0 Safari/537.36";
  const conf = buildChromiumSupervisorConf({
    proxyServerValue: "",
    cdp: true,
    cloneMode: true,
    userAgent: ua,
    lang: "en-GB",
  });
  // SINGLE-QUOTED, and that is the fix for a real crash: unquoted, the parens in
  // a user agent make `/bin/sh -c` exit with `Syntax error: "(" unexpected`
  // before Chromium starts, which supervisord reports as `chromium FATAL Exited
  // too quickly`. Found by running the real container on 2026-09-28.
  assert.ok(conf.includes(`--user-agent='${ua}'`), conf);
  assert.ok(!conf.includes(`--user-agent=${ua} `), "an unquoted UA must never be emitted");
  // A language tag is shell-safe, so it stays exactly as it was.
  assert.ok(conf.includes("--lang=en-GB"), conf);
  // They must land BEFORE the DevTools flag, so the order is reproducible.
  assert.ok(conf.indexOf("--lang=en-GB") < conf.indexOf("--remote-debugging-port"), conf);
  // And the clone invariants still hold alongside them.
  assert.ok(!conf.includes("--bwsi"), conf);
  assert.ok(conf.includes("--password-store=basic"), conf);
});

test("shellArg quotes only what a shell would act on", () => {
  // Safe values are untouched — this is what keeps every existing conf identical.
  for (const safe of ["en-GB", "http://172.17.0.1:35555", "--no-sandbox", "0,0", "a_b/c.d-e@f+g=h:i%j"]) {
    assert.equal(shellArg(safe), safe);
  }
  // Anything else is single-quoted, so `/bin/sh` cannot interpret it.
  assert.equal(shellArg("Mozilla/5.0 (Windows NT 10.0; Win64; x64)"), "'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'");
  assert.equal(shellArg("a;b"), "'a;b'");
  assert.equal(shellArg("a$(id)"), "'a$(id)'");
  assert.equal(shellArg("a`id`"), "'a`id`'");
  assert.equal(shellArg("a|b"), "'a|b'");
  // A value containing a single quote breaks out and back in, POSIX-style.
  assert.equal(shellArg("it's"), `'it'\\''s'`);
  // Every quoted result must survive a real `/bin/sh` parse and come back
  // unchanged — asserted by RUNNING sh, not by reasoning about the string.
  for (const value of ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0.0.0 Safari/537.36", "a;b", "it's", "a$(id)"]) {
    const out = execFileSync("/bin/sh", ["-c", `printf '%s' ${shellArg(value)}`], { encoding: "utf8" });
    assert.equal(out, value, `sh must round-trip ${JSON.stringify(value)}`);
  }
});

test("a proxied non-clone session only appends the proxy flag", () => {
  const conf = buildChromiumSupervisorConf({
    proxyServerValue: "http://172.17.0.1:35555",
    cdp: false,
    cloneMode: false,
  });
  assert.equal(
    conf,
    GOLDEN_NO_OPTIONS.replace(
      "--disable-dev-shm-usage\"",
      "--disable-dev-shm-usage --proxy-server=http://172.17.0.1:35555\"",
    ),
  );
  // No forwarder, no DevTools: nothing about the existing path changes.
  assert.ok(!conf.includes("[program:swfwd]"));
  assert.ok(!conf.includes("--remote-debugging-port"));
});

test("a CDP session launches on a NON-default profile dir with DevTools on", () => {
  const opts = { proxyServerValue: "http://172.17.0.1:35555", cdp: true, cloneMode: true };
  const conf = buildChromiumSupervisorConf(opts);

  // F5/F12: on the default dir Chromium ignores --remote-debugging-port.
  assert.equal(containerProfileDir(opts), CONTAINER_PROFILE_DIR_CDP);
  assert.ok(conf.includes(`--user-data-dir=${CONTAINER_PROFILE_DIR_CDP}`));
  assert.ok(!conf.includes(`--user-data-dir=${CONTAINER_PROFILE_DIR_DEFAULT} `));
  assert.ok(conf.includes(`--remote-debugging-port=${CONTAINER_DEVTOOLS_PORT}`));
  // The stale-lock scrub must target the dir actually in use, or a relaunch
  // crash-loops on Chromium's own lock (the 2026-09-08 finding).
  assert.ok(conf.includes(`rm -f ${CONTAINER_PROFILE_DIR_CDP}/Singleton*`));
});

test("a clone session drops --bwsi and names the password store", () => {
  const conf = buildChromiumSupervisorConf({
    proxyServerValue: "",
    cdp: false,
    cloneMode: true,
  });
  assert.ok(!conf.includes("--bwsi"), "--bwsi defeats a carried sign-in state");
  assert.ok(conf.includes("--password-store=basic"));
});

test("a CDP session runs the forwarder as its own program, forwarding loopback only", () => {
  const conf = buildChromiumSupervisorConf({ proxyServerValue: "", cdp: true, cloneMode: true });
  assert.ok(conf.includes("[program:swfwd]"));
  assert.ok(
    conf.includes(
      `command=${CONTAINER_SWFWD_PATH} -listen 0.0.0.0:${CONTAINER_CDP_PORT} -target 127.0.0.1:${CONTAINER_DEVTOOLS_PORT}`,
    ),
  );
  // The forwarder's own listen address is 0.0.0.0 (inside the container, so the
  // published port can reach it) — the HOST publish below is what must be
  // loopback, and that is asserted separately.
  assert.ok(conf.includes("[program:chromium]"));
});

test("the CDP docker args publish on host loopback and mount the forwarder", () => {
  const args = cdpDockerArgs({ cdp: true, cdpHostPort: 33001, swfwdPath: "/opt/sw/bin/swfwd" });
  assert.deepEqual(args, [
    "-p",
    `127.0.0.1:33001:${CONTAINER_CDP_PORT}`,
    "-v",
    `/opt/sw/bin/swfwd:${CONTAINER_SWFWD_PATH}:ro`,
  ]);
  assert.ok(!args.join(" ").includes("0.0.0.0"), "CDP must never be published beyond loopback");
});

test("CDP docker args fail closed when unconfigured", () => {
  assert.throws(() => cdpDockerArgs({ cdp: true, cdpHostPort: null, swfwdPath: "/x" }), /cdp_host_port/);
  assert.throws(() => cdpDockerArgs({ cdp: true, cdpHostPort: 33001, swfwdPath: "" }), /swfwd_binary/);
  // Off is off: no args at all, no throw.
  assert.deepEqual(cdpDockerArgs({ cdp: false, cdpHostPort: null, swfwdPath: "" }), []);
});

// ---------------------------------------------------------------------------
// TASK_135 §3/§5 — the pinned build and the tab restore
// ---------------------------------------------------------------------------

const PINNED_141 = `${CONTAINER_PINNED_ROOT}/141.0.7390.55/chrome-linux64/chrome`;

test("a session without a pinned build still launches the image's own Chromium", () => {
  const conf = buildChromiumSupervisorConf({ proxyServerValue: "", cdp: false, cloneMode: false });
  assert.ok(conf.includes(`exec ${CHROMIUM_BINARY_DEFAULT} `), conf);
  assert.ok(!conf.includes(CONTAINER_PINNED_ROOT), conf);
  // Absent/null/blank all mean the same thing: no pin, unchanged behaviour.
  for (const pinnedBrowserPath of [undefined, null, "", "  "]) {
    assert.equal(
      buildChromiumSupervisorConf({ proxyServerValue: "", cdp: false, cloneMode: false, pinnedBrowserPath }),
      GOLDEN_NO_OPTIONS,
    );
  }
});

test("a pinned build replaces the binary a clone launches", () => {
  const conf = buildChromiumSupervisorConf({
    proxyServerValue: "",
    cdp: true,
    cloneMode: true,
    pinnedBrowserPath: PINNED_141,
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0.0.0 Safari/537.36",
  });
  assert.ok(conf.includes(`exec ${PINNED_141} --no-sandbox`), conf);
  assert.ok(!conf.includes(`exec ${CHROMIUM_BINARY_DEFAULT}`), conf);
  // The clone invariants and the CDP endpoint are unaffected by the pin.
  assert.ok(conf.includes("--remote-debugging-port="));
  assert.ok(!conf.includes("--bwsi"));
});

test("the tab-restore flag is only emitted when asked for", () => {
  const off = buildChromiumSupervisorConf({ proxyServerValue: "", cdp: false, cloneMode: true });
  assert.ok(!off.includes("--restore-last-session"), off);
  const on = buildChromiumSupervisorConf({
    proxyServerValue: "",
    cdp: false,
    cloneMode: true,
    restoreLastSession: true,
  });
  assert.ok(on.includes("--restore-last-session"), on);
  // Order is stable: the base flags first, then restore, so the same inputs
  // always produce the same conf string.
  assert.ok(on.indexOf("--disable-dev-shm-usage") < on.indexOf("--restore-last-session"), on);
});

test("a pinned path that is not exactly a pinned path is refused, never used", () => {
  // Every one of these would end up inside a `/bin/sh -c` command line.
  const bad = [
    "/usr/bin/chromium",
    `${CONTAINER_PINNED_ROOT}/../etc/chrome-linux64/chrome`,
    `${CONTAINER_PINNED_ROOT}/141.0.7390.55/chrome-linux64/chrome; rm -rf /`,
    `${CONTAINER_PINNED_ROOT}/141.0.7390.55/chrome-linux64/chrome \$(id)`,
    `${CONTAINER_PINNED_ROOT}/evil/chrome-linux64/chrome`,
    `${CONTAINER_PINNED_ROOT}/141.0.7390.55/chrome-linux64/not-chrome`,
    `${CONTAINER_PINNED_ROOT}/141.0.7390.55/chrome-linux64/chrome/`,
  ];
  for (const path of bad) {
    assert.throws(() => assertPinnedBrowserPath(path), /pinned_browser_path_invalid/, `must refuse ${path}`);
    assert.throws(
      () => buildChromiumSupervisorConf({ proxyServerValue: "", cdp: true, cloneMode: true, pinnedBrowserPath: path }),
      /pinned_browser_path_invalid/,
      `the conf builder must refuse ${path}`,
    );
  }
  // And the one shape that IS accepted, to prove the check is not simply "always throw".
  assert.doesNotThrow(() => assertPinnedBrowserPath(PINNED_141));
});

test("pinnedBrowserBinary resolves the pin or falls back to the image default", () => {
  assert.equal(pinnedBrowserBinary({ proxyServerValue: "", cdp: false, cloneMode: false }), CHROMIUM_BINARY_DEFAULT);
  assert.equal(
    pinnedBrowserBinary({ proxyServerValue: "", cdp: false, cloneMode: false, pinnedBrowserPath: PINNED_141 }),
    PINNED_141,
  );
  assert.throws(
    () => pinnedBrowserBinary({ proxyServerValue: "", cdp: false, cloneMode: false, pinnedBrowserPath: "/tmp/x" }),
    /pinned_browser_path_invalid/,
  );
});

test("the pinned cache is mounted read-only, and only when there is one", () => {
  const dest = `${CONTAINER_PINNED_ROOT}/141.0.7390.55`;
  assert.deepEqual(pinnedDockerArgs({ pinnedRoot: null, containerVersionRoot: null }), []);
  assert.deepEqual(pinnedDockerArgs({ pinnedRoot: "  ", containerVersionRoot: dest }), []);
  assert.deepEqual(pinnedDockerArgs({ pinnedRoot: "/var/lib/spaceworker/browsers/141.0.7390.55", containerVersionRoot: dest }), [
    "-v",
    `/var/lib/spaceworker/browsers/141.0.7390.55:${dest}:ro`,
  ]);
  // A writable mount would let a container modify the shared build it shares
  // with every other session on that version — the pin would be meaningless.
  const args = pinnedDockerArgs({
    pinnedRoot: "/x/141.0.7390.55",
    containerVersionRoot: dest,
  });
  assert.ok(args.every((a) => !a.endsWith(":rw")));
  // A destination outside the pinned root is refused: it would mount the build
  // somewhere the conf does not look, which is a silently dead session.
  for (const bad of [null, "", "/opt/other", `${CONTAINER_PINNED_ROOT}/../etc`, "/opt/pinned-browser"]) {
    assert.throws(
      () => pinnedDockerArgs({ pinnedRoot: "/x/141.0.7390.55", containerVersionRoot: bad }),
      /pinned_container_root_invalid/,
      `must refuse container root ${String(bad)}`,
    );
  }
});

/**
 * THE TEST THAT WOULD HAVE CAUGHT THE 2026-09-28 BUG.
 *
 * The mount destination and the binary path are produced by two different
 * functions, and each was individually correct while together they described
 * different places — so the conf exec'd a path that did not exist and the real
 * container reported `chromium FATAL Exited too quickly`. This walks the whole
 * chain the way docker and Chromium do: mount the host dir at the destination
 * the docker args name, then ask for the binary the conf names, and assert they
 * are the same path.
 */
test("the pin mount composes with the binary path it execs", () => {
  const dirName = "141.0.7390.55";
  const hostRoot = `/var/lib/spaceworker/browsers/${dirName}`;
  const containerRoot = containerPinnedVersionRoot(dirName);
  const binaryPath = containerPinnedBinaryPath(dirName);

  const args = pinnedDockerArgs({ pinnedRoot: hostRoot, containerVersionRoot: containerRoot });
  assert.deepEqual(args, ["-v", `${hostRoot}:${containerRoot}:ro`]);

  // Everything the conf names must sit ON the mount, at the same relative place.
  assert.ok(
    binaryPath.startsWith(`${containerRoot}/`),
    `binary ${binaryPath} must be inside the mounted dir ${containerRoot}`,
  );
  assert.equal(binaryPath.slice(containerRoot.length + 1), "chrome-linux64/chrome");
  // And the conf that actually gets written must name exactly that binary.
  const conf = buildChromiumSupervisorConf({
    proxyServerValue: "",
    cdp: true,
    cloneMode: true,
    pinnedBrowserPath: binaryPath,
  });
  assert.ok(conf.includes(`exec ${binaryPath} `), conf);
});

test("a pinned path that does not live under a version dir is refused", () => {
  // The container root must carry the version, or the mount and the exec
  // disagree — see the composition test above.
  assert.throws(() => assertPinnedBrowserPath(`${CONTAINER_PINNED_ROOT}/chrome-linux64/chrome`), /pinned_browser_path_invalid/);
});

