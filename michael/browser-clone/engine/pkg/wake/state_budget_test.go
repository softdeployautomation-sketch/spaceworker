package wake

// Tests for the BUDGET half of a state run: what happens when a whole profile
// does not fit in one command.
//
// This is the difference between a feature that works and one that works on a
// small profile and silently half-works on a real one. The platform runs the
// device command under a timeout; a first clone of a real profile takes longer
// than that. So a run must be able to STOP at a file boundary, say how much is
// left, and still record what landed — and the next run must then send only the
// remainder.
//
// The run's clock is injected (StateSyncOptions.Now), so the budget is tested
// exactly rather than by sleeping.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// steppingClock advances a fixed amount on every read, so a run's budget expires
// after a predictable number of files.
func steppingClock(step time.Duration) func() time.Time {
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	var calls int
	return func() time.Time {
		calls++
		return base.Add(time.Duration(calls) * step)
	}
}

type runCounters struct {
	mu        sync.Mutex
	plans     int
	files     int
	finalizes int
	declared  []FileFingerprint
	paths     []string
}

func (c *runCounters) snapshot() (plans, files, finalizes int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.plans, c.files, c.finalizes
}

// stateServer counts what reached the wire and answers every plan with the given
// decision.
func stateServer(t *testing.T, plan map[string]any) (*httptest.Server, *runCounters) {
	t.Helper()
	counters := &runCounters{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Query().Get("stage") {
		case "plan":
			counters.mu.Lock()
			counters.plans++
			var body struct {
				Files []FileFingerprint `json:"files"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			counters.declared = body.Files
			counters.mu.Unlock()
			_ = json.NewEncoder(w).Encode(plan)
		case "file":
			counters.mu.Lock()
			counters.files++
			counters.paths = append(counters.paths, r.Header.Get("x-sw-profile-path"))
			counters.mu.Unlock()
			_, _ = w.Write([]byte(`{"ok":true}`))
		case "finalize":
			counters.mu.Lock()
			counters.finalizes++
			counters.mu.Unlock()
			_, _ = w.Write([]byte(`{"ok":true}`))
		default:
			w.WriteHeader(http.StatusBadRequest)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, counters
}

// fullPlan is the server's answer to a genuine first clone.
func fullPlan() map[string]any {
	return map[string]any{
		"ok": true, "mode": "full", "reason": "first_clone",
		"requested_paths": []string{}, "removed_paths": []string{},
	}
}

// syncOptions is the boilerplate every test in this file shares.
func syncOptions(srv *httptest.Server, profileDir string) StateSyncOptions {
	return StateSyncOptions{
		BaseURL:     srv.URL,
		Token:       "tok",
		CloneJobID:  "job-1",
		DeviceID:    "dev-1",
		Browser:     "chrome",
		ProfileName: "Default",
		ProfileDir:  profileDir,
	}
}

func TestSyncStateStopsAtAFileBoundaryWhenTheBudgetExpires(t *testing.T) {
	profile := makeProfile(t)
	srv, counters := stateServer(t, fullPlan())

	opts := syncOptions(srv, profile)
	opts.Budget = 2 * time.Second
	opts.Now = steppingClock(time.Second)

	res := SyncState(context.Background(), opts)
	if res.Failed != "" {
		t.Fatalf("a budgeted run must not fail: %s", res.Failed)
	}
	if res.Done {
		t.Fatal("Done must be false when files were left unsent")
	}
	// A PARTIAL send, not nothing and not everything: the budget has to stop the
	// run IN the list, which is what lets the remainder continue rather than
	// restart from the beginning.
	if res.Sent < 1 {
		t.Fatalf("Sent = %d, want at least one file before the budget expired", res.Sent)
	}
	if res.Pending < 1 {
		t.Fatal("Pending must report the files this run did not send")
	}
	if _, files, finalizes := counters.snapshot(); files != res.Sent || finalizes != 1 {
		t.Fatalf("wire says files=%d finalizes=%d, result says sent=%d", files, finalizes, res.Sent)
	}
}

func TestSyncStateFinalizesEvenWhenTheBudgetStopsTheRun(t *testing.T) {
	// THE POINT OF THE WHOLE MECHANISM. Finalize is what records the bytes that
	// DID land as the next baseline. Skipping it on a partial run would leave
	// those bytes unrecorded, and the next run would send them all again — so a
	// transfer larger than one command would never converge.
	profile := makeProfile(t)
	srv, counters := stateServer(t, fullPlan())

	opts := syncOptions(srv, profile)
	opts.Budget = time.Nanosecond // expires before the first file
	opts.Now = steppingClock(time.Second)

	res := SyncState(context.Background(), opts)
	if res.Sent != 0 {
		t.Fatalf("expected no files sent, got %d", res.Sent)
	}
	if res.Pending == 0 {
		t.Fatal("Pending must be non-zero when nothing was sent")
	}
	if res.Done {
		t.Fatal("Done must be false")
	}
	if _, _, finalizes := counters.snapshot(); finalizes != 1 {
		t.Fatalf("finalize ran %d times, want exactly 1 — the landed bytes must be recorded", finalizes)
	}
}

func TestSyncStateWithoutABudgetSendsEverythingAndSaysItIsDone(t *testing.T) {
	profile := makeProfile(t)
	srv, counters := stateServer(t, fullPlan())

	res := SyncState(context.Background(), syncOptions(srv, profile))
	if res.Failed != "" {
		t.Fatalf("failed: %s", res.Failed)
	}
	if !res.Done {
		t.Fatalf("Done must be true when the whole selection was sent (pending=%d)", res.Pending)
	}
	if res.Pending != 0 {
		t.Fatalf("Pending = %d, want 0", res.Pending)
	}
	if res.Sent == 0 {
		t.Fatal("a profile with state in it must send something")
	}
	if _, files, _ := counters.snapshot(); files != res.Sent {
		t.Fatalf("wire files=%d, result sent=%d — the reported count must be the real one", files, res.Sent)
	}
}

func TestSyncStateDeclaresContentHashes(t *testing.T) {
	// Without a hash the only cross-machine comparison is size+mtime, and a
	// staged copy's mtime is a SERVER clock value — so every file would look
	// changed on the next run and a resumed transfer would re-send everything.
	// The hash is what makes "already landed" knowable.
	profile := makeProfile(t)
	srv, counters := stateServer(t, fullPlan())

	if res := SyncState(context.Background(), syncOptions(srv, profile)); res.Failed != "" {
		t.Fatalf("failed: %s", res.Failed)
	}

	counters.mu.Lock()
	declared := append([]FileFingerprint{}, counters.declared...)
	counters.mu.Unlock()
	if len(declared) == 0 {
		t.Fatal("the plan declared no files")
	}
	for _, f := range declared {
		if len(f.SHA256) != 64 {
			t.Fatalf("%s: sha256 = %q, want a 64-character hex digest", f.Path, f.SHA256)
		}
	}
}

func TestSyncStateWithNothingToSendIsDoneNotFailed(t *testing.T) {
	// An already-current replica must report success with no work, so the caller
	// has no reason to run again.
	empty := t.TempDir()
	srv, counters := stateServer(t, fullPlan())

	res := SyncState(context.Background(), syncOptions(srv, empty))
	if res.Failed != "" {
		t.Fatalf("an empty profile is not a failure: %s", res.Failed)
	}
	if !res.Done {
		t.Fatal("Done must be true when there is nothing to send")
	}
	if _, files, finalizes := counters.snapshot(); files != 0 || finalizes != 1 {
		t.Fatalf("files=%d finalizes=%d, want 0 and 1", files, finalizes)
	}
}

func TestSyncStateSendsOnlyWhatTheServerAskedFor(t *testing.T) {
	// The convergence case on the device side: the second run is told to send
	// only what is missing, and sends exactly that — nothing already landed,
	// nothing that was never asked for.
	profile := makeProfile(t)
	srv, counters := stateServer(t, map[string]any{
		"ok": true, "mode": "delta", "reason": "sync_on_reconnect",
		"requested_paths": []string{"History", "Bookmarks"}, "removed_paths": []string{},
		"cached_files": 7,
	})

	res := SyncState(context.Background(), syncOptions(srv, profile))
	if res.Failed != "" {
		t.Fatalf("failed: %s", res.Failed)
	}
	if res.Mode != "delta" || res.Reason != "sync_on_reconnect" {
		t.Fatalf("mode/reason = %s/%s, want the server's own decision echoed", res.Mode, res.Reason)
	}
	counters.mu.Lock()
	paths := append([]string{}, counters.paths...)
	counters.mu.Unlock()
	if len(paths) != 2 || res.Sent != 2 {
		t.Fatalf("sent %d files (result says %d), want the 2 requested ones (%v)", len(paths), res.Sent, paths)
	}
}

func TestSelectStateFilesIgnoresRequestedPathsWhenTheModeIsFull(t *testing.T) {
	// A full plan means "send what you have". If a full plan happened to carry
	// requested paths, honouring them would silently send a fraction of the
	// replica — so the mode decides, not the list.
	files := []StateFile{
		{Fingerprint: FileFingerprint{Path: "History", Size: 1}, Abs: filepath.Join("x", "History")},
		{Fingerprint: FileFingerprint{Path: "Bookmarks", Size: 1}, Abs: filepath.Join("x", "Bookmarks")},
	}
	selected, missing := SelectStateFiles(files, StatePathPlan{
		Mode: "full", Reason: "first_clone", RequestedPaths: []string{"History"},
	})
	if len(selected) != 2 || len(missing) != 0 {
		t.Fatalf("full mode selected %d files (missing=%d), want all 2", len(selected), len(missing))
	}
}
