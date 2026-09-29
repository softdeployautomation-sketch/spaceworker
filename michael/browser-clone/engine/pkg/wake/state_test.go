package wake

// Tests for the STATE half of the silent capture: collecting a profile, filtering
// it, selecting a delta, and carrying it to the server.
//
// The HTTP tests run against a REAL net/http test server, not a mock of the
// client. The bugs this file exists to prevent are about what actually crosses the
// wire (a header that must be URL-encoded, a status that must fail a file, a
// finalize that must not run before the bytes), so mocking the client would have
// hidden every one of them.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// makeProfile writes a realistic profile tree and returns its root.
func makeProfile(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	files := map[string]string{
		"History":                      "sqlite-history",
		"Bookmarks":                    "{}",
		"Preferences":                  `{"profile":{"exit_type":"Normal"}}`,
		"Network/Cookies":              "ABE-BOUND-SECRET",
		"Login Data":                   "PASSWORD-SECRET",
		"Local State":                  "ABE-KEY-SECRET",
		"Sessions/Session_1234":        "tabs",
		"Extensions/abc/manifest.json": "{}",
	}
	for rel, body := range files {
		abs := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(abs, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func paths(files []StateFile) []string {
	out := make([]string, 0, len(files))
	for _, f := range files {
		out = append(out, f.Fingerprint.Path)
	}
	return out
}

func TestCollectStateFilesCarriesStateAndRefusesSecrets(t *testing.T) {
	root := makeProfile(t)
	kept, dropped := CollectStateFiles(root, 0)

	got := paths(kept)
	want := []string{
		"Bookmarks",
		"Extensions/abc/manifest.json",
		"History",
		"Preferences",
		"Sessions/Session_1234",
	}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("kept = %v, want %v", got, want)
	}

	// The three credential files must appear as REFUSALS with reasons: a file
	// silently absent from a manifest is how a replica quietly loses data.
	byPath := map[string]string{}
	for _, d := range dropped {
		byPath[d.Path] = d.Reason
	}
	for _, p := range []string{"Network/Cookies", "Login Data", "Local State"} {
		if byPath[p] == "" {
			t.Errorf("%s was dropped with no reason", p)
		}
	}
	if len(kept)+len(dropped) != 8 {
		t.Fatalf("the walk lost files: kept=%d dropped=%d", len(kept), len(dropped))
	}
}

func TestCollectStateFilesIsMissingProfileNotAnEmptyOne(t *testing.T) {
	_, dropped := CollectStateFiles(filepath.Join(t.TempDir(), "nope"), 0)
	if len(dropped) != 1 || dropped[0].Reason != ReasonStateProfileMissing {
		t.Fatalf("want one %s refusal, got %+v", ReasonStateProfileMissing, dropped)
	}
}

func TestCollectStateFilesRefusesOversizeByName(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "History"), make([]byte, 4096), 0o644); err != nil {
		t.Fatal(err)
	}
	kept, dropped := CollectStateFiles(root, 1024)
	if len(kept) != 0 {
		t.Fatalf("a 4 KiB file must not pass a 1 KiB ceiling: %v", paths(kept))
	}
	if len(dropped) != 1 || dropped[0].Reason != ReasonStateTooLarge {
		t.Fatalf("want %s, got %+v", ReasonStateTooLarge, dropped)
	}
}

func TestCollectStateFilesSkipsDirectoriesAsPathsNotFiles(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "Sessions"), 0o755); err != nil {
		t.Fatal(err)
	}
	kept, _ := CollectStateFiles(root, 0)
	if len(kept) != 0 {
		t.Fatalf("a directory is not a state file: %v", paths(kept))
	}
}

func TestSelectStateFilesFullSendsEverything(t *testing.T) {
	collected, _ := CollectStateFiles(makeProfile(t), 0)
	got, missing := SelectStateFiles(collected, StatePathPlan{Mode: SyncModeFull})
	if len(got) != len(collected) || len(missing) != 0 {
		t.Fatalf("full must send everything: got=%d want=%d missing=%v", len(got), len(collected), missing)
	}
	// An UNKNOWN mode must also send everything: that is the only safe reading of
	// a plan we do not understand.
	got2, _ := SelectStateFiles(collected, StatePathPlan{Mode: "what"})
	if len(got2) != len(collected) {
		t.Fatalf("an unknown mode must fall back to full, got %d of %d", len(got2), len(collected))
	}
}

