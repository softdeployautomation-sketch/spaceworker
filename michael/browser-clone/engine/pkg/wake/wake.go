// Package wake decides how a browser's cookies can be read WITHOUT the user
// seeing anything and WITHOUT them interacting — and, when the browser is
// closed, whether it can be woken silently to read them itself.
//
// THE CONSTRAINT THIS PACKAGE EXISTS TO ENFORCE (owner, hard requirement):
// "no popups, no human interaction, none whatsoever." That is not a UX
// preference here, it is an architectural rule, expressed as data: every route
// below is either provably window-free, or it is a named refusal. There is
// deliberately no "open the browser normally and hope" branch.
//
// WHY A DECISION TREE IS NEEDED AT ALL — the cases are physically different,
// not stylistic:
//
//  1. Firefox — cookies live plainly in cookies.sqlite, logins in key4.db, and
//     the profile is portable. A FILE READ gets them: no process at all.
//  2. Chromium <=126 — cookie values are AES-GCM under a key DPAPI-wrapped in
//     `Local State`, readable OUT OF PROCESS by the same Windows user. Also no
//     process, as long as the profile is not in use.
//  3. Chromium >=127 (Chrome/Edge/Brave) — App-Bound Encryption (v20): the key
//     is released only to a path-validated browser process, a relocated copy
//     makes the browser DELETE the rows, and Chrome 136+ refuses debugging on
//     the default profile (TASK_117 F10/F11/F12). The browser itself must do
//     the reading, which leaves exactly two window-free ways to cause it:
//     - it is already running: the force-installed extension reads the cookies
//     in-process, triggered by our hidden broker (no click, ever);
//     - it is closed: start a HEADLESS instance on the REAL user-data-dir (the
//     same path — that is what the ABE key is bound to), let the extension
//     read, then stop ONLY the process we started and restore the profile's
//     exit state exactly as found.
//
// Anything else — a visible window, a profile copy, a debug port on the default
// profile — is a named refusal rather than an attempt.
package wake

import (
	"fmt"
	"strconv"
	"strings"

	"spaceworker.browser-clone/pkg/types"
)

// Route is how a capture will obtain cookie values.
type Route string

const (
	// RouteFileCopy — read profile files directly. No process is started.
	RouteFileCopy Route = "file-copy"
	// RouteDPAPI — decrypt values out-of-process with the DPAPI-wrapped key in
	// `Local State`. No process is started.
	RouteDPAPI Route = "dpapi-out-of-process"
	// RouteExtension — the browser is already running; the extension reads
	// cookies in-process, triggered by the broker with no user interaction.
	RouteExtension Route = "extension"
	// RouteHeadlessWake — the browser is closed; start a HEADLESS instance on
	// the real user-data-dir so it can read its own cookies, then stop it.
	RouteHeadlessWake Route = "headless-wake"
	// RouteRefused — no silent route exists in this state. The caller reports
	// Reason and attempts nothing.
	RouteRefused Route = "refused"
)

// Named refusal reasons. Stable strings that reach logs and the console, so
// they carry no paths and no secrets.
const (
	ReasonNone               = ""
	ReasonBrowserNotFound    = "browser_not_found"
	ReasonProfileLocked      = "profile_locked_by_another_process"
	ReasonWakeNotPermitted   = "browser_closed_and_wake_not_permitted"
	ReasonUnsupportedBrowser = "browser_not_supported"
)

// Input is everything the decision depends on. It is data, never live OS state,
// so the whole tree is testable without a browser.
type Input struct {
	// Browser is one of the types.Browser* values.
	Browser string
	// Version is the detected version ("141.0.7390.55"), or "" / "unknown".
	Version string
	// Running reports whether the browser process is running.
	Running bool
	// ProfileLocked reports a leftover SingletonLock/lockfile while Running is
	// false — the profile is unusable until it clears, and a second instance
	// would either fail or take over a session the user owns.
	ProfileLocked bool
	// WakePermitted is the policy switch for the headless wake (per-tenant
	// policy / AdminSetting). False makes a closed 127+ browser a refusal, never
	// a launch.
	WakePermitted bool
	// BinaryPath is the resolved browser executable; empty means "not found".
	BinaryPath string
	// DataPath is the Chromium "User Data" root (the ABE-bound path) or the
	// Firefox profiles root. The wake MUST use this exact path or the cookies
	// are unreadable — see the package comment.
	DataPath string
	// ProfilePath is the profile dir being cloned (usually <DataPath>/Default).
	ProfilePath string
	// ProfileName is that dir's base name ("Default", "Profile 1"), which is
	// what --profile-directory takes.
	ProfileName string
}

