package wake

import (
	"strings"
	"testing"
)

// TestWakeArgsAreWindowFree asserts the exact argv, including what must NOT be in
// it. If this test fails, a capture could be visible on someone's laptop.
func TestWakeArgsAreWindowFree(t *testing.T) {
	in := chromeInput()
	args := WakeArgs(in)
	joined := strings.Join(args, " ")

	if len(args) == 0 || args[0] != "--headless=new" {
		t.Fatalf("first arg must be --headless=new, got %v", args)
	}
	for _, want := range []string{
		"--user-data-dir=" + in.DataPath,
		"--profile-directory=Default",
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-sync",
		"--disable-component-update",
		"--disable-background-networking",
		"--disable-gpu",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("args missing %q: %v", want, args)
		}
	}
	// No URL may ever appear, and the default-profile debug port is both blocked
	// by Chrome (136+) and unnecessary — the extension is the reader.
	for _, forbidden := range []string{"http://", "https://", "file://", "--remote-debugging-port", "--app="} {
		if strings.Contains(joined, forbidden) {
			t.Fatalf("args must not contain %q: %v", forbidden, args)
		}
	}
	// The ABE-bound path is the real one, never a copy: a relocated profile has
	// its cookie rows deleted by Chrome (TASK_117 F11).
	if !strings.Contains(joined, in.DataPath) {
		t.Fatalf("args must target the real user-data-dir: %v", args)
	}
}

// TestWakeArgsOmitProfileDirectoryWhenUnknown: an empty --profile-directory=
// would be an empty flag value, which Chrome treats as a profile named "".
func TestWakeArgsOmitProfileDirectoryWhenUnknown(t *testing.T) {
	in := chromeInput()
	in.ProfileName = ""
	for _, a := range WakeArgs(in) {
		if strings.HasPrefix(a, "--profile-directory=") {
			t.Fatalf("empty profile name must omit the flag, got %q", a)
		}
	}
}

func TestValidateRejectsVisibleOrUrlPlans(t *testing.T) {
	// A launch without the headless flag is the one shape that must never ship.
	if err := (Plan{NeedsLaunch: true, Headless: false, Binary: "chrome.exe",
		Args: []string{"--headless=new"}}).Validate(); err == nil {
		t.Fatal("a launch without the headless flag must be rejected")
	}
	// argv that does not itself prove headless.
	if err := (Plan{NeedsLaunch: true, Headless: true, Binary: "chrome.exe",
		Args: []string{"about:blank"}}).Validate(); err == nil {
		t.Fatal("argv without --headless must be rejected")
	}
	// A URL in argv would open a tab if --headless were ever lost.
	if err := (Plan{NeedsLaunch: true, Headless: true, Binary: "chrome.exe",
		Args: []string{"--headless=new", "https://example.com"}}).Validate(); err == nil {
		t.Fatal("a URL in argv must be rejected")
	}
	if err := (Plan{NeedsLaunch: true, Headless: true, Binary: "",
		Args: []string{"--headless=new"}}).Validate(); err == nil {
		t.Fatal("a launch plan without a binary must be rejected")
	}
	if err := (Plan{NeedsLaunch: true, Headless: true, Binary: "chrome.exe",
		Args: []string{"--headless=new"}}).Validate(); err != nil {
		t.Fatalf("a valid plan must be accepted: %v", err)
	}
	// A non-launch plan is always valid: nothing can be shown.
	if err := (Plan{Route: RouteDPAPI}).Validate(); err != nil {
		t.Fatalf("a non-launch plan must be accepted: %v", err)
	}
}

// TestEveryLaunchRouteHasAFullArgv guards the coupling between Decide and
// WakeArgs: if a new launch route is added without args, this fails rather than
// shipping a browser started with no flags at all.
func TestEveryLaunchRouteHasAFullArgv(t *testing.T) {
	plan := Decide(chromeInput())
	if !plan.NeedsLaunch {
		t.Fatal("chrome 141 closed should need a launch")
	}
	if len(plan.Args) < 5 {
		t.Fatalf("suspiciously short argv: %v", plan.Args)
	}
	if plan.Args[0] != "--headless=new" {
		t.Fatalf("argv must lead with headless: %v", plan.Args)
	}
}
