package wake

import (
	"os"
	"path/filepath"
	"testing"
)

// ---------------------------------------------------------------------------
// Fakes: the Launcher seam lets these tests prove the whole silent sequence for
// a Windows Chrome on Linux, with no browser installed anywhere.
// ---------------------------------------------------------------------------

type fakeProcess struct {
	pid     int
	stopped bool
	exited  bool
	stopErr error
}

func (p *fakeProcess) PID() int     { return p.pid }
func (p *fakeProcess) Exited() bool { return p.exited }
func (p *fakeProcess) Stop() error {
	p.stopped = true
	p.exited = true
	return p.stopErr
}

type fakeLauncher struct {
	started int
	binary  string
	args    []string
	proc    *fakeProcess
	err     error
	onStart func() // e.g. simulate Chrome marking the session unclean
}

func (l *fakeLauncher) Start(binary string, args []string) (Process, error) {
	l.started++
	l.binary, l.args = binary, args
	if l.onStart != nil {
		l.onStart()
	}
	if l.err != nil {
		return nil, l.err
	}
	l.proc = &fakeProcess{pid: 4242}
	return l.proc, nil
}

// harness wires a runner to a temp profile and a fake clock.
type harness struct {
	dir       string
	reqPath   string
	resPath   string
	prefsPath string
	clock     *fakeClock
	launcher  *fakeLauncher
	runner    *Runner
}

// cleanPrefs is what the user's profile looks like when it is closed normally.
const cleanPrefs = `{"profile":{"exit_type":"Normal","exited_cleanly":true,"name":"Person 1"},
  "intl":{"app_locale":"en-GB"}}`

func newHarness(t *testing.T, prefs string) *harness {
	t.Helper()
	dir := t.TempDir()
	h := &harness{
		dir:       dir,
		reqPath:   filepath.Join(dir, "capture-request.json"),
		resPath:   filepath.Join(dir, "capture-result.json"),
		prefsPath: filepath.Join(dir, "Preferences"),
		clock:     newFakeClock(),
		launcher:  &fakeLauncher{},
	}
	if prefs != "" {
		if err := os.WriteFile(h.prefsPath, []byte(prefs), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	h.runner = NewRunner(h.launcher, h.clock, h.reqPath, h.resPath, h.prefsPath)
	return h
}

// playExtension simulates the real reader: the force-installed extension's
// service worker claims the pending request through the native host and the host
// writes the counts back. It runs on the Nth poll of the fake clock.
func (h *harness) playExtension(atSleep int, accepted, domains int) {
	h.clock.onSleep = func() {
		if h.clock.sleeps != atSleep {
			return
		}
		req, ok, _ := ClaimRequest(h.reqPath, h.clock.Now())
		if !ok {
			return
		}
		_ = WriteResult(h.resPath, CaptureResult{
			Nonce:    req.Nonce,
			Status:   "success",
			Accepted: accepted,
			Domains:  domains,
		}, h.clock.Now())
	}
}
