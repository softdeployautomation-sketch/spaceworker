package sqlite

import (
	"encoding/binary"
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

// TestInteriorPageTraversal is a SELF-CONTAINED regression test: it builds a
// minimal 3-page database in memory whose table sits under an INTERIOR page.
//
// The bug it locks down: the right-most child pointer of an interior page is a
// 4-byte page number at header offset 8. walk() used to read uint16(h[7:9]) —
// starting at the fragmented-free-bytes byte and only 2 bytes wide — which
// yields garbage (fragFree<<8, e.g. 512, or 0) and makes every real database
// whose table spans more than one page unreadable. Chrome's Cookies and Login
// Data are always multi-page, so this broke extraction entirely.
//
// The existing TestReadChromeLikeDB skipped whenever its external fixture was
// absent, which is how that ship sailed; this test needs no fixture.
func TestInteriorPageTraversal(t *testing.T) {
	db, err := Open(buildInteriorRootDB())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	rows, err := db.Query("t", QueryOpts{})
	if err != nil {
		t.Fatalf("Query through an interior page: %v\n"+
			"regression: the interior right-most child is uint32 at header offset 8", err)
	}
	if len(rows) != 1 {
		t.Fatalf("expected 1 row, got %d", len(rows))
	}
	if rows[0]["a"] != int64(1) {
		t.Errorf("a = %#v, want int64(1)", rows[0]["a"])
	}
}

const testPageSize = 512

func put16(b []byte, off int, v uint16) { binary.BigEndian.PutUint16(b[off:off+2], v) }

// buildInteriorRootDB lays out:
//
//	page 1  sqlite_master (leaf), one row: table "t", rootpage = 2
//	page 2  INTERIOR table page, ZERO cells, right-most child = page 3
//	page 3  leaf table page, one row: a = 1
//
// Zero cells on page 2 means the ONLY pointer consulted is the right-most one,
// so the row can only be found if that pointer is decoded correctly.
func buildInteriorRootDB() []byte {
	const ps = testPageSize
	buf := make([]byte, ps*3)

	// Database header (page 1, bytes 0..99).
	copy(buf[0:16], "SQLite format 3\x00")
	put16(buf, 16, ps)                         // page size
	buf[18] = 1                                // write version: rollback journal
	buf[19] = 1                                // read version
	buf[21], buf[22], buf[23] = 64, 32, 32     // payload fractions
	binary.BigEndian.PutUint32(buf[24:28], 1)  // file change counter
	binary.BigEndian.PutUint32(buf[28:32], 3)  // page count
	binary.BigEndian.PutUint32(buf[40:44], 1)  // schema cookie
	binary.BigEndian.PutUint32(buf[44:48], 4)  // schema format
	binary.BigEndian.PutUint32(buf[56:60], 1)  // text encoding UTF-8
	binary.BigEndian.PutUint32(buf[96:100], 1) // version-valid-for

	// Page 1: leaf table page whose b-tree header starts at offset 100.
	p1 := buf[0:ps]
	p1[100] = pageTypeLeafTable
	put16(p1, 103, 1)   // cell count
	put16(p1, 105, 400) // cell content area
	master := sqliteMasterCell()
	copy(p1[400:], master)
	put16(p1, 108, 400) // cell pointer array starts at 100+8

	// Page 2: INTERIOR table page with no cells.
	p2 := buf[ps : 2*ps]
	p2[0] = pageTypeInteriorTable
	put16(p2, 3, 0)                         // zero cells
	put16(p2, 5, ps)                        // cell content area (empty page)
	p2[7] = 0                               // fragmented free bytes
	binary.BigEndian.PutUint32(p2[8:12], 3) // right-most child -> page 3

	// Page 3: leaf table page holding a = 1.
	p3 := buf[2*ps : 3*ps]
	p3[0] = pageTypeLeafTable
	put16(p3, 3, 1) // cell count
	put16(p3, 5, 400)
	// cell: payload-len varint(3), rowid varint(1), payload
	//       payload = header-len(2), serial type 1 (1-byte int), value 1
	copy(p3[400:], []byte{0x03, 0x01, 0x02, 0x01, 0x01})
	put16(p3, 8, 400) // leaf cell pointer array starts at offset 8

	return buf
}

// sqliteMasterCell encodes one sqlite_master row for CREATE TABLE t(a).
// "CREATE TABLE t(a)" is 17 bytes, so its serial type is 13+2*17 = 47, and the
// record payload is 1 (header len) + 5 (serial types) + 5 + 1 + 1 + 1 + 17 = 31.
func sqliteMasterCell() []byte {
	payload := []byte{6, 23, 15, 15, 1, 47} // header len + serial types
	payload = append(payload, "table"...)   // type
	payload = append(payload, 't')          // name
	payload = append(payload, 't')          // tbl_name
	payload = append(payload, 2)            // rootpage
	payload = append(payload, "CREATE TABLE t(a)"...)
	if len(payload) != 31 {
		panic("sqlite_master payload fixture changed length")
	}
	return append([]byte{byte(len(payload)), 1}, payload...)
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
