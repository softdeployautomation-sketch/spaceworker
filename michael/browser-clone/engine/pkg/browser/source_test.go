package browser

// Tests for the SOURCE profile locator.
//
// These run on any OS, which is the point: the rule that decides WHICH profile a
// work PC sends is the one thing this half cannot get wrong, and the machine it
// runs on in production (Windows, often as SYSTEM) is not the machine it is
// developed on. So the choice is a pure function over a root list, and the
// environment part is a thin wrapper around it.

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// makeProfileDir writes the marker files a real profile has, so the directory is
// a candidate. An empty directory with the right name must NOT be one.
func makeProfileDir(t *testing.T, dir string, seen time.Time) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{
		"Preferences": `{"profile":{"exit_type":"Normal"}}`,
		"History":     "sqlite",
	} {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(path, seen, seen); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func TestPickSourceProfilePrefersTheMostRecentlyUsedProfile(t *testing.T) {
	// Two "users", the SECOND one newer. The current-user root is deliberately the
	// OLD one, because that is the production case this ordering exists for: the
	// process is running as an account whose own profile is empty or stale, while
	// the profile that matters belongs to someone else.
	oldRoot := filepath.Join(t.TempDir(), "old", "User Data")
	newRoot := filepath.Join(t.TempDir(), "new", "User Data")
	makeProfileDir(t, filepath.Join(oldRoot, "Default"), time.Now().Add(-72*time.Hour))
	makeProfileDir(t, filepath.Join(newRoot, "Default"), time.Now().Add(-1*time.Hour))

	got, err := pickSourceProfile([]string{oldRoot, newRoot}, "")
	if err != nil {
		t.Fatalf("expected a profile, got %v", err)
	}
	want := filepath.Join(newRoot, "Default")
	if got.Dir != want {
		t.Fatalf("picked %q, want the more recently used %q", got.Dir, want)
	}
	if got.Name != "Default" {
		t.Fatalf("name = %q, want Default", got.Name)
	}
	if got.Root != newRoot {
		t.Fatalf("root = %q, want %q", got.Root, newRoot)
	}
}

func TestPickSourceProfileRefusesAnEmptyProfileDirectory(t *testing.T) {
	// The right NAME with nothing in it. Carrying this would produce a replica
	// that looks correct and contains no history at all — worse than a named
	// refusal, because nothing would report it.
	root := filepath.Join(t.TempDir(), "User Data")
	if err := os.MkdirAll(filepath.Join(root, "Default"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := pickSourceProfile([]string{root}, ""); !errors.Is(err, ErrSourceProfileMissing) {
		t.Fatalf("expected ErrSourceProfileMissing, got %v", err)
	}
}

func TestPickSourceProfileHonoursAnExplicitProfileName(t *testing.T) {
	root := filepath.Join(t.TempDir(), "User Data")
	// Default is the NEWER one: an explicit request must still win over recency.
	makeProfileDir(t, filepath.Join(root, "Default"), time.Now())
	makeProfileDir(t, filepath.Join(root, "Profile 1"), time.Now().Add(-48*time.Hour))

	got, err := pickSourceProfile([]string{root}, "Profile 1")
	if err != nil {
		t.Fatalf("expected Profile 1, got %v", err)
	}
	if got.Name != "Profile 1" || got.Dir != filepath.Join(root, "Profile 1") {
		t.Fatalf("picked %+v, want Profile 1", got)
	}
}

func TestPickSourceProfileRefusesARequestedProfileThatIsNotThere(t *testing.T) {
	// The replica is keyed by this name. Falling back to Default would file one
	// profile's bookmarks under another profile's key — silent, and wrong in a way
	// nothing downstream can detect.
	root := filepath.Join(t.TempDir(), "User Data")
	makeProfileDir(t, filepath.Join(root, "Default"), time.Now())

	if _, err := pickSourceProfile([]string{root}, "Profile 9"); !errors.Is(err, ErrSourceProfileMissing) {
		t.Fatalf("expected ErrSourceProfileMissing, got %v", err)
	}
}

func TestPickSourceProfileFallsBackWhenDefaultIsAbsent(t *testing.T) {
	// A fork (or a renamed profile) whose only profile is Profile 1: Default is
	// not there to try, so the root is scanned.
	root := filepath.Join(t.TempDir(), "User Data")
	makeProfileDir(t, filepath.Join(root, "Profile 1"), time.Now())

	got, err := pickSourceProfile([]string{root}, "")
	if err != nil {
		t.Fatalf("expected Profile 1, got %v", err)
	}
	if got.Name != "Profile 1" {
		t.Fatalf("name = %q, want Profile 1", got.Name)
	}
}

func TestPickSourceProfileIgnoresRootsThatDoNotExist(t *testing.T) {
	root := filepath.Join(t.TempDir(), "User Data")
	makeProfileDir(t, filepath.Join(root, "Default"), time.Now())

	got, err := pickSourceProfile([]string{filepath.Join(t.TempDir(), "absent"), root}, "")
	if err != nil {
		t.Fatalf("expected the existing root to be used, got %v", err)
	}
	if got.Root != root {
		t.Fatalf("root = %q, want %q", got.Root, root)
	}
}

func TestResolveSourceProfileAcceptsAProfileDirectoryOverride(t *testing.T) {
	profile := makeProfileDir(t, filepath.Join(t.TempDir(), "User Data", "Profile 2"), time.Now())

	got, err := ResolveSourceProfile("chrome", "", profile)
	if err != nil {
		t.Fatalf("expected the named directory, got %v", err)
	}
	if got.Dir != profile || got.Name != "Profile 2" {
		t.Fatalf("got %+v, want the Profile 2 directory itself", got)
	}
}

func TestResolveSourceProfileAcceptsAUserDataRootOverride(t *testing.T) {
	root := filepath.Join(t.TempDir(), "User Data")
	makeProfileDir(t, filepath.Join(root, "Default"), time.Now())

	got, err := ResolveSourceProfile("chrome", "", root)
	if err != nil {
		t.Fatalf("expected the root's own profile, got %v", err)
	}
	if got.Dir != filepath.Join(root, "Default") {
		t.Fatalf("dir = %q, want the Default directory inside the root", got.Dir)
	}
}

func TestResolveSourceProfileRefusesAnOverrideThatIsNotThere(t *testing.T) {
	// An operator who names a directory is obeyed — and a directory that is not
	// there is a refusal, never a quiet fallback to whatever else is on the disk.
	missing := filepath.Join(t.TempDir(), "nope")
	if _, err := ResolveSourceProfile("chrome", "", missing); !errors.Is(err, ErrSourceProfileMissing) {
		t.Fatalf("expected ErrSourceProfileMissing, got %v", err)
	}
}

func TestResolveSourceProfileRefusesFirefoxAndNonsense(t *testing.T) {
	// Firefox's layout is not Chromium's; a Chromium-shaped walk of it would
	// produce an empty manifest that looks exactly like "nothing changed".
	for _, browserType := range []string{"firefox", "", "netscape"} {
		if _, err := ResolveSourceProfile(browserType, "", ""); !errors.Is(err, ErrSourceProfileMissing) {
			t.Fatalf("%q: expected ErrSourceProfileMissing, got %v", browserType, err)
		}
	}
}