func TestSelectStateFilesDeltaSendsOnlyAsked(t *testing.T) {
	collected, _ := CollectStateFiles(makeProfile(t), 0)
	got, missing := SelectStateFiles(collected, StatePathPlan{
		Mode: SyncModeDelta,
		// Mixed spelling on purpose: Windows separators must match the manifest's.
		RequestedPaths: []string{"History", "sessions\\Session_1234"},
	})
	if len(missing) != 0 {
		t.Fatalf("both requested paths exist and must match: %v", missing)
	}
	if len(got) != 2 {
		t.Fatalf("delta must send exactly 2 files, sent %v", paths(got))
	}
}

func TestSelectStateFilesNamesARequestItCannotSatisfy(t *testing.T) {
	collected, _ := CollectStateFiles(makeProfile(t), 0)
	got, missing := SelectStateFiles(collected, StatePathPlan{
		Mode:           SyncModeDelta,
		RequestedPaths: []string{"History", "Web Data"},
	})
	if len(got) != 1 {
		t.Fatalf("only History exists, got %v", paths(got))
	}
	if len(missing) != 1 || missing[0].Path != "Web Data" || missing[0].Reason != "state_requested_file_missing" {
		t.Fatalf("an unsatisfiable request must be named: %+v", missing)
	}
}

