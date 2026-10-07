package browser

// Which browsers the STATE walker understands.
//
// WHY THIS IS ITS OWN FILE (and a const block, not just a function): the platform
// decides which browser to ASK for (`lib/clone-browsers.ts` → `STATE_SYNC_BROWSERS`)
// and this engine decides which ones it can actually WALK. Those two lists sit on
// opposite sides of a trust boundary and are deliberately not shared, so the only
// thing standing between them and silent drift is a check that compares them —
// `scripts/check-clone-contract.mjs`, which parses the const block below. Keep the
// block shaped as plain `Name = "value"` lines for that reason.
//
// The consequence of drift is not a crash, it is a LIE: a browser accepted by the
// platform but not walkable here produces an empty manifest, and an empty manifest
// is indistinguishable from "your profile has not changed".
//
// Firefox is ABSENT on purpose, and it is the reason this check exists. Its profile
// is not Chromium's: no `User Data`/`Default`, no `Preferences`, no sqlite `History`
// at the path this walker asks for. A Chromium-shaped walk of a Firefox profile
// yields nothing — so it is refused by name (`state_browser_unsupported:firefox`)
// rather than reported as an empty profile.
const (
	// StateBrowserChrome mirrors types.BrowserChrome.
	StateBrowserChrome = "chrome"
	// StateBrowserEdge mirrors types.BrowserEdge.
	StateBrowserEdge = "edge"
	// StateBrowserBrave mirrors types.BrowserBrave.
	StateBrowserBrave = "brave"
)

// SupportedStateBrowsers lists the walkable browsers, for callers that need the set
// rather than a test of one name.
func SupportedStateBrowsers() []string {
	return []string{StateBrowserChrome, StateBrowserEdge, StateBrowserBrave}
}

// IsStateBrowser reports whether a browser type has a profile layout the state
// walker can read.
//
// The caller must use this BEFORE trying to locate a profile. Without it, an
// unsupported name (firefox, chromium, a typo) falls through to the profile
// locator, finds nothing, and is reported as `state_profile_missing` — a statement
// that is true about the search and false about the machine, which is exactly the
// class of failure this whole feature exists to eliminate.
func IsStateBrowser(browserType string) bool {
	switch browserType {
	case StateBrowserChrome, StateBrowserEdge, StateBrowserBrave:
		return true
	default:
		return false
	}
}
