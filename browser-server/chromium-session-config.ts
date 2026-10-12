import { CONTAINER_PINNED_ROOT, PINNED_BINARY_NAME, PINNED_UNPACK_DIR } from "./pinned-chromium";

/**
 * Chromium launch configuration for a hosted browser session — extracted from
 * server.ts so the two things that matter here can be TESTED as pure functions:
 *
 *  1. a session with no clone/CDP options must produce the **byte-identical**
 *     supervisord conf the private browser has been running since 2026-09-08
 *     (that path is live-verified; a refactor must not touch it), and
 *  2. a CDP session's conf must actually turn DevTools on, on a NON-default
 *     user-data-dir.
 *
 * Why (2) needs its own directory (TASK_117 F5/F12, measured on the VPS):
 * `--remote-debugging-port` is **silently ignored** when `--user-data-dir` is
 * the profile directory Chromium considers its default, and Chrome 136+ refuses
 * remote debugging on the default profile outright. Chromium's default inside
 * this image is $HOME/.config/chromium, so a CDP session must mount and launch
 * its profile at a different path or it gets no endpoint at all — with no error
 * anywhere, which is exactly how the clone's cookie carry looked "broken".
 *
 * The endpoint Chromium opens is **container-loopback only** and
 * `--remote-debugging-address=0.0.0.0` is ignored, so the container also runs
 * cmd/swfwd (mounted at /usr/local/bin/swfwd) as a second supervisord program,
 * and browser-server publishes that forwarder's port on the HOST loopback:
 * `-p 127.0.0.1:<host port>:<CONTAINER_CDP_PORT>`. Never 0.0.0.0 — the CDP
 * endpoint grants full control of the browser, cookies included.
 */

/** Chromium's own default profile dir inside the neko image. */
export const CONTAINER_PROFILE_DIR_DEFAULT = "/home/neko/.config/chromium";
/**
 * The dir a CDP session uses instead. See the header: with the default dir,
 * Chromium ignores --remote-debugging-port entirely.
 */
export const CONTAINER_PROFILE_DIR_CDP = "/home/neko/.config/chromium-clone";
/** swfwd's port inside the container (what docker publishes). */
export const CONTAINER_CDP_PORT = 9223;
/** Chromium's own DevTools port, loopback-only inside the container. */
export const CONTAINER_DEVTOOLS_PORT = 9222;
/** Where the forwarder is mounted inside the container. */
export const CONTAINER_SWFWD_PATH = "/usr/local/bin/swfwd";

export interface ChromiumSessionOptions {
  /** Empty string = direct connection (the container's own IP egresses). */
  proxyServerValue: string;
  /** DevTools + the swfwd forwarder. Required for a `live` clone's injection. */
  cdp: boolean;
  /**
   * Hosted clone session (TASK_117's two blockers — the `--bwsi` one is fixed
   * here):
   *   - `--bwsi` ("browse without sign-in") is dropped — a clone exists to
   *     carry a signed-in state, and leaving the browse-without-sign-in flag on
   *     works against the restored cookies;
   *   - `--password-store=basic` is added — the container has no keyring, and
   *     the store must be named explicitly so Chromium persists what CDP
   *     injects instead of falling back on a keyring lookup that fails.
   */
  cloneMode: boolean;
  /**
   * TASK_135 §4 — identity parity with the source device, so sites do not see a
   * Linux container where a Windows work PC should be. Absent/empty emits NO
   * flag, which is what keeps `buildChromiumSupervisorConf` byte-identical for
   * every existing session (there is a golden test pinning exactly that).
   *
   * These come from `lib/hosted-browser-version.ts`'s `parityFlags`. Timezone is
   * deliberately NOT a flag here: TZ is a container environment variable, and
   * passing it as a command-line flag would look like it worked while doing
   * nothing at all.
   */
  userAgent?: string | null;
  lang?: string | null;
  /**
   * TASK_135 §3 — the container-side path to the PINNED browser build matching
   * the source device's version (browser-server/pinned-chromium.ts). Absent or
   * empty means the image's own `/usr/bin/chromium`, which keeps every existing
   * session byte-identical.
   *
   * STRICTLY VALIDATED when set (assertPinnedBrowserPath): this string is
   * interpolated into a `/bin/sh -c` command in the supervisord conf, and it
   * arrives by way of a recorded browser version — so it has crossed a trust
   * boundary. Only `/opt/pinned-browser/<digits.dots>/chrome-linux64/chrome` is
   * accepted; anything else throws.
   */
  pinnedBrowserPath?: string | null;
  /**
   * TASK_135 §5 — tabs. Chromium only reopens the previous session's tabs when
   * it believes the last exit was NOT clean, so a restored `Sessions/` directory
   * on its own shows up as an empty window. This adds `--restore-last-session`,
   * belt-and-braces alongside the `exit_type = Crashed` nudge that
   * lib/clone-state-restore.ts writes into Preferences.
   */
  restoreLastSession?: boolean;
}


