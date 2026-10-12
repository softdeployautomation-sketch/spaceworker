// TASK_135 §6.2 — the device-facing config reader for `sync-state`.
//
// The state sync is a ONE-SHOT CLI command, deliberately, and not something the
// native-messaging host does for us. The host's lifetime is tied to the browser's
// native-messaging port, and in the silent-capture path the broker STARTS a
// headless browser, waits for the cookie capture and then STOPS it — so a state
// transfer (tens of megabytes) started at the end of that window could be killed
// halfway. The state half reads FILES; it does not need the browser at all, and it
// must not inherit the browser's lifetime. So it runs as its own process.
//
// Mirrors cmd/native-host's captureConfigPaths/captureConfigName ON PURPOSE. Both
// read the same file the one-click setup already writes, at the same paths, so the
// broker, the host and this command agree without any of them inventing one. The
// two are kept in step by the paths being named in one place per binary and
// asserted by a test; nothing here may invent a third location.
//
// THE TOKEN IS NEVER PASSED ON A COMMAND LINE. It is read from this file (0600,
// written by setup). A token in argv would land in process listings, and the
// platform's own run-command path records what it ran.

package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

const (
	// captureConfigName is the host's own per-device config (0600).
	captureConfigName = "live-capture.json"
	// captureConfigEnv overrides the config-file location (harness/tests).
	captureConfigEnv = "SPACEWORKER_CLONE_CONFIG"
)

// deviceCaptureConfig is the subset of the config file this command needs.
type deviceCaptureConfig struct {
	BaseURL    string `json:"base_url"`
	DeviceID   string `json:"device_id"`
	Token      string `json:"live_capture_token"`
	CloneJobID string `json:"clone_job_id"`
}

// captureConfigPaths is the search order, most specific first: the env override,
// then the directory holding this executable (which is where setup writes it
// inside the quarantined install folder), then the install locations.
func captureConfigPaths() []string {
	if p := strings.TrimSpace(os.Getenv(captureConfigEnv)); p != "" {
		return []string{p}
	}
	var paths []string
	if exe, err := os.Executable(); err == nil {
		paths = append(paths, filepath.Join(filepath.Dir(exe), captureConfigName))
	}
	if runtime.GOOS == "windows" {
		paths = append(paths,
			filepath.Join(`C:\ProgramData\TacticalRMM\CloneTool`, captureConfigName),
			filepath.Join(`C:\Program Files\TacticalRMM`, captureConfigName),
		)
	} else if dir, err := os.UserConfigDir(); err == nil {
		paths = append(paths, filepath.Join(dir, "spaceworker", captureConfigName))
	}
	return paths
}

// loadDeviceCaptureConfig returns the first config that parses, plus the path it
// came from. A file that exists but cannot be parsed is an ERROR and not skipped
// past: silently falling through to a stale copy in another directory would mean
// syncing to the wrong platform with a token that may have been rotated.
func loadDeviceCaptureConfig() (deviceCaptureConfig, string, error) {
	var firstErr error
	for _, p := range captureConfigPaths() {
		blob, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		var cfg deviceCaptureConfig
		if err := json.Unmarshal(blob, &cfg); err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		if strings.TrimSpace(cfg.BaseURL) == "" || strings.TrimSpace(cfg.Token) == "" {
			continue
		}
		return cfg, p, nil
	}
	if firstErr != nil {
		return deviceCaptureConfig{}, "", firstErr
	}
	return deviceCaptureConfig{}, "", os.ErrNotExist
}
