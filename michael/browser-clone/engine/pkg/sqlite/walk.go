// b-tree walking and sqlite_master schema parsing.
package sqlite

import (
	"encoding/binary"
	"fmt"
)

// schemaEntry is one row of sqlite_master.
type schemaEntry struct {
	Type     string // table | index | view | trigger
	Name     string
	TblName  string
	RootPage int
	SQL      string
}

// schema lists the parsed sqlite_master rows whose root b-tree lives on
// page 1 immediately after the 100-byte database header.
func (db *DB) schema() ([]schemaEntry, error) {
	p1, err := db.page(1)
	if err != nil {
		return nil, err
	}
	if len(p1) < 100 {
		return nil, ErrNotSQLite
	}
	var entries []schemaEntry
	// Page 1: the 100-byte DB header precedes the b-tree page header, so the
	// b-tree header slice begins at offset 100; cell pointers are relative to
	// byte 0 of the page (fullPage).
	err = db.walk(1, p1, 100, func(rowid int64, row Row) error {
		_ = rowid
		if len(row) < 5 {
			return nil
		}
		e := schemaEntry{}
		if v, ok := row[0].(string); ok {
			e.Type = v
		}
		if v, ok := row[1].(string); ok {
			e.Name = v
		}
		if v, ok := row[2].(string); ok {
			e.TblName = v
		}
		if v, ok := row[3].(int64); ok {
			e.RootPage = int(v)
		}
		if v, ok := row[4].(string); ok {
			e.SQL = v
		}
		entries = append(entries, e)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return entries, nil
}

// Schema returns the parsed sqlite_master entries as maps.
func (db *DB) Schema() ([]map[string]any, error) {
	entries, err := db.schema()
	if err != nil {
		return nil, err
	}
	out := make([]map[string]any, 0, len(entries))
	for _, e := range entries {
		out = append(out, map[string]any{
			"type":     e.Type,
			"name":     e.Name,
			"tbl_name": e.TblName,
			"rootpage": int64(e.RootPage),
			"sql":      e.SQL,
		})
	}
	return out, nil
}

// walk visits every row of the table b-tree rooted at page rootPg.
//
// fullPage is the raw page bytes and headerOffset is the offset (within
// fullPage) of the b-tree page header: 0 for ordinary pages, 100 for page 1
// (whose first 100 bytes are the database header). Cell pointer values are
// relative to byte 0 of the page, so cells are read as fullPage[cptr:].
func (db *DB) walk(rootPg int, fullPage []byte, headerOffset int, fn func(rowid int64, row Row) error) error {
	type job struct {
		pg     int
		page   []byte
		hdrOff int
		depth  int
	}
	stack := []job{{rootPg, fullPage, headerOffset, 0}}
	for len(stack) > 0 {
		cur := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if cur.depth > db.pageCount {
			return ErrCorrupt // cycle guard
		}
		page := cur.page
		h := page[cur.hdrOff:]
		if len(h) < 8 {
			return ErrCorrupt
		}
		ptype := h[0]
		cellCount := int(binary.BigEndian.Uint16(h[3:5]))
		ptrOff := 8
		if ptype == pageTypeInteriorTable || ptype == pageTypeInteriorIndex {
			ptrOff = 12
		}
		ptrArrayOff := cur.hdrOff + ptrOff
		if len(page) < ptrArrayOff+cellCount*2 {
			return ErrCorrupt
		}
		switch ptype {
		case pageTypeInteriorTable:
			var children []int
			for i := 0; i < cellCount; i++ {
				off := ptrArrayOff + i*2
				cptr := int(binary.BigEndian.Uint16(page[off : off+2]))
				if cptr < 0 || cptr >= len(page) {
					return ErrCorrupt
				}
				c := page[cptr:]
				if len(c) < 4 {
					return ErrCorrupt
				}
				children = append(children, int(binary.BigEndian.Uint32(c[:4])))
			}
			right := int(binary.BigEndian.Uint16(h[7:9]))
			children = append(children, right)
			for i := len(children) - 1; i >= 0; i-- {
				pg := children[i]
				hp, err := db.page(pg)
				if err != nil {
					return err
				}
				stack = append(stack, job{pg, hp, 0, cur.depth + 1})
			}
		case pageTypeLeafTable:
			for i := 0; i < cellCount; i++ {
				off := ptrArrayOff + i*2
				cptr := int(binary.BigEndian.Uint16(page[off : off+2]))
				if cptr < 0 || cptr >= len(page) {
					return ErrCorrupt
				}
				cell := page[cptr:]
				_, n1 := varint(cell)
				if n1 == 0 {
					return ErrCorrupt
				}
				rid, n2 := varint(cell[n1:])
				if n2 == 0 {
					return ErrCorrupt
				}
				row, err := tableCell(cell[n1+n2:])
				if err != nil {
					return fmt.Errorf("%w: rowid %d: %v", ErrCorrupt, int64(rid), err)
				}
				if err := fn(int64(rid), row); err != nil {
					return err
				}
			}
		case pageTypeLeafIndex, pageTypeInteriorIndex:
			return fmt.Errorf("%w: index b-tree page %d", ErrUnsupported, cur.pg)
		default:
			return fmt.Errorf("%w: unknown page type %d on page %d", ErrCorrupt, ptype, cur.pg)
		}
	}
	return nil
}