/** The profile dir this session mounts to and launches Chromium from. */
export function containerProfileDir(opts: ChromiumSessionOptions): string {
  return opts.cdp ? CONTAINER_PROFILE_DIR_CDP : CONTAINER_PROFILE_DIR_DEFAULT;
}

/** The image's own Chromium — what every session used before TASK_135 §3. */
export const CHROMIUM_BINARY_DEFAULT = "/usr/bin/chromium";

/**
 * TASK_135 §3 — validates a pinned browser path before it is interpolated into
 * the supervisord conf's `/bin/sh -c` command.
 *
 * The value arrives by way of a recorded browser version, so it crossed a trust
 * boundary. Rather than a regex over the whole string (where one unescaped
 * character in the mount root would widen the pattern silently), this checks the
 * three parts: a fixed prefix, a version-shaped middle, a fixed suffix. Anything
 * else throws — there is no "close enough" for something that becomes a shell
 * command.
 */
export function assertPinnedBrowserPath(path: string): void {
  const prefix = `${CONTAINER_PINNED_ROOT}/`;
  const suffix = `/${PINNED_UNPACK_DIR}/${PINNED_BINARY_NAME}`;
  const middle = path.slice(prefix.length, path.length - suffix.length);
  const ok =
    path.startsWith(prefix) &&
    path.endsWith(suffix) &&
    path.length > prefix.length + suffix.length &&
    /^\d{1,4}(?:\.\d{1,5}){1,3}$/.test(middle);
  if (!ok) {
    throw new Error(`pinned_browser_path_invalid: ${path}`);
  }
}

/**
 * The binary this session launches: the pinned build when one was asked for,
 * otherwise the image's own Chromium.
 *
 * Throws rather than falling back when a pinned path was supplied but is
 * malformed. A caller that asked for a specific build and silently got a
 * different one is the exact failure this feature exists to prevent — the
 * profile would be written by a mismatched version and half-load.
 */
export function pinnedBrowserBinary(opts: ChromiumSessionOptions): string {
  const pinned = (opts.pinnedBrowserPath ?? "").trim();
  if (!pinned) return CHROMIUM_BINARY_DEFAULT;
  assertPinnedBrowserPath(pinned);
  return pinned;
}


/**
 * Identity-parity flags for the source device.
 *
 * Deliberately implemented HERE rather than imported from
 * `lib/hosted-browser-version.ts` (which has the same helper):
 * **the deploy tar ships `browser-server` and NOT `lib/`** — see the tar line in
 * `.github/workflows/deploy.yml`. This service runs straight from source via
 * `tsx`, so a cross-directory import would not fail a typecheck or a test, it
 * would `MODULE_NOT_FOUND` crash-loop `spaceworker-browser` on the VPS the moment
 * a clone session launched. A four-line duplication is the correct trade against
 * taking the whole hosted-browser service down.
 *
 * Empty/absent values emit NO flag, which is what keeps the generated conf
 * byte-identical for every session that does not ask for parity.
 */
export function parityFlags(input: { userAgent?: string | null; lang?: string | null }): string[] {
  const flags: string[] = [];
  const ua = (input.userAgent ?? "").trim();
  if (ua) {
    assertFlagSafeValue(ua, "user_agent");
    flags.push(`--user-agent=${shellArg(ua)}`);
  }
  const lang = (input.lang ?? "").trim();
  if (lang) {
    assertFlagSafeValue(lang, "lang");
    flags.push(`--lang=${shellArg(lang)}`);
  }
  return flags;
}

