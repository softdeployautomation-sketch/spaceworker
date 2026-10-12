package wake

import (
	"os"
	"testing"
)

// ---------------------------------------------------------------------------
// The silent wake, end to end.
// ---------------------------------------------------------------------------

// TestWakeIsHeadlessStopsItsOwnProcessAndLeavesNoTrace is the central claim of
// this package: with the browser CLOSED, a capture still happens, nothing is left
// running, and the profile looks exactly as the user left it.
func TestWakeIsHeadlessStopsItsOwnProcessAndLeavesNoTrace(t *testing.T) {
	h := newHarness(t, cleanPrefs)
	// Real Chrome rewrites Preferences at startup, which is why the snapshot
	// exists. The fake launcher does the same, so the restore is genuinely proven.
	h.launcher.onStart = func() {
		if err := os.WriteFile(h.prefsPath,
			[]byte(`{"profile":{"exit_type":"Crashed","exited_cleanly":false,"name":"Person 1"},
			  "intl":{"app_locale":"en-GB"}}`), 0o644); err != nil {
			t.Error(err)
		}
	}
	h.playExtension(3, 1204, 63)

	in := chromeInput()
	out := h.runner.Run(in, "job-1", "headless-wake", DefaultTimeouts())

	if !out.Woke {
		t.Fatalf("a closed modern browser must be woken, got %+v", out)
	}
	if out.PID != 4242 {
		t.Fatalf("pid = %d, want the process we started", out.PID)
	}
	if !out.Stopped {
		t.Fatal("the browser we started must be stopped — an unstopped wake holds the profile lock")
	}
	if !h.launcher.proc.stopped {
		t.Fatal("the process was not actually stopped")
	}
	if out.Result.Accepted != 1204 || out.Result.Domains != 63 {
		t.Fatalf("counts = %+v, want 1204/63", out.Result)
	}
	if out.Reason != "" {
		t.Fatalf("unexpected reason %q", out.Reason)
	}
	// Headless, on the REAL profile path — not on a copy.
	if len(h.launcher.args) == 0 || h.launcher.args[0] != "--headless=new" {
		t.Fatalf("wake argv must lead with --headless=new: %v", h.launcher.args)
	}
	sawReal := false
	for _, a := range h.launcher.args {
		if a == "--user-data-dir="+in.DataPath {
			sawReal = true
		}
	}
	if !sawReal {
		t.Fatalf("wake must use the real user-data-dir: %v", h.launcher.args)
	}

	// NO TRACE: the exit state the user had is back on disk, so their next launch
	// cannot be offered "Restore pages?" because of this capture.
	back, err := os.ReadFile(h.prefsPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(back) != cleanPrefs {
		t.Fatalf("Preferences was not restored byte-for-byte:\n got %s\nwant %s", back, cleanPrefs)
	}
	if !out.Restored || out.RestoreUnverified {
		t.Fatalf("restore must be verified: restored=%v unverified=%v", out.Restored, out.RestoreUnverified)
	}
	// And the request is spent: nothing left to trigger a later capture.
	if _, err := os.Stat(h.reqPath); !os.IsNotExist(err) {
		t.Fatal("the request must not survive the capture")
	}
}

// TestWakeStopsAndRestoresWhenNothingEverAnswers is the reliability case that
// matters most in the field: the extension is disabled or was never installed,
// so nobody reads the jar. The wake must still end, quietly, and leave nothing
// behind — no browser process, no request file, no modified profile.
func TestWakeStopsAndRestoresWhenNothingEverAnswers(t *testing.T) {
	h := newHarness(t, cleanPrefs)
	h.launcher.onStart = func() {
		_ = os.WriteFile(h.prefsPath,
			[]byte(`{"profile":{"exit_type":"Crashed","exited_cleanly":false}}`), 0o644)
	}
	// No playExtension: the reader never answers.

	out := h.runner.Run(chromeInput(), "job-1", "headless-wake", DefaultTimeouts())

	if out.Reason != ReasonNoExtensionAnswer {
		t.Fatalf("reason = %q, want %q", out.Reason, ReasonNoExtensionAnswer)
	}
	if !out.Woke || !out.Stopped {
		t.Fatalf("must wake and then stop: woke=%v stopped=%v", out.Woke, out.Stopped)
	}
	if !out.Restored {
		t.Fatal("the profile must be restored even on the timeout path")
	}
	if _, err := os.Stat(h.reqPath); !os.IsNotExist(err) {
		t.Fatal("a timed-out request must be deleted: a lingering one could trigger an unannounced capture later")
	}
	back, err := os.ReadFile(h.prefsPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(back) != cleanPrefs {
		t.Fatalf("Preferences not restored on the failure path: %s", back)
	}
}
