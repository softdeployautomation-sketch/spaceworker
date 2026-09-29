package wake

import (
	"testing"

	"spaceworker.browser-clone/pkg/types"
)

// chromeInput is a healthy, closed Chrome 141 on a Windows laptop — the state
// that needs the headless wake.
func chromeInput() Input {
	return Input{
		Browser:       types.BrowserChrome,
		Version:       "141.0.7390.55",
		BinaryPath:    `C:\Program Files\Google\Chrome\Application\chrome.exe`,
		DataPath:      `C:\Users\u\AppData\Local\Google\Chrome\User Data`,
		ProfilePath:   `C:\Users\u\AppData\Local\Google\Chrome\User Data\Default`,
		ProfileName:   "Default",
		WakePermitted: true,
	}
}

// TestDecideMatrix pins every branch of the silence rule against a state a real
// device reaches. The expected route is what keeps a capture invisible.
func TestDecideMatrix(t *testing.T) {
	cases := []struct {
		name        string
		in          Input
		wantRoute   Route
		wantReason  string
		wantLaunch  bool
		wantFallbck Route
	}{
		{
			name:      "firefox closed is a plain file read",
			in:        Input{Browser: types.BrowserFirefox, Version: "139.0", DataPath: `C:\ff`},
			wantRoute: RouteFileCopy,
		},
		{
			name:      "firefox running still needs no process",
			in:        Input{Browser: types.BrowserFirefox, Version: "139.0", Running: true, DataPath: `C:\ff`},
			wantRoute: RouteFileCopy,
		},
		{
			name:      "chromium 126 closed reads the DPAPI key, no launch",
			in:        Input{Browser: types.BrowserEdge, Version: "126.0.2592.87", BinaryPath: `C:\msedge.exe`, DataPath: `C:\UD`},
			wantRoute: RouteDPAPI,
		},
		{
			name:       "chromium 141 closed wakes headless",
			in:         chromeInput(),
			wantRoute:  RouteHeadlessWake,
			wantLaunch: true,
		},
		{
			name:        "unknown version wakes headless but tries the cheap read first",
			in:          func() Input { i := chromeInput(); i.Version = "unknown"; return i }(),
			wantRoute:   RouteHeadlessWake,
			wantLaunch:  true,
			wantFallbck: RouteDPAPI,
		},
		{
			name:      "chromium 141 running uses the extension, no launch",
			in:        func() Input { i := chromeInput(); i.Running = true; return i }(),
			wantRoute: RouteExtension,
		},
		{
			name:       "closed 141 with wake not permitted refuses by name",
			in:         func() Input { i := chromeInput(); i.WakePermitted = false; return i }(),
			wantRoute:  RouteRefused,
			wantReason: ReasonWakeNotPermitted,
		},
		{
			name:       "a stale lock refuses rather than fighting the user's session",
			in:         func() Input { i := chromeInput(); i.ProfileLocked = true; return i }(),
			wantRoute:  RouteRefused,
			wantReason: ReasonProfileLocked,
		},
		{
			name:       "missing binary refuses",
			in:         func() Input { i := chromeInput(); i.BinaryPath = ""; return i }(),
			wantRoute:  RouteRefused,
			wantReason: ReasonBrowserNotFound,
		},
		{
			name:       "unsupported browser refuses",
			in:         Input{Browser: "safari", Version: "17", BinaryPath: "/x"},
			wantRoute:  RouteRefused,
			wantReason: ReasonUnsupportedBrowser,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := Decide(tc.in)
			if got.Route != tc.wantRoute {
				t.Fatalf("route = %q, want %q (reason %q)", got.Route, tc.wantRoute, got.Reason)
			}
			if got.Reason != tc.wantReason {
				t.Fatalf("reason = %q, want %q", got.Reason, tc.wantReason)
			}
			if got.NeedsLaunch != tc.wantLaunch {
				t.Fatalf("needs_launch = %v, want %v", got.NeedsLaunch, tc.wantLaunch)
			}
			if got.FallbackRoute != tc.wantFallbck {
				t.Fatalf("fallback = %q, want %q", got.FallbackRoute, tc.wantFallbck)
			}
			// The invariant that matters: a launch is ALWAYS headless, and a
			// non-launch route NEVER carries argv.
			if got.NeedsLaunch {
				if !got.Headless {
					t.Fatal("a launch plan must be headless")
				}
				if err := got.Validate(); err != nil {
					t.Fatalf("validate: %v", err)
				}
			} else if len(got.Args) != 0 {
				t.Fatalf("non-launch plan carries args: %v", got.Args)
			}
		})
	}
}

func TestMajorVersion(t *testing.T) {
	cases := map[string]int{
		"141.0.7390.55": 141,
		"126":           126,
		"127.0.6533.99": 127,
		"unknown":       0,
		"":              0,
		"abc":           0,
		"v141.0":        0, // not a version we can act on — the caller must not guess
	}
	for in, want := range cases {
		if got := MajorVersion(in); got != want {
			t.Errorf("MajorVersion(%q) = %d, want %d", in, got, want)
		}
	}
}