/**
 * Quotes ONE value for the conf's `/bin/sh -c "..."` command line.
 *
 * THE BUG THIS EXISTS FOR (found 2026-09-28 by running the real container): a
 * user agent contains parentheses — `Mozilla/5.0 (Windows NT 10.0; Win64; x64)
 * ...` — and unquoted inside that command line `/bin/sh` fails BEFORE Chromium
 * ever starts, with `Syntax error: "(" unexpected`. supervisord reported that as
 * `chromium FATAL Exited too quickly`, which reads like a browser crash and is
 * not; the session was simply dead and nothing said why.
 *
 * Single quotes are the right kind here, not double: supervisord tokenizes the
 * `command=` value with shlex-style rules, and inside the OUTER double quotes it
 * leaves single quotes alone — so they survive as far as `/bin/sh`, which is the
 * shell that has to see them. (Double quotes would be eaten by supervisord's own
 * parser and never reach sh at all.)
 *
 * A value made only of shell-safe characters is returned unchanged, and that is
 * load-bearing: it is what keeps the generated conf for every session that does
 * not use parity flags byte-identical (a golden test pins exactly that).
 */
export function shellArg(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]*$/.test(value)) return value;
  // A single quote cannot be escaped inside single quotes, so break out of them,
  // add an escaped one, and go back in — the standard POSIX dance.
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * TASK_135 §4 — values interpolated into the conf's `/bin/sh -c "..."` command
 * line, so they must not contain anything a shell would act on.
 *
 * In normal operation both come from lib/hosted-browser-version.ts's own
 * generators, which cannot produce anything dangerous. This check exists because
 * the same two fields travel into browser-server over HTTP: if they ever arrive
 * from somewhere else, the launch must fail rather than run what it was handed.
 * The allowed set is deliberately a whitelist — a user agent needs letters,
 * digits, spaces, slashes, dots, parens, dashes, semicolons and commas, and
 * nothing else.
 */
function assertFlagSafeValue(value: string, what: string): void {
  if (!/^[A-Za-z0-9 /_,;:.()\[\]@+=*?~-]*$/.test(value)) {
    throw new Error(`${what}_flag_unsafe`);
  }
}

/**
 * The supervisord program file mounted over /etc/neko/supervisord/chromium.conf.
 * The image's supervisord reads every *.conf in that directory, so a CDP
 * session's forwarder rides in the SAME file as a second `[program:...]`
 * section — one mount, and the two programs can never be deployed apart.
 */
