package wake

import (
	"encoding/json"
	"fmt"
)

// ExitState is the slice of a Chromium profile's `Preferences` that a headless
// wake perturbs. Chrome marks a session unclean at STARTUP (exit_type
// "Crashed"/exited_cleanly false) and only clears it on a clean shutdown — and a
// wake is stopped deliberately, so without this the user's next normal launch
// can show "Restore pages?" for a capture they never knew happened. That is a
// visible side effect, which makes it a silence bug by this package's rules.
type ExitState struct {
	// Present is false when Preferences is missing or has no profile section —
	// in that case nothing is written back on restore (never invent state).
	Present bool `json:"present"`
	// ExitType mirrors profile.exit_type ("Normal", "Crashed", "SessionEnded").
	ExitType string `json:"exit_type,omitempty"`
	// ExitedCleanly mirrors profile.exited_cleanly.
	ExitedCleanly bool `json:"exited_cleanly"`
}

// ReadExitState pulls the two fields out of a Preferences document. A malformed
// or unreadable document yields Present=false rather than an error: the capture
// must not fail because Chrome's own file moved on, and restoring nothing is the
// safe default.
func ReadExitState(preferences []byte) (ExitState, error) {
	if len(preferences) == 0 {
		return ExitState{}, nil
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(preferences, &doc); err != nil {
		return ExitState{}, fmt.Errorf("preferences_unreadable: %w", err)
	}
	raw, ok := doc["profile"]
	if !ok {
		return ExitState{}, nil
	}
	var prof map[string]json.RawMessage
	if err := json.Unmarshal(raw, &prof); err != nil {
		return ExitState{}, fmt.Errorf("preferences_profile_unreadable: %w", err)
	}
	st := ExitState{Present: true}
	if v, ok := prof["exit_type"]; ok {
		_ = json.Unmarshal(v, &st.ExitType)
	}
	if v, ok := prof["exited_cleanly"]; ok {
		_ = json.Unmarshal(v, &st.ExitedCleanly)
	}
	return st, nil
}

// MergeExitState writes the two fields back into a Preferences document,
// preserving every other key byte-for-byte as JSON values (they are carried as
// RawMessage, never re-encoded). It returns the ORIGINAL document unchanged when
// there is nothing to restore, so a no-op restore cannot rewrite the file.
func MergeExitState(preferences []byte, st ExitState) ([]byte, error) {
	if !st.Present || len(preferences) == 0 {
		return preferences, nil
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(preferences, &doc); err != nil {
		return nil, fmt.Errorf("preferences_unreadable: %w", err)
	}
	prof := map[string]json.RawMessage{}
	if raw, ok := doc["profile"]; ok {
		if err := json.Unmarshal(raw, &prof); err != nil {
			return nil, fmt.Errorf("preferences_profile_unreadable: %w", err)
		}
	}
	exitType, err := json.Marshal(st.ExitType)
	if err != nil {
		return nil, err
	}
	prof["exit_type"] = exitType
	if st.ExitedCleanly {
		prof["exited_cleanly"] = json.RawMessage("true")
	} else {
		prof["exited_cleanly"] = json.RawMessage("false")
	}
	profRaw, err := json.Marshal(prof)
	if err != nil {
		return nil, err
	}
	doc["profile"] = profRaw
	return json.Marshal(doc)
}
