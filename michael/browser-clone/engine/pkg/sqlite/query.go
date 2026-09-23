// Public query API and CREATE TABLE column parsing.
package sqlite

import (
	"errors"
	"fmt"
)

// findTable returns the schema entry for a named table, or an error.
func (db *DB) findTable(name string) (*schemaEntry, error) {
	entries, err := db.schema()
	if err != nil {
		return nil, err
	}
	for i := range entries {
		if entries[i].Type == "table" && entries[i].Name == name {
			return &entries[i], nil
		}
	}
	return nil, fmt.Errorf("%w: %s", ErrTableNotFound, name)
}

// TableColumns returns the declared column names of a table (parsed from its
// CREATE TABLE statement).
func (db *DB) TableColumns(table string) ([]string, error) {
	ent, err := db.findTable(table)
	if err != nil {
		return nil, err
	}
	cols := parseCreateColumns(ent.SQL)
	if len(cols) == 0 {
		return nil, fmt.Errorf("%w: %s has no parseable column list", ErrUnsupported, table)
	}
	return cols, nil
}

// QueryOpts control a table scan.
type QueryOpts struct {
	// WhereColumn / WhereValue apply an exact-match filter (single column).
	WhereColumn string
	WhereValue  string
	// Limit caps the number of returned rows (0 = unlimited).
	Limit int
}

// Query scans a rowid table and returns each row keyed by column name.
func (db *DB) Query(table string, opts QueryOpts) ([]map[string]any, error) {
	ent, err := db.findTable(table)
	if err != nil {
		return nil, err
	}
	cols, err := db.TableColumns(table)
	if err != nil {
		return nil, err
	}
	if opts.WhereColumn != "" {
		found := false
		for _, c := range cols {
			if c == opts.WhereColumn {
				found = true
				break
			}
		}
		if !found {
			return nil, fmt.Errorf("%w: %s.%s", ErrColumnNotFound, table, opts.WhereColumn)
		}
	}
	if ent.RootPage <= 0 {
		return nil, fmt.Errorf("%w: %s (root page %d)", ErrNotRowidTable, table, ent.RootPage)
	}
	var fullPage []byte
	headerOffset := 0
	if ent.RootPage == 1 {
		p1, err := db.page(1)
		if err != nil {
			return nil, err
		}
		fullPage = p1
		headerOffset = 100
	} else {
		fullPage, err = db.page(ent.RootPage)
		if err != nil {
			return nil, err
		}
	}
	var rows []map[string]any
	err = db.walk(ent.RootPage, fullPage, headerOffset, func(rowid int64, row Row) error {
		_ = rowid
		if opts.Limit > 0 && len(rows) >= opts.Limit {
			return errStop
		}
		m := make(map[string]any, len(cols))
		for i, c := range cols {
			if i < len(row) {
				m[c] = row[i]
			} else {
				m[c] = nil
			}
		}
		if opts.WhereColumn != "" {
			v, ok := m[opts.WhereColumn]
			if !ok || !cellMatches(v, opts.WhereValue) {
				return nil
			}
		}
		rows = append(rows, m)
		return nil
	})
	if err == errStop {
		err = nil
	}
	if err != nil {
		return nil, err
	}
	return rows, nil
}

// errStop halts a scan early when Limit is reached.
var errStop = errors.New("sqlite: scan stopped")

// cellMatches reports whether a cell value equals the filter string.
func cellMatches(v Cell, want string) bool {
	switch t := v.(type) {
	case string:
		return t == want
	case int64:
		return fmt.Sprintf("%d", t) == want
	case float64:
		return fmt.Sprintf("%v", t) == want
	case nil:
		return want == ""
	default:
		return false
	}
}

// parseCreateColumns extracts column names from a CREATE TABLE statement.
func parseCreateColumns(sql string) []string {
	open := -1
	for i := 0; i < len(sql); i++ {
		if sql[i] == '(' {
			open = i
			break
		}
	}
	if open < 0 {
		return nil
	}
	depth := 0
	listStart := -1
	for i := open; i < len(sql); i++ {
		switch sql[i] {
		case '(':
			depth++
			if depth == 1 {
				listStart = i + 1
			}
		case ')':
			depth--
			if depth == 0 {
				return splitColumns(sql[listStart:i])
			}
		}
	}
	return nil
}

// splitColumns tokenizes a CREATE TABLE body into top-level comma-separated
// segments and returns the first identifier of each segment.
func splitColumns(body string) []string {
	var cols []string
	depth := 0
	start := 0
	inStr := byte(0)
	for i := 0; i < len(body); i++ {
		c := body[i]
		if inStr != 0 {
			if c == inStr && (i == 0 || body[i-1] != '\\') {
				inStr = 0
			}
			continue
		}
		switch c {
		case '\'', '"', '`':
			inStr = c
		case '(':
			depth++
		case ')':
			depth--
		case ',':
			if depth == 0 {
				cols = append(cols, firstIdent(body[start:i]))
				start = i + 1
			}
		}
	}
	if start < len(body) {
		cols = append(cols, firstIdent(body[start:]))
	}
	return cols
}

// firstIdent returns the first identifier-like token in s.
func firstIdent(s string) string {
	i := 0
	for i < len(s) && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r') {
		i++
	}
	if i < len(s) && (s[i] == '\'' || s[i] == '"' || s[i] == '`') {
		q := s[i]
		for j := i + 1; j < len(s); j++ {
			if s[j] == q {
				return s[i+1 : j]
			}
		}
		return s[i:]
	}
	j := i
	for j < len(s) && !isIdentDelim(s[j]) {
		j++
	}
	return s[i:j]
}

func isIdentDelim(c byte) bool {
	return c == ' ' || c == '\t' || c == '\n' || c == ',' || c == '(' || c == ')' || c == ';'
}
