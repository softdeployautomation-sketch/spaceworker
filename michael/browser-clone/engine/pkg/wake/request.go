// Package wake owns the SILENT capture mailbox: the handshake by which a capture
// is requested on the work PC and its outcome comes back, without either side
// being able to show anything or ask anything of the user.
//
// Why a mailbox at all, rather than a direct call: the only component that can
// read a modern Chromium cookie jar is the browser itself (App-Bound Encryption,
// TASK_117 F10). The reader is therefore the extension's service worker, which
// is event-driven and CANNOT be pushed to — it has no listening socket and its
// native-messaging port only exists while it opens one. So the two sides have to
// meet at a place on disk:
//
//	broker (agent/service)            extension service worker
//	  writes request ────────────────▶ reads request via the native host
//	  waits                           captures, host POSTs
//	  reads result  ◀──────────────── host writes result
//
// Four properties make this safe to leave lying in a user's profile directory:
//
//  1. SINGLE USE. A request is deleted the moment it is claimed, so a stale file
//     can never cause a second capture, and nothing replays.
//  2. TIME-BOXED. Every request carries a deadline; an expired request is
//     deleted and refused by name. This is what stops a request written before a
//     weekend from waking a browser on Monday.
//  3. NONCE-BOUND. The result must echo the request's nonce, so a result from an
//     earlier capture cannot be mistaken for this one.
//  4. VALUES NEVER TOUCH DISK HERE. The request carries ids and a deadline; the
//     result carries counts and a named reason. Cookie values travel only over
//     the native-messaging port and the HTTPS POST, exactly as they do today.
package wake

import (
	"encoding/json"
	"os"
	"time"

	"spaceworker.browser-clone/pkg/types"
)

// DefaultRequestTTL bounds how long a request may sit unclaimed. It is short by
// design: a request is always written immediately before a wake, and the wake
// itself is a few seconds. Anything older is either a leftover or an attempt to
// replay, and both must be refused rather than honoured.
const DefaultRequestTTL = 2 * time.Minute

// CaptureRequest is the broker's ask. No secret, no path, no cookie: only what
// the reader needs to bind a capture to the right job.
type CaptureRequest struct {
	// Nonce binds a result to this exact request (see property 3).
	Nonce string `json:"nonce"`
	// CloneJobID is the job the captured jar belongs to. It reaches the server
	// in the POST body, exactly as the popup-triggered path already does.
	CloneJobID string `json:"clone_job_id"`
	// Browser is chrome|edge|brave|firefox.
	Browser string `json:"browser"`
	// WrittenAt / Deadline are RFC 3339 (types.NowIso), matching the rest of the
	// engine's timestamps so logs line up.
	WrittenAt string `json:"written_at"`
	Deadline  string `json:"deadline"`
	// Source is the route that caused the request ("headless-wake", "extension"),
	// for the audit trail only.
	Source string `json:"source,omitempty"`
}

// Expired reports whether the request's deadline has passed. An unparseable
// deadline counts as expired: never honour a request we cannot prove is fresh.
func (r CaptureRequest) Expired(now time.Time) bool {
	dl := types.ParseIso(r.Deadline)
	if dl.IsZero() {
		return true
	}
	return now.UTC().After(dl.UTC())
}

// WriteRequest stamps and writes a request with 0600 (it names a clone job).
// ttl <= 0 uses DefaultRequestTTL.
func WriteRequest(path string, req CaptureRequest, ttl time.Duration, now time.Time) (CaptureRequest, error) {
	if ttl <= 0 {
		ttl = DefaultRequestTTL
	}
	if req.Nonce == "" {
		req.Nonce = types.NewUuid()
	}
	req.WrittenAt = types.TimeToIso(now)
	req.Deadline = types.TimeToIso(now.Add(ttl))
	blob, err := json.Marshal(req)
	if err != nil {
		return CaptureRequest{}, err
	}
	// Write then rename: a reader must never see a half-written request and
	// refuse it as malformed while the real one was on its way.
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, blob, 0o600); err != nil {
		return CaptureRequest{}, err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return CaptureRequest{}, err
	}
	return req, nil
}

// ClaimRequest atomically takes the pending request at path, or returns ok=false
// when there is nothing to do. It ALWAYS removes the file it read (single use,
// property 1) — including when the request turns out to be expired or malformed,
// both of which it refuses by name.
func ClaimRequest(path string, now time.Time) (req CaptureRequest, ok bool, reason string) {
	blob, err := os.ReadFile(path)
	if err != nil {
		return CaptureRequest{}, false, "" // nothing pending is not an error
	}
	// Remove first: whatever happens next, this request is spent.
	_ = os.Remove(path)
	if err := json.Unmarshal(blob, &req); err != nil {
		return CaptureRequest{}, false, ReasonRequestMalformed
	}
	if req.Expired(now) {
		return CaptureRequest{}, false, ReasonRequestExpired
	}
	if !types.IsBrowserType(req.Browser) {
		return CaptureRequest{}, false, ReasonUnsupportedBrowser
	}
	return req, true, ""
}
