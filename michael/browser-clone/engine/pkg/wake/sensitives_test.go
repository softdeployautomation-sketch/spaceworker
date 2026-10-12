package wake

import (
	"strings"
	"testing"
)

// TestSecretBearingFilesAreNeverCarried: the file half must not become a second,
// useless and more sensitive channel for what the CDP route already handles.
func TestSecretBearingFilesAreNeverCarried(t *testing.T) {
	cases := map[string]string{
		"Cookies":                 "cookies_abe_bound_use_cdp",
		"Network/Cookies":         "cookies_abe_bound_use_cdp",
		"Network\\Cookies":        "cookies_abe_bound_use_cdp",
		"Default/Network/Cookies": "cookies_abe_bound_use_cdp",
		"Login Data":              "passwords_abe_bound_unusable_in_clone",
		"Network/Login Data":      "passwords_abe_bound_unusable_in_clone",
		"Login Data For Account":  "passwords_abe_bound_unusable_in_clone",
		"Local State":             "abe_key_store_never_transferred",
		"Cookies-Journal":         "cookies_abe_bound_use_cdp",
	}
	for path, wantReason := range cases {
		reason, excluded := CloneStateFileExcluded(path)
		if !excluded {
			t.Errorf("%q must never be carried as clone state", path)
			continue
		}
		if reason != wantReason {
			t.Errorf("%q: reason = %q, want %q", path, reason, wantReason)
		}
	}
}

// Case matters on Windows and manifests are written by whatever scanned the disk.
func TestExclusionsAreCaseInsensitive(t *testing.T) {
	for _, p := range []string{"cookies", "COOKIES", "local state", "LOCAL STATE", "login data"} {
		if _, excluded := CloneStateFileExcluded(p); !excluded {
			t.Errorf("%q must be excluded regardless of case", p)
		}
	}
}

// TestOrdinaryStateFilesAreCarried is the other half of the rule: the files that
// make a clone feel like the user's browser must come through untouched.
func TestOrdinaryStateFilesAreCarried(t *testing.T) {
	carried := []string{
		"History", "Bookmarks", "Preferences", "Secure Preferences",
		"Web Data", "Favicons", "Top Sites", "Shortcuts", "Visited Links",
		"Sessions/Session_1", "Sessions/Tabs_1", "Current Session", "Current Tabs",
		"Last Session", "Last Tabs",
		"Network/Network Persistent State", "Network/TransportSecurity",
		"Local Storage/leveldb/000003.log",
		"IndexedDB/https_example.com_0.indexeddb.leveldb/000010.ldb",
		"Extensions/abc/manifest.json",
		"Sync Data/LevelDB/000005.ldb",
	}
	for _, p := range carried {
		if reason, excluded := CloneStateFileExcluded(p); excluded {
			t.Errorf("%q must be carried, but was excluded as %q", p, reason)
		}
	}
}

// TestPathTraversalIsRefused: a manifest crosses a trust boundary, so the
// receiving side must not accept a path that escapes the profile root.
func TestPathTraversalIsRefused(t *testing.T) {
	bad := map[string]string{
		"../secrets.txt":                   "state_path_escapes_profile",
		"..\\secrets.txt":                  "state_path_escapes_profile",
		"a/../../b":                        "state_path_escapes_profile",
		"..":                               "state_path_escapes_profile",
		"/etc/passwd":                      "state_path_absolute",
		"\\Windows\\System32\\config\\SAM": "state_path_absolute",
		"C:/Windows/System32/config/SAM":   "state_path_drive_relative",
		"C:History":                        "state_path_drive_relative",
		"//server/share/file":              "state_path_unc",
		"":                                 "state_path_empty",
		"   ":                              "state_path_empty",
		"History\x00.txt":                  "state_path_nul",
	}
	for path, wantReason := range bad {
		err := CloneStatePathSafe(path)
		if err == nil {
			t.Errorf("%q must be refused", path)
			continue
		}
		if err.Error() != wantReason {
			t.Errorf("%q: reason = %q, want %q", path, err.Error(), wantReason)
		}
	}
}

func TestOrdinaryProfilePathsAreSafe(t *testing.T) {
	good := []string{
		"History",
		"Sessions/Tabs_1",
		"Local Storage/leveldb/000003.log",
		"IndexedDB/https_example.com_0.indexeddb.leveldb/000010.ldb",
		"a/../b",              // cleans to "b", still inside the root
		"Extensions/abc/x.js", // a directory that merely starts with a letter
	}
	for _, p := range good {
		if err := CloneStatePathSafe(p); err != nil {
			t.Errorf("%q must be accepted, got %v", p, err)
		}
	}
}

// TestFilterReportsEveryExclusion: nothing is dropped silently, so the caller can
// account for every file it was asked to carry.
func TestFilterReportsEveryExclusion(t *testing.T) {
	in := []FileFingerprint{
		fp("History", 1, 1),
		fp("Network/Cookies", 2, 2), // sensitive
		fp("../../evil", 3, 3),      // unsafe
		fp("Bookmarks", 4, 4),
		fp("Local State", 5, 5), // sensitive
		fp("/etc/shadow", 6, 6), // unsafe
	}
	kept, dropped := FilterCloneStateFiles(in)

	if len(kept) != 2 {
		t.Fatalf("kept = %+v, want History and Bookmarks", kept)
	}
	if kept[0].Path != "History" || kept[1].Path != "Bookmarks" {
		t.Fatalf("kept in unexpected order: %+v", kept)
	}
	if len(dropped) != 4 {
		t.Fatalf("dropped = %+v, want 4 entries", dropped)
	}
	for _, d := range dropped {
		if strings.TrimSpace(d.Reason) == "" {
			t.Errorf("%q was dropped with no reason", d.Path)
		}
	}
	// Every input is accounted for: kept + dropped == in.
	if len(kept)+len(dropped) != len(in) {
		t.Fatalf("files went missing: kept %d + dropped %d != %d", len(kept), len(dropped), len(in))
	}
}
