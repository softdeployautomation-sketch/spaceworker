// Package wake owns the SILENT capture mailbox, result half: what the reader
// reports back, and how the broker waits for it. See request.go for the
// handshake's rules (single use, time-boxed, nonce-bound, no values on disk).
package wake

import (
	"encoding/json"
	"os"
	"time"

	"spaceworker.browser-clone/pkg/types"
)

// CaptureResult is what came back. It is COUNTS ONLY — the same contract the
// popup already renders ("1,204 cookies from 63 sites") and the same contract
// the native host's reply uses. A result file never contains a cookie name,
// value or domain, so it is safe to leave where the broker can read it.
type CaptureResult struct {
	// Nonce echoes the request it answers (mailbox property 3).
	Nonce string `json:"nonce"`
	// Status is "success" or "error".
	Status string `json:"status"`
	// Accepted / Domains / Truncated mirror the host's captureReply.
	Accepted  int  `json:"accepted,omitempty"`
	Domains   int  `json:"domains,omitempty"`
	Truncated bool `json:"truncated,omitempty"`
	// Reason is a named failure reason (never a message with detail in it).
	Reason string `json:"reason,omitempty"`
	// CompletedAt is RFC 3339.
	CompletedAt string `json:"completed_at"`
}

// Named reasons for the silent path. They are stable strings that end up in the
// console and in audit events, so they say what happened without describing the
// machine.
const (
	ReasonRequestExpired     = "capture_request_expired"
	ReasonRequestMalformed   = "capture_request_malformed"
	ReasonNoExtensionAnswer  = "capture_no_answer_from_extension"
	ReasonCaptureUnavailable = "capture_route_unavailable"
	ReasonWakeFailed         = "headless_wake_failed"
	ReasonWakeLeftNoResult   = "headless_wake_left_no_result"
	ReasonWakeNotSilent      = "headless_wake_would_be_visible"
)

// WriteResult writes a result with 0600 (it is small, but it is still an
// artefact in a user's profile directory).
func WriteResult(path string, res CaptureResult, now time.Time) error {
	if res.CompletedAt == "" {
		res.CompletedAt = types.TimeToIso(now)
	}
	blob, err := json.Marshal(res)
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, blob, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// ReadResult reads a result and checks it answers wantNonce. A result for a
// different capture is reported as "not yet" rather than as an error, because
// that is exactly the state a slow previous run leaves behind.
func ReadResult(path, wantNonce string) (CaptureResult, bool) {
	blob, err := os.ReadFile(path)
	if err != nil {
		return CaptureResult{}, false
	}
	var res CaptureResult
	if err := json.Unmarshal(blob, &res); err != nil {
		return CaptureResult{}, false
	}
	if res.Nonce != wantNonce {
		return CaptureResult{}, false
	}
	return res, true
}

// Waiter is the seam that makes the wait testable without real time or a real
// browser: the production implementation is time-based, tests use a fake.
type Waiter interface {
	// Now is the current time.
	Now() time.Time
	// Sleep pauses for d.
	Sleep(d time.Duration)
}

// WaitForResult polls for the result of wantNonce until the deadline. It returns
// the result, or ok=false with a named reason when nothing arrived in time —
// which is the signal that the extension never ran (the browser is not enforcing
// it, or it was disabled), the only failure mode that a wake can hit silently.
func WaitForResult(path, wantNonce string, deadline time.Time, every time.Duration, w Waiter) (CaptureResult, bool, string) {
	if every <= 0 {
		every = 500 * time.Millisecond
	}
	for {
		if res, ok := ReadResult(path, wantNonce); ok {
			return res, true, ""
		}
		if !w.Now().Before(deadline) {
			return CaptureResult{}, false, ReasonNoExtensionAnswer
		}
		w.Sleep(every)
	}
}

// RemoveResults deletes the result file at the start of a capture attempt, so the
// wait can never be satisfied by a leftover from an earlier run.
func RemoveResults(path string) {
	_ = os.Remove(path)
	_ = os.Remove(path + ".tmp")
}
