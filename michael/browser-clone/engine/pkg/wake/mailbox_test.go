package wake

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// fakeClock is the Waiter seam: no real sleeping, and a hook so a test can play
// the other side of the handshake at a chosen moment.
type fakeClock struct {
	now     time.Time
	sleeps  int
	onSleep func()
}

func newFakeClock() *fakeClock {
	return &fakeClock{now: time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)}
}

func (f *fakeClock) Now() time.Time { return f.now }

func (f *fakeClock) Sleep(d time.Duration) {
	f.now = f.now.Add(d)
	f.sleeps++
	if f.onSleep != nil {
		f.onSleep()
	}
}

func TestWriteRequestIsAtomicAndPrivate(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "capture-request.json")
	now := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)

	req, err := WriteRequest(path, CaptureRequest{CloneJobID: "job-1", Browser: "chrome"}, time.Minute, now)
	if err != nil {
		t.Fatalf("write: %v", err)
	}
	if req.Nonce == "" {
		t.Fatal("a request without a nonce could not be matched to its result")
	}
	if got, want := req.Deadline, now.Add(time.Minute).UTC().Format(time.RFC3339); got != want {
		t.Fatalf("deadline = %q, want %q", got, want)
	}
	// No temp file may survive: a reader must never see a half-written request.
	if _, err := os.Stat(path + ".tmp"); !os.IsNotExist(err) {
		t.Fatal("temp file left behind")
	}
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("request must be 0600 (it names a clone job), got %v", fi.Mode().Perm())
	}
}

func TestClaimRequestIsSingleUse(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "req.json")
	now := time.Now().UTC()
	if _, err := WriteRequest(path, CaptureRequest{CloneJobID: "j", Browser: "chrome"}, time.Minute, now); err != nil {
		t.Fatal(err)
	}

	got, ok, reason := ClaimRequest(path, now)
	if !ok || reason != "" || got.CloneJobID != "j" {
		t.Fatalf("first claim should succeed: ok=%v reason=%q req=%+v", ok, reason, got)
	}
	// THE property that stops a stale file from causing a second capture.
	if _, ok, reason := ClaimRequest(path, now); ok {
		t.Fatalf("a request must not be claimable twice (reason=%q)", reason)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("a claimed request must be removed from disk")
	}
}

func TestClaimRequestRefusesExpiredButStillRemovesIt(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "req.json")
	written := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)
	if _, err := WriteRequest(path, CaptureRequest{CloneJobID: "j", Browser: "chrome"},
		time.Minute, written); err != nil {
		t.Fatal(err)
	}
	// A request written before a weekend must not wake a browser on Monday.
	_, ok, reason := ClaimRequest(path, written.Add(time.Hour))
	if ok || reason != ReasonRequestExpired {
		t.Fatalf("expired request: ok=%v reason=%q", ok, reason)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("an expired request must be deleted, not left to be re-derived")
	}
}

func TestClaimRequestRefusesMalformedAndUnsupported(t *testing.T) {
	dir := t.TempDir()
	now := time.Now().UTC()

	bad := filepath.Join(dir, "bad.json")
	if err := os.WriteFile(bad, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, ok, reason := ClaimRequest(bad, now); ok || reason != ReasonRequestMalformed {
		t.Fatalf("malformed: ok=%v reason=%q", ok, reason)
	}

	unsupported := filepath.Join(dir, "safari.json")
	blob, _ := json.Marshal(CaptureRequest{
		Nonce:    "n",
		Browser:  "safari",
		Deadline: now.Add(time.Minute).UTC().Format(time.RFC3339),
	})
	if err := os.WriteFile(unsupported, blob, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, ok, reason := ClaimRequest(unsupported, now); ok || reason != ReasonUnsupportedBrowser {
		t.Fatalf("unsupported browser: ok=%v reason=%q", ok, reason)
	}
}

func TestClaimRequestWithNothingPendingIsNotAnError(t *testing.T) {
	// The extension polls on every alarm tick; "nothing to do" is the normal
	// case and must not look like a failure in the logs.
	if _, ok, reason := ClaimRequest(filepath.Join(t.TempDir(), "absent.json"), time.Now()); ok || reason != "" {
		t.Fatalf("absent request: ok=%v reason=%q", ok, reason)
	}
}

func TestReadResultIsNonceBound(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "capture-result.json")
	res := CaptureResult{Nonce: "n1", Status: "success", Accepted: 1204, Domains: 63}
	if err := WriteResult(path, res, time.Now()); err != nil {
		t.Fatal(err)
	}
	if got, ok := ReadResult(path, "n1"); !ok || got.Accepted != 1204 {
		t.Fatalf("matching nonce should be accepted: ok=%v got=%+v", ok, got)
	}
	// A result from an earlier capture must never satisfy this one.
	if _, ok := ReadResult(path, "n2"); ok {
		t.Fatal("a result with a different nonce must be ignored")
	}
	if _, ok := ReadResult(path, ""); ok {
		t.Fatal("an empty nonce must never match")
	}
}

func TestWaitForResultSucceedsAndTimesOut(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "capture-result.json")

	// Success: the other side answers on the second poll.
	clock := newFakeClock()
	clock.onSleep = func() {
		if clock.sleeps == 2 {
			_ = WriteResult(path, CaptureResult{Nonce: "n", Status: "success", Accepted: 7}, clock.now)
		}
	}
	res, ok, reason := WaitForResult(path, "n", clock.now.Add(time.Minute), time.Millisecond, clock)
	if !ok || reason != "" || res.Accepted != 7 {
		t.Fatalf("ok=%v reason=%q res=%+v", ok, reason, res)
	}

	// Timeout: a named reason, and the caller learns nothing arrived rather than
	// hanging until the user's next launch.
	RemoveResults(path)
	dead := newFakeClock()
	start := dead.now
	_, ok, reason = WaitForResult(path, "n", dead.now.Add(time.Minute), 250*time.Millisecond, dead)
	if ok || reason != ReasonNoExtensionAnswer {
		t.Fatalf("timeout: ok=%v reason=%q", ok, reason)
	}
	if dead.now.Sub(start) < time.Minute {
		t.Fatal("the waiter must poll until its deadline before giving up")
	}
}

func TestRemoveResultsClearsLeftovers(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "capture-result.json")
	_ = WriteResult(path, CaptureResult{Nonce: "old", Status: "success"}, time.Now())
	RemoveResults(path)
	if _, ok := ReadResult(path, "old"); ok {
		t.Fatal("a new capture must never be satisfied by an old result")
	}
}