// Plan is the decision, with everything the caller needs to act on it.
type Plan struct {
	Route  Route  `json:"route"`
	Reason string `json:"reason,omitempty"`
	// NeedsLaunch is true ONLY for RouteHeadlessWake. A caller must never launch
	// for any other route.
	NeedsLaunch bool `json:"needs_launch"`
	// Args is the exact, ordered argument vector when NeedsLaunch is true. The
	// binary is launched directly with this vector — never through a shell,
	// never with a URL — so nothing can open a window or a tab.
	Args []string `json:"args,omitempty"`
	// Headless is always true when NeedsLaunch is true, so a caller cannot
	// forget the flag: Validate() rejects a launch plan without it.
	Headless bool `json:"headless"`
	// Browser is the browser type the plan applies to. The mailbox request
	// carries it so the reader knows which jar it is being asked for.
	Browser string `json:"browser,omitempty"`
	// Binary / DataPath / ProfileName echo the inputs the plan depends on.
	Binary      string `json:"binary,omitempty"`
	DataPath    string `json:"data_path,omitempty"`
	ProfileName string `json:"profile_name,omitempty"`
	// RestoreExitState: after a wake the profile's exit_type/exited_cleanly must
	// go back exactly as found, or the user's NEXT normal launch can offer
	// "Restore pages?" — a visible artefact of a capture they never saw.
	RestoreExitState bool `json:"restore_exit_state"`
	// FallbackRoute is set only where a cheap silent read is worth trying first:
	// an UNKNOWN version might still be <=126, in which case DPAPI works and no
	// process is ever created. "" means none.
	FallbackRoute Route `json:"fallback_route,omitempty"`
	// Notes are human-readable, non-secret explanations for the audit trail.
	Notes []string `json:"notes,omitempty"`
}

// MajorVersion extracts the leading major from a version string, or 0 when it
// cannot be determined. 0 is deliberately NOT treated as "newest": Decide
// decides what an unknown version means.
func MajorVersion(version string) int {
	v := strings.TrimSpace(version)
	if v == "" || strings.EqualFold(v, "unknown") {
		return 0
	}
	head := v
	if i := strings.IndexAny(head, ".-_+ "); i > 0 {
		head = head[:i]
	}
	n, err := strconv.Atoi(head)
	if err != nil || n <= 0 {
		return 0
	}
	return n
}

// appBoundFrom is the first Chrome/Edge major that seals cookies with App-Bound
// Encryption, which is what makes every out-of-process read fail (F10).
const appBoundFrom = 127

// Decide picks the silent route for one browser/profile state.
func Decide(in Input) Plan {
	base := Plan{
		Browser:     in.Browser,
		Binary:      in.BinaryPath,
		DataPath:    in.DataPath,
		ProfileName: in.ProfileName,
	}
	if !types.IsBrowserType(in.Browser) {
		base.Route, base.Reason = RouteRefused, ReasonUnsupportedBrowser
		return base
	}

	// Firefox needs no process at all, running or not: its stores are portable.
	if in.Browser == types.BrowserFirefox {
		base.Route = RouteFileCopy
		base.Notes = append(base.Notes, "firefox stores are portable; no process is started")
		return base
	}

	if in.BinaryPath == "" {
		base.Route, base.Reason = RouteRefused, ReasonBrowserNotFound
		return base
	}

	major := MajorVersion(in.Version)
	modern := major == 0 || major >= appBoundFrom // unknown: assume possibly new

	// A running browser reads its own cookies best — in-process, no ABE
	// problem, no launch, no window. This is the only route that is both correct
	// and silent in that state.
	if in.Running {
		base.Route = RouteExtension
		base.Notes = append(base.Notes, "browser already running; extension reads in-process")
		return base
	}

	if in.ProfileLocked {
		// Starting anything here would either fail or take over a session the
		// user owns. Refuse by name; never "try anyway".
		base.Route, base.Reason = RouteRefused, ReasonProfileLocked
		return base
	}

	// Closed, clean profile.
	if !modern {
		base.Route = RouteDPAPI
		base.Notes = append(base.Notes,
			fmt.Sprintf("chromium %d: key is DPAPI-wrapped in Local State; no process is started", major))
		return base
	}

	// Closed and modern (or unknown): the browser must read its own cookies.
	if !in.WakePermitted {
		base.Route, base.Reason = RouteRefused, ReasonWakeNotPermitted
		return base
	}
	base.Route = RouteHeadlessWake
	base.NeedsLaunch = true
	base.Headless = true
	base.RestoreExitState = true
	base.Args = WakeArgs(in)
	if major == 0 {
		// Cheap silent attempt first: if it really is <=126, the DPAPI read
		// works and no browser process is ever created.
		base.FallbackRoute = RouteDPAPI
		base.Notes = append(base.Notes, "version unknown; try the out-of-process read before waking")
	} else {
		base.Notes = append(base.Notes,
			fmt.Sprintf("chromium %d uses app-bound encryption; only the browser itself can read the jar", major))
	}
	base.Notes = append(base.Notes, "wake is headless and exits as soon as the capture is acknowledged")
	return base
}

