// TASK_135 §6.2 — `sync-state`: carry ONE browser profile's state to the clone.
//
// This is the device end of the state pipe. It is what the platform runs, either
// automatically as part of a clone or from the console's "Sync profile state"
// button, and it is a separate PROCESS for the reason given in captureconfig.go:
// the state half reads files and must not inherit a browser's lifetime.
//
// SILENCE. Nothing here spawns a child, opens a window, shows a dialog or waits
// for input. The browser may be CLOSED, OPEN, or writing at the time: a file that
// cannot be read is a named skip in the output, not a retry loop and not an error
// box. That is the whole requirement — the work PC is unattended.
//
// OUTPUT IS COUNTS ONLY. No path, no filename, no token, no file content ever
// reaches stdout: the platform records this line, and a profile path is personal
// data. The full per-file detail lives in the result the server keeps.
//
// EXIT CODE: 0 when the transfer completed (even if individual files were skipped,
// which is normal and reported), 1 when it failed by name. The JSON is printed
// EITHER WAY, so a caller that only reads stdout still gets the reason.

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"spaceworker.browser-clone/pkg/browser"
	"spaceworker.browser-clone/pkg/wake"
)

// defaultSyncBudget bounds one run's SENDING, leaving headroom under the
// platform's own 90-second run-command timeout. The two numbers are deliberately
// not equal: if the device stopped at the same moment the platform gave up, every
// long transfer would end exactly the way this budget exists to prevent — killed
// mid-request, with no result line to record and no way to tell a partial
// transfer from a failed one.
const defaultSyncBudget = 60 * time.Second

// stateSyncOut is the machine-readable result. Counts only, by construction.
type stateSyncOut struct {
	OK      bool   `json:"ok"`
	Browser string `json:"browser"`
	Profile string `json:"profile"`
	// Mode/Reason are the SERVER's sync decision, echoed for the record.
	Mode   string `json:"mode,omitempty"`
	Reason string `json:"reason,omitempty"`
	// Sent is files POSTed, Bytes their total size, Removed stale paths deleted.
	Sent    int   `json:"sent"`
	Bytes   int64 `json:"bytes"`
	Removed int   `json:"removed,omitempty"`
	// Skipped counts files refused (sensitive, unsafe, unreadable, too large).
	// The per-file reasons live on the server's record; this is the count.
	Skipped int `json:"skipped,omitempty"`
	// Pending is how many files this run did NOT send before its budget expired.
	// Non-zero means the caller MUST run again: the replica is not complete yet.
	Pending int `json:"pending,omitempty"`
	// Done is true only when everything selected was sent. The platform records
	// this, because "the transfer finished" and "the command returned 0" are not
	// the same claim.
	Done bool `json:"done"`
	// Failed is a named reason when the transfer could not be completed at all.
	Failed string `json:"failed,omitempty"`
}