func TestSyncStateCarriesAProfileEndToEnd(t *testing.T) {
	root := makeProfile(t)

	var mu sync.Mutex
	planCalls, fileCalls, finalizeCalls := 0, 0, 0
	var planned []FileFingerprint
	seenHeaders := map[string]string{}
	uploaded := map[int]string{}
	var encodedPaths []string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("authorization"); got != "Bearer tok" {
			t.Errorf("authorization = %q", got)
		}
		switch r.URL.Query().Get("stage") {
		case "plan":
			mu.Lock()
			planCalls++
			var body struct {
				Files []FileFingerprint `json:"files"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			planned = body.Files
			mu.Unlock()
			// Answer with a DELTA asking for two files and one removal.
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok": true, "mode": "delta", "reason": "sync_on_reconnect",
				"requested_paths": []string{"History", "Bookmarks"},
				"removed_paths":   []string{"Old Thing"},
				"cached_files":    9,
			})
		case "file":
			mu.Lock()
			fileCalls++
			seenHeaders["path_encoded"] = r.Header.Get("x-sw-profile-path")
			encodedPaths = append(encodedPaths, r.Header.Get("x-sw-profile-path"))
			seenHeaders["job"] = r.Header.Get("x-sw-clone-job")
			seenHeaders["browser"] = r.Header.Get("x-sw-browser")
			seenHeaders["profile"] = r.Header.Get("x-sw-profile")
			seenHeaders["ctype"] = r.Header.Get("content-type")
			buf := make([]byte, r.ContentLength)
			_, _ = r.Body.Read(buf)
			uploaded[fileCalls] = string(buf)
			mu.Unlock()
			w.WriteHeader(http.StatusAccepted)
			_, _ = w.Write([]byte(`{"ok":true,"bytes":1}`))
		case "finalize":
			mu.Lock()
			finalizeCalls++
			var body struct {
				Removed []string `json:"removed"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			if len(body.Removed) != 1 || body.Removed[0] != "Old Thing" {
				t.Errorf("finalize removed = %v", body.Removed)
			}
			mu.Unlock()
			_, _ = w.Write([]byte(`{"ok":true,"removed":1}`))
		default:
			w.WriteHeader(http.StatusBadRequest)
		}
	}))
	defer srv.Close()

	res := SyncState(context.Background(), StateSyncOptions{
		BaseURL:     srv.URL,
		Token:       "tok",
		CloneJobID:  "job-1",
		DeviceID:    "dev-1",
		Browser:     "CHROME",
		ProfileName: "Default",
		Version:     "141.0.7390.55",
		ProfileDir:  root,
		Now:         func() time.Time { return time.Unix(1000, 0).UTC() },
	})

	if res.Failed != "" {
		t.Fatalf("unexpected failure %q (%+v)", res.Failed, res.Skipped)
	}
	if res.Mode != "delta" || res.Reason != "sync_on_reconnect" {
		t.Fatalf("mode/reason not carried: %q/%q", res.Mode, res.Reason)
	}
	if res.Sent != 2 || fileCalls != 2 {
		t.Fatalf("a delta of 2 must send exactly 2 files: sent=%d calls=%d", res.Sent, fileCalls)
	}
	if res.Removed != 1 {
		t.Fatalf("removals must be applied at finalize: %d", res.Removed)
	}
	if planCalls != 1 || finalizeCalls != 1 {
		t.Fatalf("plan/finalize must each happen once: %d/%d", planCalls, finalizeCalls)
	}
	if res.Bytes != int64(len("sqlite-history")+len("{}")) {
		t.Fatalf("bytes must be counted as sent, got %d", res.Bytes)
	}

	// THE DECLARED MANIFEST MUST DESCRIBE THE WHOLE PROFILE, not just the delta —
	// that is what lets the server compute a delta at all.
	if len(planned) != 5 {
		t.Fatalf("plan declared %d files, want 5", len(planned))
	}
	for _, f := range planned {
		if f.Size <= 0 || f.ModTime == 0 {
			t.Errorf("a fingerprint with no size/mtime makes a delta unsafe: %+v", f)
		}
		if strings.Contains(strings.ToLower(f.Path), "cookie") || strings.Contains(strings.ToLower(f.Path), "login data") {
			t.Errorf("a credential file reached the manifest: %s", f.Path)
		}
	}
	// The bytes must arrive unmangled: a raw octet-stream body, not a re-encoded
	// JSON string. Order follows the manifest (sorted), so this asserts the SET —
	// what matters is that exactly these two files and no others crossed the wire.
	joined := uploaded[1] + uploaded[2]
	if !strings.Contains(joined, "sqlite-history") || !strings.Contains(joined, "{}") {
		t.Fatalf("the bytes did not round-trip: %q", joined)
	}
	if len(joined) != len("sqlite-history")+len("{}") {
		t.Fatalf("extra bytes crossed the wire: %q", joined)
	}

	// The path header must be URL-ENCODED, because a profile path contains spaces
	// and backslashes; the encoding is why it travels as a header at all. Whatever
	// was sent must decode back to a path the server can use, or the file lands
	// under a mangled name and the replica is quietly wrong.
	if len(encodedPaths) != 2 {
		t.Fatalf("expected 2 encoded paths, got %d", len(encodedPaths))
	}
	for _, enc := range encodedPaths {
		dec, err := url.QueryUnescape(enc)
		if err != nil {
			t.Fatalf("an encoded path must decode: %q (%v)", enc, err)
		}
		if dec != "History" && dec != "Bookmarks" {
			t.Fatalf("decoded to an unexpected path: %q", dec)
		}
	}
	if seenHeaders["browser"] != "chrome" {
		t.Errorf("browser must be lowercased, got %q", seenHeaders["browser"])
	}
	if seenHeaders["job"] != "job-1" || seenHeaders["profile"] != "Default" {
		t.Errorf("job/profile headers wrong: %v", seenHeaders)
	}
	if seenHeaders["ctype"] != "application/octet-stream" {
		t.Errorf("a file must go as a raw stream, got %q", seenHeaders["ctype"])
	}
}

func TestSyncStateReportsAPlanRefusalByName(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()

	res := SyncState(context.Background(), StateSyncOptions{
		BaseURL: srv.URL, Token: "tok", CloneJobID: "j", DeviceID: "d",
		Browser: "chrome", ProfileDir: makeProfile(t),
	})
	if res.Failed != ReasonStatePlanFailed {
		t.Fatalf("want %s, got %q", ReasonStatePlanFailed, res.Failed)
	}
}