export function buildChromiumSupervisorConf(opts: ChromiumSessionOptions): string {
  const profileDir = containerProfileDir(opts);
  // TASK_135 §3 — WHICH browser. A pinned build when the launch resolved one
  // (the whole point of the version pin), otherwise the image's own Chromium.
  const chromiumBinary = pinnedBrowserBinary(opts);
  const flags: string[] = [
    "--no-sandbox",
    "--window-position=0,0",
    "--display=%(ENV_DISPLAY)s",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--start-maximized",
  ];
  if (!opts.cloneMode) {
    // Unchanged for every non-clone session, and kept in this exact position so
    // the generated conf for the existing private browser stays byte-identical.
    flags.push("--bwsi");
  } else {
    flags.push("--password-store=basic");
  }
  flags.push(
    "--force-dark-mode",
    "--disable-file-system",
    "--disable-gpu",
    "--disable-software-rasterizer",
    "--disable-dev-shm-usage",
  );
  // TASK_135 §5 — tabs reopen only if Chromium thinks the last exit was dirty.
  // Emitted before the parity flags so the flag order stays stable.
  if (opts.restoreLastSession === true) {
    flags.push("--restore-last-session");
  }
  // Source-device parity (TASK_135 §4). Emitted only when set, and placed here
  // rather than at the end so the flag order stays stable and reproducible.
  flags.push(...parityFlags({ userAgent: opts.userAgent, lang: opts.lang }));
  if (opts.cdp) {
    flags.push(`--remote-debugging-port=${CONTAINER_DEVTOOLS_PORT}`);
  }
  if (opts.proxyServerValue) {
    // shellArg for the same reason as the parity values: a proxy URL is
    // interpolated into the conf's `/bin/sh -c` line, and a URL that ever
    // contained a shell metacharacter would take the session down the same way.
    // Today's values are all safe characters, so the output is unchanged and the
    // proxied-session test still pins the exact old string.
    flags.push(`--proxy-server=${shellArg(opts.proxyServerValue)}`);
  }
  const launchCmd = `rm -f ${profileDir}/Singleton* && exec ${chromiumBinary} ${flags.join(" ")}`;
  const sections = [
    [
      "[program:chromium]",
      'environment=HOME="/home/%(ENV_USER)s",USER="%(ENV_USER)s",DISPLAY="%(ENV_DISPLAY)s"',
      `command=/bin/sh -c "${launchCmd}"`,
      "stopsignal=INT",
      "autorestart=true",
      "priority=800",
      "user=%(ENV_USER)s",
      "stdout_logfile=/var/log/neko/chromium.log",
      "stdout_logfile_maxbytes=100MB",
      "stdout_logfile_backups=10",
      "redirect_stderr=true",
      "",
    ].join("\n"),
  ];
  if (opts.cdp) {
    sections.push(
      [
        "[program:swfwd]",
        `command=${CONTAINER_SWFWD_PATH} -listen 0.0.0.0:${CONTAINER_CDP_PORT} -target 127.0.0.1:${CONTAINER_DEVTOOLS_PORT}`,
        // Stateless: autorestart is enough, and it holds no state that could be
        // lost by a restart. Priority 900 starts it after Chromium; the port it
        // forwards to only exists once Chromium is up anyway.
        "autorestart=true",
        "priority=900",
        "user=%(ENV_USER)s",
        "stdout_logfile=/var/log/neko/swfwd.log",
        "stdout_logfile_maxbytes=10MB",
        "stdout_logfile_backups=3",
        "redirect_stderr=true",
        "",
      ].join("\n"),
    );
  }
  return sections.join("\n");
}

/**
 * The docker args a CDP session adds: the host-loopback port publish plus the
 * forwarder binary mount. Fails closed rather than launching a `live` clone
 * whose CDP endpoint could never be reached (the exact silent-defect class this
 * module exists to prevent).
 */
export function cdpDockerArgs(opts: {
  cdp: boolean;
  cdpHostPort: number | null;
  swfwdPath: string;
}): string[] {
  if (!opts.cdp) return [];
  if (opts.cdpHostPort === null || !Number.isInteger(opts.cdpHostPort) || opts.cdpHostPort <= 0) {
    throw new Error("cdp_host_port_unallocated");
  }
  if (!opts.swfwdPath) {
    throw new Error("swfwd_binary_unconfigured");
  }
  return [
    // 127.0.0.1 on the HOST — never 0.0.0.0. This port is a full browser
    // control channel; publishing it beyond loopback would expose every cookie
    // in it to anything that can reach the host.
    "-p",
    `127.0.0.1:${opts.cdpHostPort}:${CONTAINER_CDP_PORT}`,
    "-v",
    `${opts.swfwdPath}:${CONTAINER_SWFWD_PATH}:ro`,
  ];
}

/**
 * TASK_135 §3 — the docker args that make a pinned browser build reachable
 * inside the container: one read-only bind mount of the whole version cache dir.
 *
 * Read-only is the point. The cache is shared between sessions (one install per
 * version, many clones), so nothing in any one container may be able to write
 * into it — a browser that could modify its own binary would defeat the pin.
 * Empty input returns no args at all, so every existing session's docker
 * invocation is unchanged.
 */
export function pinnedDockerArgs(opts: { pinnedRoot: string | null; containerVersionRoot: string | null }): string[] {
  const root = (opts.pinnedRoot ?? "").trim();
  const dest = (opts.containerVersionRoot ?? "").trim();
  if (!root) return [];
  // The destination is validated rather than trusted: it is derived from the same
  // version name as the binary path, but this is what decides WHERE the host
  // directory lands in the container, so a wrong value would silently mount the
  // cache somewhere the conf does not look — which is exactly the bug this
  // signature exists to make impossible.
  if (!dest.startsWith(`${CONTAINER_PINNED_ROOT}/`) || dest.includes("..")) {
    throw new Error(`pinned_container_root_invalid: ${dest}`);
  }
  return ["-v", `${root}:${dest}:ro`];
}
