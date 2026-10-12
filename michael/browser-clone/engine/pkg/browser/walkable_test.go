package browser

import (
	"testing"

	"spaceworker.browser-clone/pkg/types"
)

// The walkable set is written as string literals because the contract check parses
// them (scripts/check-clone-contract.mjs). These tests are what stop those literals
// from drifting away from the canonical browser types: without them, renaming
// `types.BrowserBrave` would leave the walker accepting a string nothing else emits.

func TestStateBrowserConstantsMatchCanonicalTypes(t *testing.T) {
	pairs := []struct {
		state string
		types string
	}{
		{StateBrowserChrome, types.BrowserChrome},
		{StateBrowserEdge, types.BrowserEdge},
		{StateBrowserBrave, types.BrowserBrave},
	}
	for _, p := range pairs {
		if p.state != p.types {
			t.Errorf("state browser %q != canonical type %q", p.state, p.types)
		}
	}
}

func TestIsStateBrowserAcceptsEveryWalkableBrowser(t *testing.T) {
	for _, browserType := range SupportedStateBrowsers() {
		if !IsStateBrowser(browserType) {
			t.Errorf("IsStateBrowser(%q) = false; it is in the supported set", browserType)
		}
	}
}

// Firefox is the whole reason this check exists: it IS a browser type the engine
// knows (detection, revocation and the legacy file pipeline all handle it), and it
// is NOT one whose profile this walker can read.
func TestIsStateBrowserRefusesFirefoxAndUnknownNames(t *testing.T) {
	refused := []string{
		types.BrowserFirefox,
		"chromium",
		"vivaldi",
		"Chrome", // case matters: the device lowercases before calling, and a
		// caller that forgets must be told "unsupported", not handed a
		// misleading "profile missing".
		"",
		"chrome.exe",
	}
	for _, browserType := range refused {
		if IsStateBrowser(browserType) {
			t.Errorf("IsStateBrowser(%q) = true; must be refused", browserType)
		}
	}
	if IsStateBrowser(types.BrowserFirefox) {
		t.Fatal("firefox must never be walkable: a Chromium-shaped walk of it yields an empty manifest")
	}
}

// The set the contract check compares against the platform's list. Pinned so that
// adding a browser here without telling the platform fails in this package first.
func TestSupportedStateBrowsersIsExactlyThreeChromiumBrowsers(t *testing.T) {
	got := SupportedStateBrowsers()
	want := []string{"chrome", "edge", "brave"}
	if len(got) != len(want) {
		t.Fatalf("walkable browsers = %v; want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("walkable browsers = %v; want %v", got, want)
		}
	}
}
