'use strict';
// TASK_135 proof harness driver — the SILENT trigger.
//
// Loads the REAL extension service worker (engine/extension/background.js) in
// Node with a stub `chrome`, and proves the three things the owner's hard
// condition depends on:
//
//   1. A capture can start with NO human: onStartup and the alarm both poll the
//      native host, and a "capture_requested" answer runs a real capture;
//   2. Nothing is ever shown: notifications, tabs, windows, badges and injected
//      scripts are all trip-wired and must stay untouched;
//   3. Nothing is ever done twice at once: an overlapping poll must not start a
//      second capture (interleaved chunks would be refused by the host).
//
// Usage: node silent-trigger.driver.cjs <path-to-extension-dir>
// Exits non-zero on the first failed assertion, so the PowerShell wrapper can
// gate on it.
const assert = require('assert');
const path = require('path');

const extDir = process.argv[2];
if (!extDir) {
  console.error('usage: node silent-trigger.driver.cjs <extension dir>');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// The stub. Every UI surface is a trip-wire that RECORDS rather than throws:
// throwing would be caught by the worker's own silent catch blocks and the bug
// would hide — which is exactly the failure mode this harness exists to prevent.
// ---------------------------------------------------------------------------
const state = {
  ports: [],
  alarms: [],
  listeners: {},
  cookiesGetAllCalls: 0,
  forbidden: [],
  pollReplies: [],
  cookieReply: [
    { name: 'sw_probe', value: 'v', domain: 'example.com', path: '/', secure: true, httpOnly: true }
  ],
  captureReply: { status: 'success', accepted: 1, domains: 1 },
  hangCookies: false,
  disconnectOnPoll: false
};

function trip(name) {
  state.forbidden.push(name);
}

function makePort() {
  const port = { posted: [], disconnected: false };
  port.onMessage = { addListener: (fn) => { port._message = fn; } };
  port.onDisconnect = { addListener: (fn) => { port._disconnect = fn; } };
  port.disconnect = () => { port.disconnected = true; };
  port.postMessage = (message) => {
    port.posted.push(message);
    if (message && message.command === 'poll_capture_request') {
      if (state.disconnectOnPoll) {
        // The host is missing or was removed by policy.
        queueMicrotask(() => port._disconnect && port._disconnect());
        return;
      }
      const reply = state.pollReplies.shift() || { status: 'idle' };
      queueMicrotask(() => port._message && port._message(reply));
      return;
    }
    // Capture port: the real host answers once, when the LAST chunk arrives.
    const chunks = port.posted.filter((m) => m && m.command === 'capture_cookies');
    const last = chunks[chunks.length - 1];
    if (last && last.chunk_index === last.chunk_count - 1) {
      const reply = state.captureReply;
      queueMicrotask(() => port._message && port._message(reply));
    }
  };
  state.ports.push(port);
  return port;
}

global.chrome = {
  runtime: {
    lastError: null,
    connectNative: () => makePort(),
    onMessage: { addListener: (fn) => { state.listeners.message = fn; } },
    onStartup: { addListener: (fn) => { state.listeners.startup = fn; } },
    onInstalled: { addListener: (fn) => { state.listeners.installed = fn; } },
    sendNativeMessage: () => {}
  },
  cookies: {
    getAll: (filter, cb) => {
      state.cookiesGetAllCalls += 1;
      if (state.hangCookies) {
        return; // never answers: models a capture that is still running
      }
      cb(state.cookieReply);
    }
  },
  alarms: {
    create: (name, info) => state.alarms.push({ name, info }),
    onAlarm: { addListener: (fn) => { state.listeners.alarm = fn; } }
  },
  notifications: { create: () => { trip('notifications.create'); return 'id'; } },
  tabs: { create: () => trip('tabs.create'), query: () => trip('tabs.query') },
  windows: { create: () => trip('windows.create') },
  action: {
    setBadgeText: () => trip('action.setBadgeText'),
    setTitle: () => trip('action.setTitle'),
    setIcon: () => trip('action.setIcon')
  },
  scripting: { executeScript: () => trip('scripting.executeScript') }
};

// path.resolve, not path.join: require() treats a bare relative path as a module
// name, so the wrapper can pass either an absolute path or one relative to the
// current directory and both work.
const bg = require(path.resolve(extDir, 'background.js'));
const flush = () => new Promise((resolve) => setTimeout(resolve, 15));
const pollPorts = () => state.ports.filter((p) => p.posted.some((m) => m.command === 'poll_capture_request'));
const capturePorts = () => state.ports.filter((p) => p.posted.some((m) => m.command === 'capture_cookies'));

let checks = 0;
function ok(cond, label) {
  assert.ok(cond, label);
  checks += 1;
}
function eq(a, b, label) {
  assert.strictEqual(a, b, label + ' (got ' + JSON.stringify(a) + ')');
  checks += 1;
}

(async () => {
  // --- 0. the pure decision table -----------------------------------------
  eq(bg.pollDecision({ status: 'idle' }).action, 'none', 'idle means do nothing');
  eq(bg.pollDecision(null).action, 'none', 'an empty reply means do nothing');
  eq(bg.pollDecision({ status: 'error', error: 'capture_request_expired' }).action, 'none',
    'an error reply must not start a capture');
  const wanted = bg.pollDecision({ status: 'capture_requested', clone_job_id: 'job-9', browser: 'edge' });
  eq(wanted.action, 'capture', 'capture_requested starts a capture');
  eq(wanted.cloneJobId, 'job-9', 'the job id is carried through');
  eq(wanted.browser, 'edge', 'the browser is carried through');
  eq(bg.pollDecision({ status: 'capture_requested' }).browser, 'chrome',
    'a missing browser defaults to chrome, never undefined');

  // --- 1. the silent trigger is actually registered ------------------------
  ok(state.listeners.startup, 'onStartup must be wired: it is what makes a headless wake answer in seconds');
  ok(state.listeners.alarm, 'an alarm listener must be wired');
  ok(state.alarms.some((a) => a.name === bg.SILENT_POLL_ALARM), 'the poll alarm must be created');
  const period = state.alarms.find((a) => a.name === bg.SILENT_POLL_ALARM).info.periodInMinutes;
  ok(period >= 0.5, 'the alarm period must not be below the 30s floor Chrome clamps to');

  // --- 2. an idle poll is completely silent -------------------------------
  state.pollReplies.push({ status: 'idle' });
  state.listeners.startup();
  await flush();
  eq(state.cookiesGetAllCalls, 0, 'an idle poll must not read a single cookie');
  ok(pollPorts().length === 1, 'the startup poll must actually ask the host');
  eq(pollPorts()[0].posted.length, 1, 'the poll sends exactly one message');
  eq(pollPorts()[0].posted[0].command, 'poll_capture_request', 'and it is the poll command');
  ok(pollPorts()[0].disconnected, 'the poll port must be closed so no host process is left running');
  eq(state.forbidden.length, 0, 'an idle poll must touch no UI at all');

  // --- 3. an unrelated alarm must not poll --------------------------------
  const portsBefore = state.ports.length;
  state.listeners.alarm({ name: 'some-other-alarm' });
  await flush();
  eq(state.ports.length, portsBefore, 'an unrelated alarm must not start a poll');

  // --- 4. a missing host is silent ---------------------------------------
  state.disconnectOnPoll = true;
  state.listeners.alarm({ name: bg.SILENT_POLL_ALARM });
  await flush();
  eq(state.cookiesGetAllCalls, 0, 'a disconnected host must not lead to a cookie read');
  eq(state.forbidden.length, 0, 'a missing host must never surface anything to the user');
  state.disconnectOnPoll = false;

  // --- 5. the alarm poll performs a real capture --------------------------
  state.pollReplies.push({ status: 'capture_requested', clone_job_id: 'job-42', browser: 'chrome' });
  state.listeners.alarm({ name: bg.SILENT_POLL_ALARM });
  await flush();
  eq(state.cookiesGetAllCalls, 1, 'a requested capture must read the cookies');
  ok(capturePorts().length === 1, 'a requested capture must post its chunks to the host');
  const chunks = capturePorts()[0].posted.filter((m) => m.command === 'capture_cookies');
  eq(chunks.length, 1, 'one small jar is one chunk');
  eq(chunks[0].clone_job_id, 'job-42', 'the chunk carries the requested job id');
  eq(chunks[0].browser, 'chrome', 'the chunk carries the requested browser');
  eq(chunks[0].chunk_index, 0, 'chunk indexing starts at zero');
  eq(chunks[0].chunk_count, 1, 'a complete jar reports its chunk count');
  eq(chunks[0].cookies.length, 1, 'the cookie made it into the jar');
  ok(!!chunks[0].captured_at, 'the chunk is timestamped');
  eq(state.forbidden.length, 0, 'a silent capture must show the user NOTHING');

  // --- 6. the popup path still works (regression guard) -------------------
  let popupReply = null;
  const kept = state.listeners.message(
    { command: 'capture_cookies', clone_job_id: 'popup-1', browser: 'chrome' },
    {},
    (reply) => { popupReply = reply; }
  );
  eq(kept, true, 'the popup path must keep the response channel open');
  await flush();
  ok(popupReply && popupReply.status === 'success', 'the popup path must still succeed');
  eq(popupReply.accepted, 1, 'the popup still receives counts');

  // --- 7. overlapping polls never interleave (MUST BE LAST) ---------------
  // The hung read leaves the worker "in flight" for the rest of this process,
  // so this case has to come last.
  state.hangCookies = true;
  state.pollReplies.push({ status: 'capture_requested', clone_job_id: 'job-B', browser: 'chrome' });
  state.listeners.alarm({ name: bg.SILENT_POLL_ALARM });
  await flush();
  const readsDuringFirst = state.cookiesGetAllCalls;
  const portsDuringFirst = state.ports.length;
  state.pollReplies.push({ status: 'capture_requested', clone_job_id: 'job-C', browser: 'chrome' });
  state.listeners.alarm({ name: bg.SILENT_POLL_ALARM });
  await flush();
  eq(state.cookiesGetAllCalls, readsDuringFirst, 'a poll during an in-flight capture must not read cookies again');
  eq(state.ports.length, portsDuringFirst, 'a poll during an in-flight capture must not open a second host port');

  console.log('SILENT-TRIGGER-OK checks=' + checks);
  process.exit(0);
})().catch((err) => {
  console.error('SILENT-TRIGGER-FAILED: ' + (err && err.message ? err.message : err));
  if (state.forbidden.length) {
    console.error('UI surface(s) touched: ' + state.forbidden.join(', '));
  }
  process.exit(1);
});
