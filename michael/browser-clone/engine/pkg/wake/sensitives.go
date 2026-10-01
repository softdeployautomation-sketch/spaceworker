package wake

import (
	"fmt"
	"path"
	"strings"
)

// Why this file exists
//
// A clone carries a session (cookies, via the extension and CDP) and state
// (files). The state half must not quietly become a SECOND, useless and far more
// sensitive channel for the first half. Three profile files are therefore never
// carried as clone state files:
//
//   - `Cookies` / `Cookies-journal` — ABE-bound on Chrome/Edge/Brave 127+ (F10),
//     and a RELOCATED profile has its rows deleted (F11). Carrying them transfers
//     a credential file that can never be read on the destination. Cookies reach
//     the clone through CDP, which is the mechanism proven to work (F6).
//   - `Login Data` (+ variants, + journal) — password rows, ABE/DPAPI-bound. The
//     single highest-value secret in a profile, and unusable in the clone.
//   - `Local State` — holds the App-Bound-Encryption key and the DPAPI-wrapped
//     keys. It is the key to the first two; sending it would be the worst of the
//     three.
//
// Scope: this applies to the HOSTED CLONE state sync only. The legacy MT-1
// archive route (Invoke-BrowserClone.ps1) keeps its own documented file set — its
// destination is a Windows machine that can re-protect what it receives, so its
// contract is deliberately different and is not changed here.

// cloneStateExclusions maps a profile file name (lower-case basename) to the
// reason it is not carried. A reason is always reported, never a silent skip.
var cloneStateExclusions = map[string]string{
	"cookies":                        "cookies_abe_bound_use_cdp",
	"cookies-journal":                "cookies_abe_bound_use_cdp",
	"login data":                     "passwords_abe_bound_unusable_in_clone",
	"login data for account":         "passwords_abe_bound_unusable_in_clone",
	"login data-journal":             "passwords_abe_bound_unusable_in_clone",
	"login data for account-journal": "passwords_abe_bound_unusable_in_clone",
	"local state":                    "abe_key_store_never_transferred",
	"app_bound_encrypted_key":        "abe_key_store_never_transferred",
	"affiliation database":           "unused_by_clone",
	"preferences-journal":            "journal_transient",
	"secure preferences-journal":     "journal_transient",
	// TASK_135 §3 — see the TypeScript side (lib/clone-sync-plan.ts). A
	// SingletonLock names `<hostname>-<pid>`, so it describes the SOURCE machine
	// and means nothing on the destination; transferring it can make a hosted
	// Chromium refuse to start, reporting a profile "in use" by a process that
	// does not exist there. scripts/check-clone-contract.mjs fails if the two
	// lists ever drift apart, which is why this must be added in both places.
	"singletonlock":   "stale_browser_lock",
	"singletoncookie": "stale_browser_lock",
	"singletonsocket": "stale_browser_lock",
}

// CloneStateFileExcluded reports whether a profile-relative path must not be
// carried as clone state, with a named reason when it is. The basename is what
// matters, so Chrome's `Network/Cookies` is caught by the same rule as an older
// root-level `Cookies`.
func CloneStateFileExcluded(p string) (string, bool) {
	base := strings.ToLower(strings.TrimSpace(path.Base(strings.ReplaceAll(p, "\\", "/"))))
	if reason, ok := cloneStateExclusions[base]; ok {
		return reason, true
	}
	return "", false
}

// CloneStatePathSafe rejects a profile-relative path that escapes the profile
// root, or that names a drive/absolute path. A manifest crosses a trust boundary
// (the device describes what it wants copied), so this is enforced on the
// receiving side as well as the sending side: "..\\..\\Windows\\System32" must
// never be a transferable state file.
func CloneStatePathSafe(p string) error {
	raw := strings.TrimSpace(p)
	if raw == "" {
		return fmt.Errorf("state_path_empty")
	}
	if strings.ContainsAny(raw, "\x00") {
		return fmt.Errorf("state_path_nul")
	}
	// Normalise Windows separators: a manifest may legitimately use either.
	slashed := strings.ReplaceAll(raw, "\\", "/")
	// A UNC path (`//server/share`) is absolute in effect. Checked BEFORE the
	// absolute test purely so the reason names the real problem: "//server/share"
	// would otherwise be reported as a plain absolute path, which sends someone
	// looking in the wrong place.
	if strings.HasPrefix(slashed, "//") {
		return fmt.Errorf("state_path_unc")
	}
	if path.IsAbs(slashed) {
		return fmt.Errorf("state_path_absolute")
	}
	// A drive-relative form such as `C:History` is absolute in effect.
	if len(slashed) >= 2 && slashed[1] == ':' {
		return fmt.Errorf("state_path_drive_relative")
	}
	// Clean first, so `a/../../b` is caught rather than `..` alone being searched
	// for in a string that never contains a bare `..` component.
	cleaned := path.Clean(slashed)
	if cleaned == ".." || strings.HasPrefix(cleaned, "../") {
		return fmt.Errorf("state_path_escapes_profile")
	}
	return nil
}

// CloneStateFilter is one file the caller must NOT transfer.
type CloneStateFilter struct {
	Path   string `json:"path"`
	Reason string `json:"reason"`
}

// FilterCloneStateFiles splits a manifest's fingerprints into what may be carried
// and what may not, with a reason for every exclusion. An unsafe path is dropped
// with the same explicitness as a sensitive one — the caller reports both.
func FilterCloneStateFiles(files []FileFingerprint) (kept []FileFingerprint, dropped []CloneStateFilter) {
	for _, f := range files {
		if err := CloneStatePathSafe(f.Path); err != nil {
			dropped = append(dropped, CloneStateFilter{Path: f.Path, Reason: err.Error()})
			continue
		}
		if reason, excluded := CloneStateFileExcluded(f.Path); excluded {
			dropped = append(dropped, CloneStateFilter{Path: f.Path, Reason: reason})
			continue
		}
		kept = append(kept, f)
	}
	return kept, dropped
}
