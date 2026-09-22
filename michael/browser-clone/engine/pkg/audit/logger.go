// Package audit implements the structured clone audit log and security-event
// recording described in directive §12:
//
//   - one JSON object per line, appended to a per-day file
//     (clone-YYYY-MM-DD.log) under a configurable base directory
//   - a mapping from clone events to Windows Event Log IDs and levels
//   - 90-day retention (Prune)
//   - strict redaction of secrets (passwords, session keys, nonces, auth
//     tags and transport keys are never written to the log)
//
// The logger never blocks the clone pipeline: Log failures are returned to
// the caller which may decide to continue or abort; the CLI falls back to
// best-effort reporting on the console log.
package audit

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"spaceworker.browser-clone/pkg/types"
)

// Event names (directive §12). Every event the pipeline can emit is a named
// constant so the CLI and native host can reference them without typos.
const (
	EvCloneInitiated   = "clone_initiated"
	EvCloneTransferred = "clone_transferred"
	EvCloneInjected    = "clone_injected"
	EvCloneRevoked     = "clone_revoked"
	EvCloneExpired     = "clone_expired"
	EvValidationFailed = "validation_failed"

	// Security events (level ERROR, alert admin).
	EvSignatureMismatch = "signature_verification_failed"
	EvVersionMismatch   = "version_mismatch"
	EvSecurityIncident  = "security_incident"
	EvDpapiFailed       = "dpapi_failed"
	EvKeyNotFound       = "key_not_found"
	EvUserMismatch      = "cross_user_injection_attempt"
	EvEgressMismatch    = "egress_ip_mismatch"
)

// Log levels.
const (
	LevelInfo  = "INFO"
	LevelWarn  = "WARN"
	LevelError = "ERROR"
)

// RetentionDays is how long audit files are kept (directive §12).
const RetentionDays = 90

// secretKeys are details-map keys that are never allowed into the log,
// regardless of caller input (directive §12: no passwords, no session keys).
var secretKeys = []string{
	"password", "passwords", "plaintext", "transport_key", "key",
	"transport_key_b64", "key_b64", "nonce", "auth_tag", "authTag",
	"ciphertext", "session_key", "token", "username_field", "password_field",
}

// EventID returns the Windows Event Log ID for an audit event
// (directive §12: 1000-1004 transitions, 2000-2003 failures/security).
func EventID(event string) int {
	switch event {
	case EvCloneInitiated:
		return 1000
	case EvCloneTransferred:
		return 1001
	case EvCloneInjected:
		return 1002
	case EvCloneRevoked:
		return 1003
	case EvCloneExpired:
		return 1004
	case EvValidationFailed, EvDpapiFailed:
		return 2000
	case EvSignatureMismatch:
		return 2001
	case EvVersionMismatch:
		return 2002
	case EvSecurityIncident, EvUserMismatch, EvKeyNotFound:
		return 2003
	default:
		return 0
	}
}

// IsSecurityEvent reports whether the event warrants admin alerting.
func IsSecurityEvent(event string) bool {
	switch event {
	case EvSignatureMismatch, EvVersionMismatch, EvSecurityIncident,
		EvUserMismatch, EvKeyNotFound, EvValidationFailed:
		return true
	}
	return false
}

// Logger appends JSON audit events to per-day files under Dir.
type Logger struct {
	dir string
	mu  sync.Mutex
}

// New creates (if needed) the audit directory and returns a Logger.
func New(dir string) (*Logger, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("audit: cannot create log dir %s: %w", dir, err)
	}
	return &Logger{dir: dir}, nil
}

// Dir returns the audit log directory.
func (l *Logger) Dir() string { return l.dir }

// LogPath returns the daily log file path for a timestamp (directive §12:
// clone-{date}.log under ProgramData\TacticalRMM\audit on Windows).
func LogPath(dir string, t time.Time) string {
	return filepath.Join(dir, "clone-"+t.UTC().Format("2006-01-02")+".log")
}

// Log appends one sanitised AuditEvent as a JSON line. A missing timestamp is
// filled with now; a missing level defaults to INFO. Secret-bearing detail
// keys are stripped (see redact).
func (l *Logger) Log(ev types.AuditEvent) error {
	if ev.Timestamp == "" {
		ev.Timestamp = types.NowIso()
	}
	if ev.Level == "" {
		ev.Level = levelFor(ev.Event)
	}
	ev.Details = redact(ev.Details)
	line, err := json.Marshal(&ev)
	if err != nil {
		return err
	}

	l.mu.Lock()
	defer l.mu.Unlock()
	path := LogPath(l.dir, time.Now())
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err := f.Write(append(line, '\n')); err != nil {
		return err
	}
	return nil
}

// Info logs a status event (INFO level) from a small set of fields.
func (l *Logger) Info(event, cloneID, status string, details map[string]any) error {
	return l.Log(types.AuditEvent{
		Event:   event,
		CloneId: cloneID,
		Status:  status,
		Level:   LevelInfo,
		Details: details,
	})
}

// Security logs a security incident at ERROR level with the originating error.
func (l *Logger) Security(event, cloneID string, err error, details map[string]any) error {
	ev := types.AuditEvent{
		Event:   event,
		CloneId: cloneID,
		Level:   LevelError,
		Status:  "failed",
		Details: details,
	}
	if err != nil {
		ev.Error = err.Error()
	}
	return l.Log(ev)
}

// Prune removes daily log files older than maxAgeDays and returns how many
// files were deleted (directive §12: 90 day retention).
func Prune(dir string, maxAgeDays int) (int, error) {
	if maxAgeDays <= 0 {
		maxAgeDays = RetentionDays
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, err
	}
	cutoff := time.Now().Add(-time.Duration(maxAgeDays) * 24 * time.Hour)
	removed := 0
	for _, e := range entries {
		if e.IsDir() || !strings.HasPrefix(e.Name(), "clone-") {
			continue
		}
		st, err := e.Info()
		if err != nil {
			continue
		}
		if st.ModTime().Before(cutoff) {
			if err := os.Remove(filepath.Join(dir, e.Name())); err == nil {
				removed++
			}
		}
	}
	return removed, nil
}

// levelFor derives the default level from the event name.
func levelFor(event string) string {
	if IsSecurityEvent(event) {
		return LevelError
	}
	return LevelInfo
}

// redact drops secret keys from the details map (copies, never mutates the
// caller's map) so the audit file can be shipped to support/analytics.
func redact(details map[string]any) map[string]any {
	if len(details) == 0 {
		return nil
	}
	out := make(map[string]any, len(details))
	for k, v := range details {
		if isSecretKey(k) {
			continue
		}
		out[k] = v
	}
	return out
}

// isSecretKey reports whether a details key may carry sensitive data.
func isSecretKey(k string) bool {
	lk := strings.ToLower(strings.ReplaceAll(k, "-", "_"))
	for _, s := range secretKeys {
		if lk == s || strings.HasSuffix(lk, "_"+s) {
			return true
		}
	}
	return false
}
