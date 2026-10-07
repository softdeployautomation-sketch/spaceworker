package wake

import (
	"testing"
	"time"
)

func at(day int) time.Time {
	return time.Date(2026, 9, day, 12, 0, 0, 0, time.UTC)
}

// copyFiles deep-copies fingerprints. A plain `next := prev` shares the backing
// array, so mutating next.Files[i] would also change prev — which made the first
// version of these tests pass for the wrong reason.
func copyFiles(files []FileFingerprint) []FileFingerprint {
	out := make([]FileFingerprint, len(files))
	copy(out, files)
	return out
}

// manifestFor builds a manifest with n state files, all 1 KB, captured at
// capturedAt. The names are realistic: a clone really does carry these.
func manifestFor(day int, n int) Manifest {
	names := []string{
		"History", "Bookmarks", "Preferences", "Secure Preferences",
		"Web Data", "Favicons", "Top Sites", "Shortcuts",
		"Network/Network Persistent State", "Sessions/Session_1", "Sessions/Tabs_1",
	}
	m := Manifest{
		DeviceID:   "dev-1",
		Browser:    "chrome",
		Version:    "141.0.7390.55",
		Profile:    "Default",
		CapturedAt: at(day),
	}
	for i := 0; i < n; i++ {
		m.Files = append(m.Files, FileFingerprint{
			Path:    names[i%len(names)] + "/" + string(rune('a'+i%26)) + ".state",
			Size:    1024,
			ModTime: at(day).Unix(),
		})
	}
	return m
}

// TestPlanSyncFirstTimeIsFull is the "first time clone" case: nothing to diff
// against, so everything goes.
func TestPlanSyncFirstTimeIsFull(t *testing.T) {
	d := PlanSync(nil, manifestFor(20, 40), at(21), 0)
	if d.Mode != SyncModeFull {
		t.Fatalf("mode = %q, want full", d.Mode)
	}
	if d.Reason != ReasonFirstClone {
		t.Fatalf("reason = %q, want %q", d.Reason, ReasonFirstClone)
	}
	if d.Delta != nil {
		t.Fatal("a full sync must not carry a delta")
	}
	if !d.CookiesAlwaysFull {
		t.Fatal("cookies are re-read in full on every clone, first or reconnect")
	}
	if err := d.Validate(); err != nil {
		t.Fatalf("validate: %v", err)
	}
}

func TestPlanSyncFirstTimeWithAnEmptyManifestIsFull(t *testing.T) {
	// A manifest that exists but lists nothing is not a usable baseline: treating
	// it as one would produce an empty delta and transfer nothing at all.
	empty := manifestFor(20, 0)
	d := PlanSync(&empty, manifestFor(21, 40), at(21), 0)
	if d.Mode != SyncModeFull || d.Reason != ReasonFirstClone {
		t.Fatalf("got %q/%q, want full/%s", d.Mode, d.Reason, ReasonFirstClone)
	}
}

// TestPlanSyncReconnectIsDelta is the "sync on reconnect" case.
func TestPlanSyncReconnectIsDelta(t *testing.T) {
	prev := manifestFor(20, 11)
	next := prev
	next.CapturedAt = at(21)
	next.Files = copyFiles(prev.Files)
	// One file changed, one file is new.
	next.Files[0].Size = 2048
	next.Files = append(next.Files, FileFingerprint{
		Path: "Sessions/Session_2", Size: 512, ModTime: at(21).Unix(),
	})

	d := PlanSync(&prev, next, at(21), 0)
	if d.Mode != SyncModeDelta {
		t.Fatalf("mode = %q, want delta", d.Mode)
	}
	if d.Reason != ReasonSyncOnReconnect {
		t.Fatalf("reason = %q, want %q", d.Reason, ReasonSyncOnReconnect)
	}
	if d.Delta == nil {
		t.Fatal("a delta decision must carry the delta")
	}
	if len(d.Delta.Changed) != 1 || d.Delta.Changed[0].Size != 2048 {
		t.Fatalf("changed = %+v, want exactly the resized file", d.Delta.Changed)
	}
	if len(d.Delta.Added) != 1 || d.Delta.Added[0].Path != "Sessions/Session_2" {
		t.Fatalf("added = %+v, want the new session file", d.Delta.Added)
	}
	if d.Delta.Unchanged != 10 {
		t.Fatalf("unchanged = %d, want the other 10 files", d.Delta.Unchanged)
	}
	if !d.CookiesAlwaysFull {
		t.Fatal("cookies must still be re-read in full on a reconnect")
	}
	if err := d.Validate(); err != nil {
		t.Fatalf("validate: %v", err)
	}
}

// TestReconnectTransfersALotLessThanAFirstClone is the point of the whole flow:
// the second connect must not re-upload a profile.
func TestReconnectTransfersALotLessThanAFirstClone(t *testing.T) {
	prev := manifestFor(20, 40)
	for i := range prev.Files {
		prev.Files[i].Size = 1 << 20 // 1 MB each = 40 MB profile
	}
	next := prev
	next.CapturedAt = at(21)
	next.Files = copyFiles(prev.Files)
	next.Files[3].Size = (1 << 20) + 7 // one file grew
	next.Files[7].ModTime = at(21).Unix()

	d := PlanSync(&prev, next, at(21), 0)
	if d.Mode != SyncModeDelta {
		t.Fatalf("mode = %q, want delta", d.Mode)
	}
	full := int64(40 << 20)
	if got := d.Delta.Bytes(); got > full/4 {
		t.Fatalf("a reconnect transferred %d bytes of a %d byte profile; a delta should be a small fraction", got, full)
	}
	if d.Delta.Unchanged != 38 {
		t.Fatalf("unchanged = %d, want 38", d.Delta.Unchanged)
	}
}

