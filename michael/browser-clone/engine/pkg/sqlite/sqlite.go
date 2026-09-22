// Package sqlite implements a minimal, read-only SQLite 3 (rollback-journal)
// database reader in pure Go using only the standard library.
//
// It is intentionally small: its purpose is to scan Chrome/Edge/Brave profile
// databases (Login Data, Cookies, Web Data) on the extracted profile, not to
// be a general-purpose SQL engine. Supported:
//
//   - full-table scans of rowid tables ("SELECT * FROM <table>"),
//   - exact-match single-column filters ("WHERE <col> = <value>"),
//   - UTF-8 text, integer/float/blob/null column types.
//
// Not supported (reported explicitly): WAL-mode databases, encrypted
// databases, WITHOUT ROWID tables, FTS tables, auto-vacuum/pointer-map
// layouts. The parser is defensive: structural corruption returns a
// descriptive error instead of panicking.
package sqlite

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
)

const (
	headerString = "SQLite format 3\x00"

	pageTypeInteriorIndex = 2
	pageTypeInteriorTable = 5
	pageTypeLeafIndex     = 10
	pageTypeLeafTable     = 13
)

// Errors returned by the reader.
var (
	ErrNotSQLite      = errors.New("sqlite: not a SQLite database file")
	ErrWALMode        = errors.New("sqlite: WAL-mode database (write version 2) not supported; close the browser and retry")
	ErrAutoVacuum     = errors.New("sqlite: auto-vacuum/pointer-map databases not supported")
	ErrNotRowidTable  = errors.New("sqlite: table is not a rowid table")
	ErrUnsupported    = errors.New("sqlite: unsupported feature")
	ErrCorrupt        = errors.New("sqlite: corrupt database")
	ErrTableNotFound  = errors.New("sqlite: table not found")
	ErrColumnNotFound = errors.New("sqlite: column not found")
)

// Cell is one column value: nil (NULL), int64, float64, string, or []byte.
type Cell any

// Row is one record of a query result.
type Row []Cell

// DB is an opened read-only database.
type DB struct {
	data      []byte
	pageSize  int
	pageCount int
}

// Open validates the 100-byte header and returns a DB backed by data.
func Open(data []byte) (*DB, error) {
	if len(data) < 100 {
		return nil, ErrNotSQLite
	}
	if !bytes.Equal(data[:16], []byte(headerString)) {
		return nil, ErrNotSQLite
	}
	ps := int(binary.BigEndian.Uint16(data[16:18]))
	if ps == 1 {
		ps = 65536
	}
	if ps < 512 || ps > 65536 {
		return nil, fmt.Errorf("%w: invalid page size %d", ErrCorrupt, ps)
	}
	if data[18] != 1 { // write version 1 = rollback journal
		return nil, ErrWALMode
	}
	pageCount := int(binary.BigEndian.Uint32(data[28:32]))
	if pageCount <= 0 {
		pageCount = len(data) / ps
	}
	if pageCount <= 0 {
		pageCount = 1
	}
	// Schema format: 1 (legacy) through 4 (modern). Pointer-map pages are
	// only present when auto-vacuum is enabled; Chrome's sql::Database never
	// enables auto-vacuum, and sqlite3's default (used by python3, etc.) is
	// auto-vacuum=off too. We accept formats 1..4 and let the b-tree walker
	// report a clear error if a pointer-map/interior page is unexpected.
	sf := binary.BigEndian.Uint32(data[44:48])
	if sf == 0 || sf > 4 {
		return nil, fmt.Errorf("%w: schema format number %d", ErrUnsupported, sf)
	}
	return &DB{data: data, pageSize: ps, pageCount: pageCount}, nil
}

// page returns the raw bytes of page number pg (1-based).
func (db *DB) page(pg int) ([]byte, error) {
	if pg < 1 || pg > db.pageCount {
		return nil, fmt.Errorf("%w: page %d out of range (1..%d)", ErrCorrupt, pg, db.pageCount)
	}
	off := (pg - 1) * db.pageSize
	end := off + db.pageSize
	if end > len(db.data) {
		end = len(db.data)
	}
	return db.data[off:end], nil
}

// PageSize returns the database page size in bytes.
func (db *DB) PageSize() int { return db.pageSize }

// varint decodes a SQLite variable-length integer (1..9 bytes).
func varint(b []byte) (val uint64, n int) {
	var v uint64
	for i := 0; i < 8 && i < len(b); i++ {
		c := b[i]
		v = v<<7 | uint64(c&0x7F)
		if c&0x80 == 0 {
			return v, i + 1
		}
	}
	if len(b) >= 9 {
		v = v<<8 | uint64(b[8])
		n = 9
	}
	return v, n
}
