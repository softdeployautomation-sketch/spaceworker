package wake

import "testing"

func fp(path string, size int64, mtime int64) FileFingerprint {
	return FileFingerprint{Path: path, Size: size, ModTime: mtime}
}

func TestDiffManifestsAddsChangesRemovesAndCounts(t *testing.T) {
	prev := []FileFingerprint{
		fp("History", 100, 1),
		fp("Bookmarks", 200, 1),
		fp("Sessions/Tabs_1", 300, 1),
		fp("Favicons", 400, 1),
	}
	next := []FileFingerprint{
		fp("History", 150, 2),         // changed: grew
		fp("Bookmarks", 200, 1),       // unchanged
		fp("Sessions/Tabs_1", 300, 5), // changed: rewritten, same size
		fp("Sessions/Tabs_2", 50, 1),  // added
		// Favicons is gone.
	}

	d := DiffManifests(prev, next)

	if len(d.Added) != 1 || d.Added[0].Path != "Sessions/Tabs_2" {
		t.Fatalf("added = %+v", d.Added)
	}
	if len(d.Changed) != 2 {
		t.Fatalf("changed = %+v, want History and Sessions/Tabs_1", d.Changed)
	}
	if len(d.Removed) != 1 || d.Removed[0] != "Favicons" {
		t.Fatalf("removed = %+v, want Favicons", d.Removed)
	}
	if d.Unchanged != 1 {
		t.Fatalf("unchanged = %d, want 1 (Bookmarks)", d.Unchanged)
	}
	if d.Empty() {
		t.Fatal("a delta with work is not empty")
	}
	if got, want := d.Bytes(), int64(150+300+50); got != want {
		t.Fatalf("Bytes = %d, want %d (added + changed; a removal costs nothing to send)", got, want)
	}
}

// A removal alone is still work: the replica has to delete the file or it stops
// being a replica. This is the case an "only send what grew" implementation gets
// wrong.
func TestRemovalAloneIsStillWork(t *testing.T) {
	d := DiffManifests([]FileFingerprint{fp("History", 1, 1)},
		[]FileFingerprint{fp("Bookmarks", 1, 1)})
	if d.Empty() {
		t.Fatal("a removal must not count as an empty delta")
	}
	if len(d.Removed) != 1 || len(d.Added) != 1 {
		t.Fatalf("got added=%+v removed=%+v", d.Added, d.Removed)
	}
	if d.Bytes() == 0 {
		t.Fatal("the added file still has to be transferred")
	}
}

func TestNoChangeIsAnEmptyDelta(t *testing.T) {
	files := []FileFingerprint{fp("History", 100, 1), fp("Bookmarks", 200, 1)}
	d := DiffManifests(files, files)
	if !d.Empty() {
		t.Fatalf("nothing changed, so nothing should move: %+v", d)
	}
	if d.Unchanged != 2 {
		t.Fatalf("unchanged = %d, want 2", d.Unchanged)
	}
	// An empty delta must still carry a valid decision, so a reconnect with no
	// file changes can skip the transfer and go straight to the cookies.
	if err := (SyncDecision{Mode: SyncModeDelta, Reason: ReasonSyncOnReconnect,
		Delta: &d, CookiesAlwaysFull: true}).Validate(); err != nil {
		t.Fatalf("an empty delta is still a valid delta: %v", err)
	}
}

// TestDiffManifestsTreatsWindowsPathsAsCaseInsensitive: `Default\History` and
// `default/history` are one file on the source machine. Treating them as two
// would re-transfer every file on every sync — the bug this test exists to stop.
func TestDiffManifestsTreatsWindowsPathsAsCaseInsensitive(t *testing.T) {
	d := DiffManifests(
		[]FileFingerprint{fp(`Network\Cookies`, 10, 1)},
		[]FileFingerprint{fp(`network/cookies`, 10, 1)},
	)
	if !d.Empty() {
		t.Fatalf("the same file spelled differently must not be re-sent: %+v", d)
	}
}

// TestDiffManifestsHashBeatsSizeAndMtime: an in-place rewrite that preserved size
// and mtime is invisible to the fast comparison, so a hash must win when both
// sides have one.
func TestDiffManifestsHashBeatsSizeAndMtime(t *testing.T) {
	prev := []FileFingerprint{{Path: "History", Size: 100, ModTime: 1, SHA256: "aaaa"}}
	next := []FileFingerprint{{Path: "History", Size: 100, ModTime: 1, SHA256: "bbbb"}}
	d := DiffManifests(prev, next)
	if len(d.Changed) != 1 {
		t.Fatalf("a hash change must be seen as a change: %+v", d)
	}
	// And the reverse: a rewritten file with the SAME hash is not a change, even
	// if the mtime moved.
	prev2 := []FileFingerprint{{Path: "History", Size: 100, ModTime: 1, SHA256: "aaaa"}}
	next2 := []FileFingerprint{{Path: "History", Size: 100, ModTime: 99, SHA256: "aaaa"}}
	if d := DiffManifests(prev2, next2); !d.Empty() {
		t.Fatalf("an identical hash must not be re-sent: %+v", d)
	}
	// Without hashes on both sides the fast comparison stands alone.
	if d := DiffManifests(
		[]FileFingerprint{{Path: "History", Size: 100, ModTime: 1}},
		[]FileFingerprint{{Path: "History", Size: 100, ModTime: 1, SHA256: "bbbb"}},
	); !d.Empty() {
		t.Fatalf("size+mtime alone must be enough when only one side has a hash: %+v", d)
	}
}

// TestDiffManifestsIsDeterministicAndDeduped: a device that scanned a file twice,
// or a manifest that arrived out of order, must not make the plan flap.
func TestDiffManifestsIsDeterministicAndDeduped(t *testing.T) {
	dup := []FileFingerprint{fp("History", 100, 1), fp("HISTORY", 100, 1)}
	if d := DiffManifests(dup, dup); !d.Empty() {
		t.Fatalf("a duplicate path must not be seen as two files: %+v", d)
	}
	// Last entry wins for a repeated path, so a half-written manifest cannot
	// produce a change and a non-change for the same file in one run.
	mixed := []FileFingerprint{fp("History", 100, 1), fp("history", 999, 2)}
	d := DiffManifests(nil, mixed)
	if len(d.Added) != 1 || d.Added[0].Size != 999 {
		t.Fatalf("added = %+v, want one entry carrying the last fingerprint", d.Added)
	}
	// Empty paths are dropped rather than becoming a key of "".
	if d := DiffManifests(nil, []FileFingerprint{fp("", 5, 5), fp("   ", 5, 5)}); len(d.Added) != 0 {
		t.Fatalf("paths that are empty must be ignored: %+v", d.Added)
	}
}

func TestDiffAgainstNoPreviousManifestIsAllAdded(t *testing.T) {
	d := DiffManifests(nil, []FileFingerprint{fp("History", 1, 1), fp("Bookmarks", 2, 2)})
	if len(d.Added) != 2 || len(d.Changed) != 0 || len(d.Removed) != 0 {
		t.Fatalf("first clone must send everything: %+v", d)
	}
	if d.Unchanged != 0 {
		t.Fatalf("unchanged = %d, want 0", d.Unchanged)
	}
}