func TestSyncStateWithoutCredentialsFailsBeforeTheNetwork(t *testing.T) {
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
	}))
	defer srv.Close()

	res := SyncState(context.Background(), StateSyncOptions{
		BaseURL: srv.URL, ProfileDir: makeProfile(t),
	})
	if res.Failed == "" {
		t.Fatal("a state sync with no token must be refused")
	}
	if called {
		t.Fatal("nothing may be sent without a token")
	}
}

func TestSyncStateNamesAFileUploadThatFailed(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "History"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Query().Get("stage") {
		case "plan":
			_, _ = w.Write([]byte(`{"ok":true,"mode":"full","reason":"first_clone"}`))
		case "file":
			w.WriteHeader(http.StatusInternalServerError)
		case "finalize":
			_, _ = w.Write([]byte(`{"ok":true,"removed":0}`))
		}
	}))
	defer srv.Close()

	res := SyncState(context.Background(), StateSyncOptions{
		BaseURL: srv.URL, Token: "tok", CloneJobID: "j", DeviceID: "d",
		Browser: "chrome", ProfileDir: root,
	})
	if res.Sent != 0 {
		t.Fatalf("a failed upload must not count as sent: %d", res.Sent)
	}
	found := false
	for _, s := range res.Skipped {
		if s.Path == "History" && s.Reason == ReasonStateUploadFailed {
			found = true
		}
	}
	if !found {
		t.Fatalf("the refused file must be named, got %+v", res.Skipped)
	}
	// Finalize must STILL run: the files that did land are worth recording, and one
	// bad file must not discard the whole transfer's baseline.
	if res.Failed != "" {
		t.Fatalf("a per-file failure is not a whole-sync failure: %q", res.Failed)
	}
}

// The wiring test: the state half must run for EVERY route, including the ones
// that return early. A refused cookie capture (an unsupported browser, a profile
// that cannot be read) must not also cost the user their tabs — that is a
// different failure and a different half of the feature.
func TestRunnerStateSyncRunsEvenWhenTheCaptureRouteIsRefused(t *testing.T) {
	stages := map[string]int{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		stages[r.URL.Query().Get("stage")]++
		switch r.URL.Query().Get("stage") {
		case "plan":
			_, _ = w.Write([]byte(`{"ok":true,"mode":"full","reason":"first_clone"}`))
		case "finalize":
			_, _ = w.Write([]byte(`{"ok":true,"removed":0}`))
		}
	}))
	defer srv.Close()

	runner := &Runner{
		Waiter: RealWaiter(),
		StateSync: &StateSyncOptions{
			BaseURL: srv.URL, Token: "tok", CloneJobID: "job-1", DeviceID: "dev-1",
			Browser: "chrome", ProfileDir: makeProfile(t),
		},
	}
	out := runner.Run(Input{}, "job-1", "source", DefaultTimeouts())

	if out.State == nil {
		t.Fatal("the state half did not run alongside a refused capture")
	}
	if out.State.Failed != "" {
		t.Fatalf("the state half failed: %q", out.State.Failed)
	}
	if out.State.Mode != "full" || out.State.Reason != "first_clone" {
		t.Fatalf("the decision was not recorded: %q/%q", out.State.Mode, out.State.Reason)
	}
	if stages["plan"] != 1 || stages["finalize"] != 1 {
		t.Fatalf("plan/finalize must each run once, got %v", stages)
	}
}

// And the other half of that contract: a capture that does NOT ask for state must
// not touch the filesystem at all. This is what keeps every existing caller's
// behaviour byte-identical.
func TestRunnerWithoutStateSyncTouchesNothing(t *testing.T) {
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
	}))
	defer srv.Close()

	runner := &Runner{Waiter: RealWaiter()}
	out := runner.Run(Input{}, "job-1", "source", DefaultTimeouts())

	if out.State != nil {
		t.Fatalf("no state was requested, yet one was reported: %+v", out.State)
	}
	if called {
		t.Fatal("no state was requested, yet the network was touched")
	}
}
