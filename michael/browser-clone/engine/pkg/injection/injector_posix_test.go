package injection

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

// parseMountOwner accepts "uid:gid" and rejects malformed specs.
func TestParseMountOwner(t *testing.T) {
	uid, gid, err := parseMountOwner("1000:1000")
	if err != nil || uid != 1000 || gid != 1000 {
		t.Fatalf("valid spec rejected: %v (%d:%d)", err, uid, gid)
	}
	for _, bad := range []string{"", "1000", "a:b", "1000:", ":1000", "-1:0", "1000:x", "1:2:3"} {
		if _, _, err := parseMountOwner(bad); err == nil {
			t.Fatalf("spec %q accepted", bad)
		}
	}
}

// chownTree applies uid:gid to every file and directory below root.
func TestChownTree(t *testing.T) {
	if os.Getuid() != 0 {
		t.Skip("ownership test requires root; skipping on non-root CI hosts")
	}
	root := t.TempDir()
	sub := filepath.Join(root, "sub")
	if err := os.MkdirAll(sub, 0o700); err != nil {
		t.Fatal(err)
	}
	f := filepath.Join(sub, "f.txt")
	if err := os.WriteFile(f, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := chownTree(root, 0, 0); err != nil {
		t.Fatalf("chownTree: %v", err)
	}
	for _, p := range []string{root, sub, f} {
		st, err := os.Stat(p)
		if err != nil {
			t.Fatal(err)
		}
		if st.Sys().(*syscall.Stat_t).Uid != 0 {
			t.Fatalf("%s not owned by uid 0", p)
		}
	}
}
