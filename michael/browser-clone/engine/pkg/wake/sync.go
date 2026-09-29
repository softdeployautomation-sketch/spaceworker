// Package wake, sync half: what a FIRST-TIME clone sends, and what a clone sends
// when the user comes back (the "sync on reconnect" flow).
//
// Two rules shape everything here:
//
//  1. COOKIES ARE ALWAYS SENT IN FULL. They are read in-process by the extension
//     (chrome.cookies.getAll) — no disk, no decryption, milliseconds — and they
//     are always fresh, which is the whole point of a session carry. They also
//     cannot be diffed without keeping old values somewhere, which the contract
//     forbids (TASK_119A A5: never persisted, never audited). So the cheap half
//     is re-read every time and never diffed.
//
//  2. STATE FILES ARE SENT AS A DELTA ON RECONNECT. History, bookmarks, tabs and
//     extensions are the expensive half (tens of MB), and they change slowly, so
//     a reconnect sends only what changed since the last transfer. This is what
//     makes the second and third connect fast instead of re-uploading a profile.
//
// Only FILE FINGERPRINTS are compared and stored — path, size, mtime, optional
// hash. A manifest never contains a byte of user data.
package wake

import (
	"fmt"
	"sort"
	"strings"
	"time"
)

// Sync modes.
const (
	// SyncModeFull is a first clone, or one whose previous state cannot be used.
	SyncModeFull = "full"
	// SyncModeDelta is a reconnect: only what changed.
	SyncModeDelta = "delta"
)

// Reasons a sync decision was made. Every one of them is a named reason the
// caller can report, in the same spirit as the capture reasons: never a silent
// downgrade.
const (
	ReasonFirstClone      = "first_clone"
	ReasonSyncOnReconnect = "sync_on_reconnect"
	ReasonManifestStale   = "manifest_stale"
	ReasonBrowserChanged  = "browser_changed"
	ReasonProfileChanged  = "profile_changed"
	ReasonVersionChanged  = "browser_version_changed"
)

// DefaultManifestMaxAge is how long a previous manifest stays useful. Beyond it a
// delta is refused and a full transfer is done instead: a week of drift can
// rewrite a browsing-history database in place, and a delta computed against a
// stale fingerprint list would silently omit the change — the one failure mode a
// replica must never have.
const DefaultManifestMaxAge = 7 * 24 * time.Hour

// FileFingerprint identifies one state file well enough to decide whether it
// needs transferring. It is deliberately incapable of carrying user data.
type FileFingerprint struct {
	// Path is relative to the profile root, so a manifest is portable between the
	// work PC and the hosted machine.
	Path string `json:"path"`
	// Size in bytes.
	Size int64 `json:"size"`
	// ModTime is unix seconds. Together with Size it is the fast comparison; a
	// file Chrome rewrote has changed even when the size happens to match.
	ModTime int64 `json:"mtime"`
	// SHA256 is optional. When BOTH sides carry one it is authoritative, which is
	// what catches an in-place rewrite that preserved size and mtime.
	SHA256 string `json:"sha256,omitempty"`
}

// Manifest is the fingerprint list for one browser profile, as of one capture.
// It is what the server keeps BETWEEN clones to make a reconnect a delta.
type Manifest struct {
	DeviceID   string            `json:"device_id,omitempty"`
	Browser    string            `json:"browser"`
	Version    string            `json:"version,omitempty"`
	Profile    string            `json:"profile"`
	CapturedAt time.Time         `json:"captured_at"`
	Files      []FileFingerprint `json:"files"`
}

// MajorVersion exposes the plan's version rule (see SyncDecision).
func (m Manifest) MajorVersion() int { return MajorVersion(m.Version) }

// Delta is the work a reconnect actually has to do.
type Delta struct {
	// Added files did not exist in the previous manifest.
	Added []FileFingerprint `json:"added,omitempty"`
	// Changed files exist in both but differ.
	Changed []FileFingerprint `json:"changed,omitempty"`
	// Removed lists paths present before and gone now. A replica has to delete
	// them, or it drifts from the source: a clone that keeps a deleted profile
	// directory is no longer a replica.
	Removed []string `json:"removed,omitempty"`
	// Unchanged counts what did NOT need sending — the saving, in files.
	Unchanged int `json:"unchanged"`
}

// Bytes is the transfer size of the delta.
func (d Delta) Bytes() int64 {
	var total int64
	for _, f := range d.Added {
		total += f.Size
	}
	for _, f := range d.Changed {
		total += f.Size
	}
	return total
}

// Empty is true when nothing has to move. The caller can then skip the transfer
// altogether and go straight to the cookie injection — the fastest possible
// reconnect.
func (d Delta) Empty() bool {
	return len(d.Added) == 0 && len(d.Changed) == 0 && len(d.Removed) == 0
}

// SyncDecision is the answer PlanSync gives.
type SyncDecision struct {
	Mode   string `json:"mode"`
	Reason string `json:"reason"`
	// Delta is set only for a delta decision.
	Delta *Delta `json:"delta,omitempty"`
	// CookiesAlwaysFull is the standing rule, stated on the decision so a caller
	// or a log never has to infer it from the mode.
	CookiesAlwaysFull bool `json:"cookies_always_full"`
}

