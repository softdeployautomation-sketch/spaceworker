// Package injection contains the [IP CHECK 4] watchdog (directive §13):
// while a clone browser runs on the hosted PC its egress proxy must stay
// reachable, because every request that bypasses the relay leaks the hosted
// PC's public IP and can invalidate the sessions the clone carries. The
// watchdog dials the proxy on an interval; an outage longer than the limit
// terminates the clone browser processes (kill, not warn - a running clone
// without its IP twin is a session-burning liability) and records the event
// in the audit log.
package injection

import (
	"fmt"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"spaceworker.browser-clone/pkg/audit"
	"spaceworker.browser-clone/pkg/procattr"
	"spaceworker.browser-clone/pkg/types"
)

const (
	// DefaultWatchdogInterval is how often the proxy is probed.
	DefaultWatchdogInterval = 10 * time.Second
	// DefaultOutageLimit is the outage length that triggers termination.
	DefaultOutageLimit = 30 * time.Second
)

// Watchdog guards one launched clone browser. Run blocks until the proxy
// has been unreachable for OutageLimit, kills the browser, and returns; it
// is normally started as a goroutine by Launch and lives for the browser's
// lifetime.
type Watchdog struct {
	// Proxy is the egress endpoint to monitor, "host:port".
	Proxy string
	// UserDataDir identifies the clone's browser processes: any process
	// whose command line carries --user-data-dir=<UserDataDir> is killed
	// when the outage limit is exceeded.
	UserDataDir string
	// Interval defaults to DefaultWatchdogInterval.
	Interval time.Duration
	// OutageLimit defaults to DefaultOutageLimit (directive: >30s).
	OutageLimit time.Duration
	// Audit receives relay_down / terminated events; optional.
	Audit *audit.Logger
	// CloneId for audit attribution.
	CloneId string
}

// Run watches the proxy until a sustained outage forces termination. It
// returns immediately (nil) when no proxy is configured.
func (w *Watchdog) Run() error {
	if w.Proxy == "" {
		return nil
	}
	if w.Interval <= 0 {
		w.Interval = DefaultWatchdogInterval
	}
	if w.OutageLimit <= 0 {
		w.OutageLimit = DefaultOutageLimit
	}
	downSince := time.Time{}
	for {
		if err := proxyReachable(w.Proxy); err == nil {
			downSince = time.Time{} // recovered; timer resets
		} else {
			if downSince.IsZero() {
				downSince = time.Now()
				w.audit("relay_down", audit.LevelWarn, err, map[string]any{
					"proxy": w.Proxy, "limit_seconds": int(w.OutageLimit.Seconds()),
				})
			}
			if time.Since(downSince) >= w.OutageLimit {
				killed := killCloneProcesses(w.UserDataDir)
				w.audit("terminated", audit.LevelError, fmt.Errorf(
					"egress relay %s unreachable for over %s", w.Proxy, w.OutageLimit),
					map[string]any{"proxy": w.Proxy, "killed": killed})
				return fmt.Errorf("watchdog: relay %s down > %s; clone browser terminated (%s)",
					w.Proxy, w.OutageLimit, killed)
			}
		}
		time.Sleep(w.Interval)
	}
}

func (w *Watchdog) audit(status, level string, cause error, details map[string]any) {
	if w.Audit == nil {
		return
	}
	ev := types.AuditEvent{
		Event:   audit.EvEgressMismatch,
		CloneId: w.CloneId,
		Status:  status,
		Level:   level,
		Details: details,
	}
	if cause != nil {
		ev.Error = cause.Error()
	}
	w.Audit.Log(ev)
}

// killCloneProcesses terminates every process whose command line selects the
// clone's user-data-dir. Best effort: returns a short human summary either
// way (for the audit log). Windows uses CIM to find PIDs then taskkill /T /F
// (tree kill covers Chrome's child processes); POSIX uses pkill -f.
func killCloneProcesses(userDataDir string) string {
	if userDataDir == "" {
		return "no-match"
	}
	if runtime.GOOS == "windows" {
		return killWindows(userDataDir)
	}
	kill := exec.Command("pkill", "-f", "--", "--user-data-dir="+userDataDir)
	procattr.Quiet(kill) // no console flash on the hosted desktop
	out, err := kill.CombinedOutput()
	if err != nil {
		return "pkill: " + strings.TrimSpace(string(out))
	}
	return "pkill ok"
}

func killWindows(userDataDir string) string {
	const ps = `
$p = Get-CimInstance Win32_Process -Filter "Name LIKE '%%.exe'" |
  Where-Object { $_.CommandLine -like '*--user-data-dir=%s*' } |
  Select-Object -ExpandProperty ProcessId
foreach ($id in $p) { taskkill /PID $id /T /F 2>$null }
if ($p) { "killed:$($p -join ',')" } else { "none" }`
	kill := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command",
		fmt.Sprintf(ps, userDataDir))
	procattr.Quiet(kill) // no console flash on the hosted desktop
	out, err := kill.CombinedOutput()
	if err != nil {
		return "taskkill: " + strings.TrimSpace(string(out))
	}
	return strings.TrimSpace(string(out))
}
