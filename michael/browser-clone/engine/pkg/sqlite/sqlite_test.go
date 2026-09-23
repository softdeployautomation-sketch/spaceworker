package sqlite

import (
	"os"
	"testing"
)

// TestReadChromeLikeDB reads a real SQLite file (created by python3's
// sqlite3 module) with Chrome-like tables: b-tree interiors, indexes, blobs,
// integers and text columns.
func TestReadChromeLikeDB(t *testing.T) {
	fixture := os.Getenv("SW_SQLITE_FIXTURE")
	if fixture == "" {
		fixture = "/tmp/test_login.db"
	}
	data, err := os.ReadFile(fixture)
	if err != nil {
		t.Skipf("fixture %s not available: %v", fixture, err)
	}
	db, err := Open(data)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	schema, err := db.Schema()
	if err != nil {
		t.Fatalf("Schema: %v", err)
	}
	if len(schema) < 2 {
		t.Fatalf("expected >=2 schema entries, got %d", len(schema))
	}

	cols, err := db.TableColumns("logins")
	if err != nil {
		t.Fatalf("TableColumns: %v", err)
	}
	wantCols := []string{"origin_url", "action_url", "username_element", "username_value",
		"password_element", "password_value", "signon_realm", "date_created", "times_used"}
	for i, c := range wantCols {
		if cols[i] != c {
			t.Fatalf("col %d = %q, want %q", i, cols[i], c)
		}
	}

	rows, err := db.Query("logins", QueryOpts{})
	if err != nil {
		t.Fatalf("Query logins: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("expected 2 login rows, got %d", len(rows))
	}
	r0 := rows[0]
	if r0["origin_url"] != "https://example.com/login" {
		t.Errorf("origin_url = %v", r0["origin_url"])
	}
	if r0["username_value"] != "alice@example.com" {
		t.Errorf("username_value = %v", r0["username_value"])
	}
	pw, ok := r0["password_value"].([]byte)
	if !ok || len(pw) != 51 || string(pw[:3]) != "v10" {
		t.Errorf("password_value blob = %v (ok=%v)", pw, ok)
	}
	if r0["times_used"] != int64(3) {
		t.Errorf("times_used = %v", r0["times_used"])
	}

	// WHERE filter (exact match on text).
	one, err := db.Query("logins", QueryOpts{WhereColumn: "origin_url", WhereValue: "https://bank.com/"})
	if err != nil {
		t.Fatalf("Query filtered: %v", err)
	}
	if len(one) != 1 {
		t.Fatalf("expected 1 filtered row, got %d", len(one))
	}

	// Limit.
	lim, err := db.Query("logins", QueryOpts{Limit: 1})
	if err != nil {
		t.Fatalf("Query limited: %v", err)
	}
	if len(lim) != 1 {
		t.Fatalf("expected 1 limited row, got %d", len(lim))
	}

	// Cookies table (blob column).
	ck, err := db.Query("cookies", QueryOpts{})
	if err != nil {
		t.Fatalf("Query cookies: %v", err)
	}
	if len(ck) != 1 {
		t.Fatalf("expected 1 cookie, got %d", len(ck))
	}
	if ck[0]["name"] != "sid" {
		t.Errorf("cookie name = %v", ck[0]["name"])
	}
	if ev, ok := ck[0]["encrypted_value"].([]byte); !ok || len(ev) != 64 {
		t.Errorf("cookie encrypted_value = %v (ok=%v)", ev, ok)
	}

	// Missing table.
	if _, err := db.Query("nope", QueryOpts{}); err == nil {
		t.Fatal("expected error for missing table")
	}
}

// TestBadHeader ensures Open rejects non-SQLite files.
func TestBadHeader(t *testing.T) {
	if _, err := Open([]byte("this is not a sqlite database at all............")); err == nil {
		t.Fatal("expected error for non-sqlite data")
	}
}

// TestCellMatches verifies filter semantics on various cell types.
func TestCellMatches(t *testing.T) {
	cases := []struct {
		cell Cell
		want string
		ok   bool
	}{
		{"abc", "abc", true},
		{"abc", "xyz", false},
		{int64(42), "42", true},
		{float64(1.5), "1.5", true},
		{nil, "", true},
		{nil, "x", false},
	}
	for _, c := range cases {
		if got := cellMatches(c.cell, c.want); got != c.ok {
			t.Errorf("cellMatches(%v,%q)=%v want %v", c.cell, c.want, got, c.ok)
		}
	}
}
