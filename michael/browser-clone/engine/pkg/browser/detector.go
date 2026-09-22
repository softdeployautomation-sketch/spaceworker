// Package browser detects supported browser installations on the current host
// and exposes helpers to locate profile data (directive §1:
// pkg/browser/detector.go).
package browser

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"

	"spaceworker.browser-clone/pkg/procattr"
	"spaceworker.browser-clone/pkg/types"
)

// Browser holds detection configuration for one browser type.
type Browser struct {
	Type        string
	Display     string
	Executables []string
}

// supported lists the browsers we detect.
var supported = []Browser{
	{Type: types.BrowserChrome, Display: "Google Chrome", Executables: []string{"chrome", "chrome.exe", "google-chrome", "google-chrome-stable"}},
	{Type: types.BrowserEdge, Display: "Microsoft Edge", Executables: []string{"msedge", "msedge.exe", "microsoft-edge"}},
	{Type: types.BrowserBrave, Display: "Brave", Executables: []string{"brave", "brave.exe"}},
	{Type: types.BrowserFirefox, Display: "Mozilla Firefox", Executables: []string{"firefox", "firefox.exe"}},
}

// osUserDataRoot returns the per-user config root for the current OS.
func osUserDataRoot() string {
	switch runtime.GOOS {
	case "windows":
		if p := os.Getenv("LOCALAPPDATA"); p != "" {
			return p
		}
		return filepath.Join(os.Getenv("USERPROFILE"), "AppData", "Local")
	case "darwin":
		return filepath.Join(os.Getenv("HOME"), "Library", "Application Support")
	default:
		if p := os.Getenv("XDG_CONFIG_HOME"); p != "" {
			return p
		}
		return filepath.Join(os.Getenv("HOME"), ".config")
	}
}

// chromeDataDir maps a browser type to its data directory name, relative to
// the per-OS user-data root (Chromium forks use different vendor-directory
// spellings per platform: %LOCALAPPDATA%\Google\Chrome on Windows vs
// ~/.config/google-chrome on Linux).
func chromeDataDir(t string) string {
	switch t {
	case types.BrowserChrome:
		if runtime.GOOS == "windows" {
			return filepath.Join("Google", "Chrome", "User Data")
		}
		return "google-chrome"
	case types.BrowserEdge:
		if runtime.GOOS == "windows" {
			return filepath.Join("Microsoft", "Edge", "User Data")
		}
		return "microsoft-edge"
	case types.BrowserBrave:
		if runtime.GOOS == "windows" {
			return filepath.Join("BraveSoftware", "Brave-Browser", "User Data")
		}
		return filepath.Join("BraveSoftware", "Brave-Browser")
	default:
		return ""
	}
}

// firefoxProfilesRoot returns the Firefox profiles directory.
func firefoxProfilesRoot() string {
	switch runtime.GOOS {
	case "windows":
		return filepath.Join(os.Getenv("APPDATA"), "Mozilla", "Firefox", "Profiles")
	case "darwin":
		return filepath.Join(os.Getenv("HOME"), "Library", "Application Support", "Firefox", "Profiles")
	default:
		return filepath.Join(os.Getenv("HOME"), ".mozilla", "firefox")
	}
}

// DetectProfile finds the profile directory for a browser type.
func DetectProfile(browserType string) (*types.BrowserProfile, error) {
	switch browserType {
	case types.BrowserChrome, types.BrowserEdge, types.BrowserBrave:
		return detectChromium(browserType)
	case types.BrowserFirefox:
		return detectFirefox()
	default:
		return nil, fmt.Errorf("%s: unsupported browser type %q", types.ErrNotSupported, browserType)
	}
}

func detectChromium(browserType string) (*types.BrowserProfile, error) {
	root := filepath.Join(osUserDataRoot(), chromeDataDir(browserType))
	if _, err := os.Stat(root); err != nil {
		return nil, fmt.Errorf("%s: %s not found at %s", types.ErrBrowserNotFound, browserType, root)
	}
	profile := filepath.Join(root, "Default")
	if _, err := os.Stat(profile); err != nil {
		return nil, fmt.Errorf("%s: no Default profile under %s", types.ErrBrowserNotFound, root)
	}
	return &types.BrowserProfile{Type: browserType, Version: detectVersion(browserType), DataPath: root, ProfilePath: profile, IsRunning: isRunning(browserType)}, nil
}

func detectFirefox() (*types.BrowserProfile, error) {
	root := firefoxProfilesRoot()
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, fmt.Errorf("%s: firefox profiles not found at %s", types.ErrBrowserNotFound, root)
	}
	for _, e := range entries {
		if e.IsDir() && strings.Contains(e.Name(), ".default") {
			return &types.BrowserProfile{Type: types.BrowserFirefox, Version: detectVersion(types.BrowserFirefox), DataPath: root, ProfilePath: filepath.Join(root, e.Name()), IsRunning: isRunning(types.BrowserFirefox)}, nil
		}
	}
	return nil, fmt.Errorf("%s: no firefox .default profile under %s", types.ErrBrowserNotFound, root)
}

// versionRe extracts a dotted version number.
var versionRe = regexp.MustCompile(`(\d+(?:\.\d+){1,3})`)

func detectVersion(browserType string) string {
	for _, exe := range exeNames(browserType) {
		if path, err := exec.LookPath(exe); err == nil {
			c := exec.Command(path, "--version")
			procattr.Quiet(c)
			if out, err := c.Output(); err == nil {
				if m := versionRe.FindString(string(out)); m != "" {
					return m
				}
			}
		}
	}
	// "Last Version" is a Chromium artefact; skip for Firefox (whose
	// chromeDataDir is "" and would produce a bogus path).
	if browserType != types.BrowserFirefox {
		if b, err := os.ReadFile(filepath.Join(osUserDataRoot(), chromeDataDir(browserType), "Last Version")); err == nil {
			if m := versionRe.FindString(string(b)); m != "" {
				return m
			}
		}
	}
	return "unknown"
}

func exeNames(browserType string) []string {
	for _, b := range supported {
		if b.Type == browserType {
			return b.Executables
		}
	}
	return nil
}

func isRunning(browserType string) bool {
	if runtime.GOOS == "windows" {
		name := exeName(browserType) + ".exe"
		c := exec.Command("tasklist", "/FI", "IMAGENAME eq "+name)
		procattr.Quiet(c)
		out, err := c.Output()
		if err != nil {
			return false
		}
		return strings.Contains(strings.ToLower(string(out)), strings.ToLower(name))
	}
	for _, name := range exeNames(browserType) {
		c := exec.Command("pgrep", "-x", name)
		procattr.Quiet(c)
		if out, err := c.Output(); err == nil && strings.TrimSpace(string(out)) != "" {
			return true
		}
	}
	return false
}

// IsRunning reports whether a browser process appears to be running.
func IsRunning(browserType string) bool { return isRunning(browserType) }

func exeName(browserType string) string {
	if n := exeNames(browserType); len(n) > 0 {
		return n[0]
	}
	return browserType
}

// ListDetected returns installed browsers.
func ListDetected() []types.BrowserProfile {
	var found []types.BrowserProfile
	for _, b := range supported {
		if p, err := DetectProfile(b.Type); err == nil {
			found = append(found, *p)
		}
	}
	return found
}

// IsProfileLocked reports whether a profile is considered locked.
func IsProfileLocked(profile *types.BrowserProfile) bool { return profile.IsRunning }

// PathExists reports whether path exists.
func PathExists(path string) bool { _, err := os.Stat(path); return err == nil }
