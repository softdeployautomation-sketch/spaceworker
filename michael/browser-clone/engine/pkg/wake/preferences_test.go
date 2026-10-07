package wake

import (
	"encoding/json"
	"testing"
)

// prefsDoc is an ordinary Chromium Preferences document with the two fields the
// wake perturbs plus neighbours that must survive untouched.
const prefsDoc = `{
  "profile": {
    "exit_type": "Normal",
    "exited_cleanly": true,
    "name": "Person 1",
    "avatar_index": 26
  },
  "intl": { "app_locale": "en-GB" },
  "custom_neighbour": { "keep": [1, 2, 3] }
}`

func TestReadExitState(t *testing.T) {
	st, err := ReadExitState([]byte(prefsDoc))
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if !st.Present || st.ExitType != "Normal" || !st.ExitedCleanly {
		t.Fatalf("got %+v", st)
	}
}

func TestReadExitStateMissingDocumentIsNotAnError(t *testing.T) {
	// A profile whose Preferences we cannot read must NOT fail the capture: the
	// safe default is "restore nothing".
	for _, in := range [][]byte{nil, []byte(""), []byte("not json")} {
		st, err := ReadExitState(in)
		if in == nil || len(in) == 0 {
			if err != nil || st.Present {
				t.Fatalf("empty input must yield an absent state, got %+v err=%v", st, err)
			}
		}
	}
	if _, err := ReadExitState([]byte("{ not json")); err == nil {
		t.Fatal("malformed JSON must be reported so the caller can skip the restore")
	}
}

func TestReadExitStateWithoutProfileSectionIsAbsent(t *testing.T) {
	st, err := ReadExitState([]byte(`{"intl":{"app_locale":"en-GB"}}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if st.Present {
		t.Fatal("a document with no profile section has no exit state to restore")
	}
}

// TestMergeExitStatePreservesEverythingElse is the privacy critical one: the
// merge must change the two exit fields and nothing else, or a capture would
// count as "modifying the user's browser settings".
func TestMergeExitStatePreservesEverythingElse(t *testing.T) {
	want, err := ReadExitState([]byte(prefsDoc))
	if err != nil {
		t.Fatal(err)
	}
	// Simulate what Chrome writes at startup: an unclean session.
	crashed := []byte(`{"profile":{"exit_type":"Crashed","exited_cleanly":false,"name":"Person 1",
	  "avatar_index":26},"intl":{"app_locale":"en-GB"},"custom_neighbour":{"keep":[1,2,3]}}`)

	restored, err := MergeExitState(crashed, want)
	if err != nil {
		t.Fatalf("merge: %v", err)
	}
	got, err := ReadExitState(restored)
	if err != nil {
		t.Fatalf("re-read: %v", err)
	}
	if got != want {
		t.Fatalf("exit state not restored: got %+v want %+v", got, want)
	}
	// And the neighbours survived, byte-for-byte.
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(restored, &doc); err != nil {
		t.Fatalf("restored doc is not valid JSON: %v", err)
	}
	if string(doc["intl"]) != `{"app_locale":"en-GB"}` {
		t.Fatalf("unrelated key was rewritten: %s", doc["intl"])
	}
	if string(doc["custom_neighbour"]) != `{"keep":[1,2,3]}` {
		t.Fatalf("unrelated key was rewritten: %s", doc["custom_neighbour"])
	}
}

// TestMergeExitStateIsANoOpWithoutState: with nothing to restore we must return
// the caller's bytes untouched, so a no-op restore cannot rewrite the file.
func TestMergeExitStateIsANoOpWithoutState(t *testing.T) {
	out, err := MergeExitState([]byte(prefsDoc), ExitState{Present: false})
	if err != nil {
		t.Fatalf("merge: %v", err)
	}
	if string(out) != prefsDoc {
		t.Fatal("a no-op restore must not rewrite the document")
	}
}

// TestMergeExitStateCreatesProfileSection: Chrome 141+ profiles always have the
// section, but a hand-trimmed policy profile may not — never panic or lose data.
func TestMergeExitStateCreatesProfileSection(t *testing.T) {
	out, err := MergeExitState([]byte(`{"intl":{"app_locale":"en-GB"}}`),
		ExitState{Present: true, ExitType: "Crashed", ExitedCleanly: false})
	if err != nil {
		t.Fatalf("merge: %v", err)
	}
	st, err := ReadExitState(out)
	if err != nil {
		t.Fatalf("re-read: %v", err)
	}
	if st.ExitType != "Crashed" || st.ExitedCleanly {
		t.Fatalf("got %+v", st)
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(out, &doc); err != nil {
		t.Fatal(err)
	}
	if string(doc["intl"]) != `{"app_locale":"en-GB"}` {
		t.Fatalf("neighbour lost: %s", doc["intl"])
	}
}
