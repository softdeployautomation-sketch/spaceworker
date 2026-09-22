// Record decoding (serial types, cell/record parsing).
package sqlite

import (
	"encoding/binary"
	"fmt"
	"math"
)

// decodeColumn returns the decoded value for a column given its serial type.
func decodeColumn(serialType uint64, body []byte, pos int) (Cell, int, error) {
	switch serialType {
	case 0:
		return nil, pos, nil
	case 1:
		if pos+1 > len(body) {
			return nil, pos, ErrCorrupt
		}
		return int64(int8(body[pos])), pos + 1, nil
	case 2:
		if pos+2 > len(body) {
			return nil, pos, ErrCorrupt
		}
		return int64(int16(binary.BigEndian.Uint16(body[pos:]))), pos + 2, nil
	case 3:
		if pos+3 > len(body) {
			return nil, pos, ErrCorrupt
		}
		v := uint32(body[pos])<<16 | uint32(body[pos+1])<<8 | uint32(body[pos+2])
		if v&0x800000 != 0 {
			v |= 0xFF000000
		}
		return int64(int32(v)), pos + 3, nil
	case 4:
		if pos+4 > len(body) {
			return nil, pos, ErrCorrupt
		}
		return int64(int32(binary.BigEndian.Uint32(body[pos:]))), pos + 4, nil
	case 5:
		if pos+6 > len(body) {
			return nil, pos, ErrCorrupt
		}
		v := uint64(body[pos])<<40 | uint64(body[pos+1])<<32 | uint64(body[pos+2])<<24 |
			uint64(body[pos+3])<<16 | uint64(body[pos+4])<<8 | uint64(body[pos+5])
		if v&0x800000000000 != 0 {
			v |= 0xFFFF000000000000
		}
		return int64(v), pos + 6, nil
	case 6:
		if pos+8 > len(body) {
			return nil, pos, ErrCorrupt
		}
		return int64(binary.BigEndian.Uint64(body[pos:])), pos + 8, nil
	case 7:
		if pos+8 > len(body) {
			return nil, pos, ErrCorrupt
		}
		return float64(math.Float64frombits(binary.BigEndian.Uint64(body[pos:]))), pos + 8, nil
	case 8:
		return int64(0), pos, nil
	case 9:
		return int64(1), pos, nil
	default:
		var size int
		if serialType >= 12 {
			if serialType%2 == 0 {
				size = (int(serialType) - 12) / 2 // blob
			} else {
				size = (int(serialType) - 13) / 2 // text
			}
		}
		if size < 0 || pos+size > len(body) {
			return nil, pos, ErrCorrupt
		}
		if serialType%2 == 1 {
			return string(body[pos : pos+size]), pos + size, nil
		}
		return append([]byte(nil), body[pos:pos+size]...), pos + size, nil
	}
}

// tableCell decodes a full record stored in a table-leaf cell body. The
// caller passes the record starting at its header-length varint (i.e. the
// cell body after the payload-length and rowid varints).
func tableCell(record []byte) (Row, error) {
	hdrLen, n := varint(record)
	if n == 0 {
		return nil, ErrCorrupt
	}
	pos := n
	// The header-length varint counts itself, so the header occupies
	// record[0:hdrLen]; serial types follow at record[1:hdrLen].
	limit := int(hdrLen)
	if limit > len(record) {
		return nil, ErrCorrupt
	}
	var serialTypes []uint64
	for pos < limit {
		var st uint64
		st, n = varint(record[pos:])
		if n == 0 {
			return nil, ErrCorrupt
		}
		serialTypes = append(serialTypes, st)
		pos += n
	}
	body := record[pos:]
	row := make(Row, 0, len(serialTypes))
	bp := 0
	for _, st := range serialTypes {
		v, np, err := decodeColumn(st, body, bp)
		if err != nil {
			return nil, err
		}
		row = append(row, v)
		bp = np
	}
	return row, nil
}

// dumpCell is a small diagnostic helper used by tests.
func dumpCell(c Cell) string {
	switch t := c.(type) {
	case nil:
		return "NULL"
	case string:
		return fmt.Sprintf("%q", t)
	case int64:
		return fmt.Sprintf("%d", t)
	case float64:
		return fmt.Sprintf("%v", t)
	case []byte:
		return fmt.Sprintf("%x", t)
	default:
		return fmt.Sprintf("%v", t)
	}
}