// cmdSyncState collects a profile and posts it. See the file header.
func cmdSyncState(args []string) error {
	browserType, _, rest := take(args, "--browser")
	profile, _, rest := take(rest, "--profile")
	jobOverride, _, rest := take(rest, "--job")
	dirOverride, _, rest := take(rest, "--profile-dir")
	timeoutRaw, _, rest := take(rest, "--timeout")
	budgetRaw, _, rest := take(rest, "--budget")
	if len(rest) > 0 {
		return usageErr("sync-state --browser <chrome|edge|brave> [--profile NAME] [--profile-dir DIR] [--job ID] [--timeout SECONDS] [--budget SECONDS]")
	}
	browserType = strings.ToLower(strings.TrimSpace(browserType))
	if browserType == "" {
		return usageErr("sync-state requires --browser")
	}
	// Anything the walker cannot read is refused BY NAME rather than silently
	// treated as Chromium: Firefox's profile layout is different, and a
	// Chromium-shaped walk of it would produce an empty manifest that looks exactly
	// like "nothing changed".
	//
	// The check is a set membership test, not `== "firefox"`, because the misleading
	// answer is the general case: ANY name this walker cannot serve (firefox,
	// chromium, a typo, a browser a newer platform learned about) would otherwise
	// fall through to the profile locator, find nothing, and be reported as
	// `state_profile_missing` — true about the search, false about the machine.
	if !browser.IsStateBrowser(browserType) {
		reason := fmt.Sprintf("state_browser_unsupported:%s", browserType)
		out := stateSyncOut{OK: false, Browser: browserType, Failed: reason}
		printStateSyncOut(out)
		return fmt.Errorf("%s: %s profiles are not supported yet (supported: %s)",
			reason, browserType, strings.Join(browser.SupportedStateBrowsers(), ", "))
	}

	cfg, _, err := loadDeviceCaptureConfig()
	if err != nil {
		out := stateSyncOut{OK: false, Browser: browserType, Failed: "state_config_unavailable"}
		printStateSyncOut(out)
		return fmt.Errorf("state_config_unavailable: %w", err)
	}

	// The profile is LOCATED, not assumed. Under SYSTEM the environment-derived
	// path points at the service's own empty profile, so the locator picks the
	// most recently used real profile on the machine instead — and the NAME it
	// returns is the one that goes in the manifest, because the server keys the
	// state cache by it.
	resolved, err := browser.ResolveSourceProfile(browserType, strings.TrimSpace(profile), dirOverride)
	if err != nil {
		out := stateSyncOut{OK: false, Browser: browserType, Failed: wake.ReasonStateProfileMissing}
		printStateSyncOut(out)
		return fmt.Errorf("%s: no usable %s profile found on this machine", wake.ReasonStateProfileMissing, browserType)
	}
	// An explicit --profile wins as the recorded name (it was validated as a real
	// profile by the locator); otherwise the locator's own answer, so a machine
	// whose profile is `Profile 1` is never recorded as `Default`.
	profileName := strings.TrimSpace(profile)
	if profileName == "" {
		profileName = resolved.Name
	}

	jobID := strings.TrimSpace(jobOverride)
	if jobID == "" {
		jobID = cfg.CloneJobID
	}

	timeout := 10 * time.Minute
	if v := strings.TrimSpace(timeoutRaw); v != "" {
		if secs, err := time.ParseDuration(v + "s"); err == nil && secs > 0 {
			timeout = secs
		}
	}
	// The send budget is deliberately SHORTER than the platform's run-command
	// timeout, so this process stops at a file boundary and reports what is left
	// instead of being killed mid-request with no result to record.
	budget := defaultSyncBudget
	if v := strings.TrimSpace(budgetRaw); v != "" {
		if secs, err := time.ParseDuration(v + "s"); err == nil && secs > 0 {
			budget = secs
		}
	}
	if budget > timeout {
		budget = timeout
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	res := wake.SyncState(ctx, wake.StateSyncOptions{
		BaseURL:     cfg.BaseURL,
		Token:       cfg.Token,
		CloneJobID:  jobID,
		DeviceID:    cfg.DeviceID,
		Browser:     browserType,
		ProfileName: profileName,
		ProfileDir:  resolved.Dir,
		Budget:      budget,
	})

	out := stateSyncOut{
		OK:      res.Failed == "",
		Browser: browserType,
		Profile: profileName,
		Mode:    res.Mode,
		Reason:  res.Reason,
		Sent:    res.Sent,
		Bytes:   res.Bytes,
		Removed: res.Removed,
		Skipped: len(res.Skipped),
		Pending: res.Pending,
		Done:    res.Done && res.Failed == "",
		Failed:  res.Failed,
	}
	printStateSyncOut(out)
	if res.Failed != "" {
		return errors.New(res.Failed)
	}
	return nil
}

// printStateSyncOut writes the one machine-readable line the platform parses.
func printStateSyncOut(out stateSyncOut) {
	blob, err := json.Marshal(out)
	if err != nil {
		// Cannot happen for this shape, but a silent empty line would be worse
		// than a loud one.
		fmt.Println(`{"ok":false,"failed":"state_result_unencodable"}`)
		return
	}
	fmt.Println(string(blob))
}
