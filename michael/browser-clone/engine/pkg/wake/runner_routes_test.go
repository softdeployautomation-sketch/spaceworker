package wake

import (
	"os"
	"testing"
)

// TestWakeNeverLaunchesWhenThePlanIsNotSilent: if a future edit produced a plan
// that is not provably window-free, the runner refuses instead of showing a
// browser. This is the guard rail for the hard requirement.
func TestWakeNeverLaunchesWhenThePlanIsNotSilent(t *testing.T) {
	h := newHarness(t, cleanPrefs)
	plan := Decide(chromeInput())
	plan.Headless = false // the shape that must never ship
	plan.NeedsLaunch = false

	out := h.runner.wake(plan, "job-1", "headless-wake", DefaultTimeouts(), h.clock.Now())

	if out.Reason != ReasonWakeNotSilent {
		t.Fatalf("reason = %q, want %q", out.Reason, ReasonWakeNotSilent)
	}
	if h.launcher.started != 0 {
		t.Fatal("a non-silent plan must not start a process at all")
	}
}

// TestWakeRefusesTamperedArgv: argv that does not itself prove headless is
// refused, so a lost --headless cannot be papered over by the Headless field.
func TestWakeRefusesTamperedArgv(t *testing.T) {
	h := newHarness(t, cleanPrefs)
	plan := Decide(chromeInput())
	plan.Args = []string{"https://example.com"} // a URL in argv

	out := h.runner.wake(plan, "job-1", "headless-wake", DefaultTimeouts(), h.clock.Now())

	if out.Reason != ReasonWakeNotSilent {
		t.Fatalf("reason = %q, want %q", out.Reason, ReasonWakeNotSilent)
	}
	if h.launcher.started != 0 {
		t.Fatal("argv containing a URL must never be launched")
	}
}

// TestLaunchFailureLeavesNoPendingRequest: if the binary will not start, the
// request must be cleaned up, or the user's next ordinary browser launch could
// pick it up and capture without anybody asking.
func TestLaunchFailureLeavesNoPendingRequest(t *testing.T) {
	h := newHarness(t, cleanPrefs)
	h.launcher.err = os.ErrPermission

	out := h.runner.Run(chromeInput(), "job-1", "headless-wake", DefaultTimeouts())

	if out.Reason != ReasonWakeFailed {
		t.Fatalf("reason = %q, want %q", out.Reason, ReasonWakeFailed)
	}
	if out.Woke || out.Stopped {
		t.Fatalf("nothing started, so nothing may be reported as started/stopped: %+v", out)
	}
	if _, err := os.Stat(h.reqPath); !os.IsNotExist(err) {
		t.Fatal("a failed launch must not leave a claimable request behind")
	}
}

// ---------------------------------------------------------------------------
// The routes that must NOT launch anything.
// ---------------------------------------------------------------------------

// TestRefusedRoutesNeverLaunchAnything: every refusal is silent and side-effect
// free, which is what lets the caller report a reason instead of apologising for
// a browser window.
func TestRefusedRoutesNeverLaunchAnything(t *testing.T) {
	cases := map[string]Input{
		"wake not permitted": func() Input { i := chromeInput(); i.WakePermitted = false; return i }(),
		"profile locked":     func() Input { i := chromeInput(); i.ProfileLocked = true; return i }(),
		"browser missing":    func() Input { i := chromeInput(); i.BinaryPath = ""; return i }(),
		"unsupported":        {Browser: "safari", BinaryPath: "/x", Version: "17"},
	}
	for name, in := range cases {
		t.Run(name, func(t *testing.T) {
			h := newHarness(t, cleanPrefs)
			out := h.runner.Run(in, "job-1", "headless-wake", DefaultTimeouts())
			if out.Reason == "" || out.Route != RouteRefused {
				t.Fatalf("want a named refusal, got route=%q reason=%q", out.Route, out.Reason)
			}
			if h.launcher.started != 0 {
				t.Fatal("a refused route must never start a process")
			}
			if out.Woke || out.Stopped {
				t.Fatalf("no side effects expected: %+v", out)
			}
		})
	}
}

// TestLocalReadRoutesNeverLaunch: a Firefox profile and an old Chromium can be
// read from their files, so no process is created — the cheapest and quietest of
// all outcomes.
func TestLocalReadRoutesNeverLaunch(t *testing.T) {
	cases := map[string]Input{
		"firefox":     {Browser: "firefox", Version: "139.0", DataPath: `C:\ff`},
		"chromium126": {Browser: "edge", Version: "126.0.2592.87", BinaryPath: `C:\msedge.exe`},
	}
	for name, in := range cases {
		t.Run(name, func(t *testing.T) {
			h := newHarness(t, cleanPrefs)
			out := h.runner.Run(in, "job-1", "local-read", DefaultTimeouts())
			if !out.NeedsLocalRead {
				t.Fatalf("the caller must be told to read locally: %+v", out)
			}
			if h.launcher.started != 0 {
				t.Fatal("a local read must not start a process")
			}
			if out.Reason != "" {
				t.Fatalf("unexpected reason %q", out.Reason)
			}
		})
	}
}

// TestRunningBrowserUsesTheExtensionWithoutLaunching: when the user's browser is
// already open, the extension reads in-process. Launching here would be the one
// realistic way to put a window on their screen, so it must not happen.
func TestRunningBrowserUsesTheExtensionWithoutLaunching(t *testing.T) {
	h := newHarness(t, cleanPrefs)
	h.playExtension(1, 900, 41)

	in := chromeInput()
	in.Running = true
	out := h.runner.Run(in, "job-1", "extension", DefaultTimeouts())

	if out.Route != RouteExtension {
		t.Fatalf("route = %q, want %q", out.Route, RouteExtension)
	}
	if h.launcher.started != 0 {
		t.Fatal("a running browser must never be launched again")
	}
	if out.Woke || out.Stopped {
		t.Fatalf("no launch side effects expected: %+v", out)
	}
	if out.Result.Accepted != 900 {
		t.Fatalf("counts = %+v, want 900", out.Result)
	}
}

// TestStaleResultCannotSatisfyANewCapture: a leftover from an earlier run must be
// cleared, or the caller would report old counts as if they were fresh.
func TestStaleResultCannotSatisfyANewCapture(t *testing.T) {
	h := newHarness(t, cleanPrefs)
	if err := WriteResult(h.resPath, CaptureResult{
		Nonce: "from-an-earlier-run", Status: "success", Accepted: 5,
	}, h.clock.Now()); err != nil {
		t.Fatal(err)
	}
	in := chromeInput()
	in.Running = true

	out := h.runner.Run(in, "job-1", "extension", DefaultTimeouts())

	if out.Reason != ReasonNoExtensionAnswer {
		t.Fatalf("a stale result must not be accepted: %+v", out)
	}
	if out.Result.Accepted != 0 {
		t.Fatalf("stale counts leaked into the result: %+v", out.Result)
	}
}