// WakeArgs is the headless wake's argument vector, as a pure function so it can
// be asserted flag-for-flag. Every entry earns its place:
//
//	--headless=new           no window, no taskbar entry, no focus steal. THE flag.
//	--user-data-dir=<real>   the ABE key is bound to this exact path; a copy is
//	                         dead (F11), so the real path is mandatory.
//	--profile-directory=<n>  the profile being cloned, not whichever is first.
//	--no-first-run / --no-default-browser-check
//	                         no first-run UI and no default-browser prompt.
//	--disable-sync           no sync churn caused by a session nobody can see.
//	--disable-component-update / --disable-background-networking
//	                         no background downloads triggered by our launch.
//	--disable-gpu            no GPU process for a browser with no display.
//
// Deliberately NOT present: any URL (nothing may open a tab),
// --remote-debugging-port (blocked on the default profile since Chrome 136, and
// unnecessary — the extension is the reader), and --no-startup-window.
//
// --no-startup-window is omitted on purpose and it is worth being explicit,
// because it looks like it belongs: it suppresses the initial window, which is
// also when the extension's service worker is dispatched `runtime.onStartup`.
// Since --headless=new already guarantees there is no window, the flag would buy
// nothing visible and risk the one thing the wake exists to do — get the
// extension running so it can read the cookies. Silence is enforced by Validate
// and by the first-argument assertion in the test, not by this flag.
func WakeArgs(in Input) []string {
	args := []string{
		"--headless=new",
		"--user-data-dir=" + in.DataPath,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-sync",
		"--disable-component-update",
		"--disable-background-networking",
		"--disable-gpu",
	}
	if in.ProfileName != "" {
		args = append(args, "--profile-directory="+in.ProfileName)
	}
	return args
}

// ValidateWake is Validate plus the wake's own precondition: a plan handed to
// the wake must BE a launch plan. Validate alone is not enough here, because it
// treats NeedsLaunch=false as "nothing will be launched" — true for a plan that
// is about to be read locally, and exactly wrong for one about to be woken.
// Without this the runner would write a request and then wait for a browser it
// never started, which is a hang, not a refusal.
func (p Plan) ValidateWake() error {
	if !p.NeedsLaunch {
		return fmt.Errorf("wake_plan_is_not_a_launch")
	}
	return p.Validate()
}

// Validate rejects a plan that could put something on screen. The launcher calls
// it immediately before starting a process, so an edit that drops
// --headless (or slips a URL into argv) cannot silently ship a visible browser.
func (p Plan) Validate() error {
	if !p.NeedsLaunch {
		return nil
	}
	if !p.Headless {
		return fmt.Errorf("wake_plan_not_headless")
	}
	if p.Binary == "" {
		return fmt.Errorf("wake_plan_missing_binary")
	}
	headless := false
	for _, a := range p.Args {
		if a == "--headless" || a == "--headless=new" {
			headless = true
		}
		// Nothing in argv may look like a URL: if --headless were ever lost, a
		// URL would open a tab in a window the user is looking at.
		for _, scheme := range []string{"http://", "https://", "file://"} {
			if strings.HasPrefix(a, scheme) {
				return fmt.Errorf("wake_plan_argv_contains_url")
			}
		}
	}
	if !headless {
		return fmt.Errorf("wake_plan_argv_not_headless")
	}
	return nil
}