// TestPlanSyncRefusesDeltaOnTheWrongBaseline: a delta against a baseline that
// describes a different browser, profile or major version would silently omit
// files, so each is a full transfer with its own reason.
func TestPlanSyncRefusesDeltaOnTheWrongBaseline(t *testing.T) {
	prev := manifestFor(20, 11)

	otherBrowser := prev
	otherBrowser.Browser = "edge"
	if d := PlanSync(&prev, otherBrowser, at(21), 0); d.Mode != SyncModeFull || d.Reason != ReasonBrowserChanged {
		t.Fatalf("browser change: got %q/%q", d.Mode, d.Reason)
	}

	otherProfile := prev
	otherProfile.Profile = "Profile 2"
	if d := PlanSync(&prev, otherProfile, at(21), 0); d.Mode != SyncModeFull || d.Reason != ReasonProfileChanged {
		t.Fatalf("profile change: got %q/%q", d.Mode, d.Reason)
	}

	upgraded := prev
	upgraded.Version = "142.0.7444.1"
	if d := PlanSync(&prev, upgraded, at(21), 0); d.Mode != SyncModeFull || d.Reason != ReasonVersionChanged {
		t.Fatalf("version change: got %q/%q", d.Mode, d.Reason)
	}
}

// TestPlanSyncStaleManifestIsFull: a delta computed against a week-old list can
// miss an in-place rewrite of the history database, which is the one failure a
// replica must not have.
func TestPlanSyncStaleManifestIsFull(t *testing.T) {
	prev := manifestFor(20, 11)
	// Eight days later: past the window, so the baseline is no longer trusted.
	if d := PlanSync(&prev, prev, at(28), 0); d.Mode != SyncModeFull || d.Reason != ReasonManifestStale {
		t.Fatalf("8 days later: got %q/%q, want full/%s", d.Mode, d.Reason, ReasonManifestStale)
	}
	// Exactly at the window edge is still within it, so the boundary is real and
	// the comparison is not accidentally off by one.
	if d := PlanSync(&prev, prev, prev.CapturedAt.Add(DefaultManifestMaxAge), 0); d.Mode != SyncModeDelta {
		t.Fatalf("exactly at the boundary: got %q, want delta", d.Mode)
	}
}

func TestPlanSyncZeroCapturedAtIsFull(t *testing.T) {
	prev := manifestFor(20, 11)
	prev.CapturedAt = time.Time{}
	if d := PlanSync(&prev, manifestFor(21, 11), at(21), 0); d.Mode != SyncModeFull || d.Reason != ReasonFirstClone {
		t.Fatalf("got %q/%q, want full/%s", d.Mode, d.Reason, ReasonFirstClone)
	}
}

// TestPlanSyncExplicitMaxAgeWins: a caller may shorten or lengthen the window.
func TestPlanSyncExplicitMaxAgeWins(t *testing.T) {
	prev := manifestFor(20, 11)
	tight := PlanSync(&prev, prev, at(21), time.Hour)
	if tight.Mode != SyncModeFull || tight.Reason != ReasonManifestStale {
		t.Fatalf("a one hour window must refuse a day-old manifest: got %q/%q", tight.Mode, tight.Reason)
	}
	loose := PlanSync(&prev, prev, at(21), 30*24*time.Hour)
	if loose.Mode != SyncModeDelta {
		t.Fatalf("a 30 day window must allow a day-old manifest: got %q", loose.Mode)
	}
	// A zero or negative window means the package default, not "everything is
	// stale" and not "nothing ever is".
	if d := PlanSync(&prev, prev, at(21), 0); d.Mode != SyncModeDelta {
		t.Fatalf("maxAge 0 must mean the default: got %q/%q", d.Mode, d.Reason)
	}
}

func TestValidateRejectsDecisionsThatWouldUnderSend(t *testing.T) {
	// A delta with no delta transfers nothing and looks like success.
	if err := (SyncDecision{Mode: SyncModeDelta, Reason: ReasonSyncOnReconnect}).Validate(); err == nil {
		t.Fatal("a delta without a delta must be rejected")
	}
	if err := (SyncDecision{Mode: SyncModeFull, Reason: ReasonFirstClone,
		Delta: &Delta{}}).Validate(); err == nil {
		t.Fatal("a full sync carrying a delta must be rejected")
	}
	if err := (SyncDecision{Mode: "incremental", Reason: ReasonSyncOnReconnect}).Validate(); err == nil {
		t.Fatal("an unknown mode must be rejected")
	}
	if err := (SyncDecision{Mode: SyncModeFull}).Validate(); err == nil {
		t.Fatal("a decision with no reason must be rejected")
	}
}
