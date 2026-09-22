package browser

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"

	"spaceworker.browser-clone/pkg/types"
)

// DefaultProfilePath returns the platform-standard profile directory for a
// browser type WITHOUT requiring it to exist. Used to bootstrap a mount on a
// virgin hosted PC whose browser is installed but has never been launched
// (the mount itself creates the first profile).
func DefaultProfilePath(browserType string) string {
	root := osUserDataRoot()
	dir := chromeDataDir(browserType)
	if dir == "" {
		return ""
	}
	return filepath.Join(root, dir, "Default")
}

// BinaryPath resolves the browser executable across platforms: PATH first
// (POSIX dev hosts, Chrome for Testing installs), then the standard Windows
// install locations (installers register App Paths but do not extend PATH).
// Returns "" when no binary can be found.
func BinaryPath(browserType string) string {
	for _, exe := range exeNames(browserType) {
		if p, err := exec.LookPath(exe); err == nil {
			return p
		}
	}
	if runtime.GOOS == "windows" {
		for _, p := range windowsInstallPaths(browserType) {
			if st, err := os.Stat(p); err == nil && !st.IsDir() {
				return p
			}
		}
	}
	return ""
}

// windowsInstallPaths lists the standard per-browser install locations on
// Windows, checked in order (64-bit Program Files first, then x86).
func windowsInstallPaths(browserType string) []string {
	pf := os.Getenv("ProgramFiles")
	pfx86 := os.Getenv("ProgramFiles(x86)")
	switch browserType {
	case types.BrowserChrome:
		return joinBasePaths([]string{pf, pfx86}, "Google", "Chrome", "Application", "chrome.exe")
	case types.BrowserEdge:
		return joinBasePaths([]string{pfx86, pf}, "Microsoft", "Edge", "Application", "msedge.exe")
	case types.BrowserBrave:
		return joinBasePaths([]string{pf, pfx86}, "BraveSoftware", "Brave-Browser", "Application", "brave.exe")
	case types.BrowserFirefox:
		return joinBasePaths([]string{pf, pfx86}, "Mozilla Firefox", "firefox.exe")
	default:
		return nil
	}
}

// joinBasePaths joins elems under each non-empty base.
func joinBasePaths(bases []string, elems ...string) []string {
	var out []string
	for _, b := range bases {
		if b != "" {
			out = append(out, filepath.Join(append([]string{b}, elems...)...))
		}
	}
	return out
}