// Validate rejects a decision that could silently under-send: a delta with no
// computed delta would transfer nothing and look like it worked.
func (d SyncDecision) Validate() error {
	switch d.Mode {
	case SyncModeFull:
		if d.Delta != nil {
			return fmt.Errorf("sync_full_carries_no_delta")
		}
	case SyncModeDelta:
		if d.Delta == nil {
			return fmt.Errorf("sync_delta_missing_delta")
		}
	default:
		return fmt.Errorf("sync_mode_unknown:%s", d.Mode)
	}
	if strings.TrimSpace(d.Reason) == "" {
		return fmt.Errorf("sync_reason_missing")
	}
	return nil
}

// normalizePath makes two spellings of the same profile-relative path compare
// equal. It matters because Windows paths are case-insensitive: `Default\History`
// and `default\history` are one file, and treating them as two would transfer it
// on every single sync.
func normalizePath(p string) string {
	return strings.ToLower(strings.ReplaceAll(strings.TrimSpace(p), "\\", "/"))
}

// dedupe keeps the LAST fingerprint for a repeated path and returns a sorted,
// deterministic slice. A malformed manifest (or a device that scanned the same
// file twice) must not make the diff nondeterministic.
func dedupe(files []FileFingerprint) []FileFingerprint {
	byPath := make(map[string]FileFingerprint, len(files))
	for _, f := range files {
		key := normalizePath(f.Path)
		if key == "" {
			continue
		}
		byPath[key] = f
	}
	out := make([]FileFingerprint, 0, len(byPath))
	for _, f := range byPath {
		out = append(out, f)
	}
	sort.Slice(out, func(i, j int) bool {
		return normalizePath(out[i].Path) < normalizePath(out[j].Path)
	})
	return out
}

// sameFile decides whether a file needs transferring.
//
// A hash WINS whenever both sides carry one, and it is checked FIRST. Size+mtime
// is only the fallback, because it is wrong in both directions in practice:
// Chrome rewrites files at every launch without changing them (mtime moves, so
// size+mtime re-sends the whole profile), and a rewrite can preserve both size
// and mtime (so size+mtime misses a real change).
func sameFile(a, b FileFingerprint) bool {
	if a.SHA256 != "" && b.SHA256 != "" {
		return strings.EqualFold(a.SHA256, b.SHA256)
	}
	return a.Size == b.Size && a.ModTime == b.ModTime
}

// DiffManifests computes what a reconnect has to send. Either side may be nil.
func DiffManifests(prev, next []FileFingerprint) Delta {
	previous := dedupe(prev)
	current := dedupe(next)

	byPath := make(map[string]FileFingerprint, len(previous))
	for _, f := range previous {
		byPath[normalizePath(f.Path)] = f
	}

	var d Delta
	for _, f := range current {
		key := normalizePath(f.Path)
		if old, ok := byPath[key]; ok {
			if sameFile(old, f) {
				d.Unchanged++
				continue
			}
			d.Changed = append(d.Changed, f)
			continue
		}
		d.Added = append(d.Added, f)
	}

	present := make(map[string]struct{}, len(current))
	for _, f := range current {
		present[normalizePath(f.Path)] = struct{}{}
	}
	for _, f := range previous {
		if _, ok := present[normalizePath(f.Path)]; !ok {
			d.Removed = append(d.Removed, f.Path)
		}
	}
	sort.Strings(d.Removed)
	return d
}

// PlanSync decides between a first-time clone and a sync on reconnect.
//
// A delta is only used when the previous manifest is genuinely usable for THIS
// profile. Anything else — a first clone, a different browser, a different
// profile, a changed major version, or a manifest older than maxAge — is a full
// transfer with a named reason, because a delta against the wrong baseline is how
// a replica silently loses data.
//
// now and maxAge are parameters, not globals, so the rule is testable without
// waiting a week. A zero maxAge means DefaultManifestMaxAge.
func PlanSync(prev *Manifest, next Manifest, now time.Time, maxAge time.Duration) SyncDecision {
	if maxAge <= 0 {
		maxAge = DefaultManifestMaxAge
	}
	full := func(reason string) SyncDecision {
		return SyncDecision{Mode: SyncModeFull, Reason: reason, CookiesAlwaysFull: true}
	}

	if prev == nil || len(prev.Files) == 0 {
		return full(ReasonFirstClone)
	}
	// The baseline must describe the same thing we are about to sync. Anything
	// less is not "stale", it is simply the wrong list to diff against.
	if !strings.EqualFold(strings.TrimSpace(prev.Browser), strings.TrimSpace(next.Browser)) {
		return full(ReasonBrowserChanged)
	}
	if !strings.EqualFold(strings.TrimSpace(prev.Profile), strings.TrimSpace(next.Profile)) {
		return full(ReasonProfileChanged)
	}
	prevMajor, nextMajor := prev.MajorVersion(), next.MajorVersion()
	if prevMajor != 0 && nextMajor != 0 && prevMajor != nextMajor {
		// A major upgrade reshapes the profile (new stores, moved files); a delta
		// computed across it would hunt for paths that no longer exist.
		return full(ReasonVersionChanged)
	}
	if prev.CapturedAt.IsZero() {
		return full(ReasonFirstClone)
	}
	if now.Sub(prev.CapturedAt) > maxAge {
		return full(ReasonManifestStale)
	}

	delta := DiffManifests(prev.Files, next.Files)
	return SyncDecision{
		Mode:              SyncModeDelta,
		Reason:            ReasonSyncOnReconnect,
		Delta:             &delta,
		CookiesAlwaysFull: true,
	}
}
