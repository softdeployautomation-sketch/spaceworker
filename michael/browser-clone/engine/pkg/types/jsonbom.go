package types

import (
	"bytes"
	"encoding/json"
)

// utf8BOM is the byte-order mark PowerShell 5.1 prepends when a script writes
// JSON via `Set-Content -Encoding UTF8`. Observed in the field: a work-PC
// profile-customization script BOM'd Preferences/Bookmarks, the BOM rode
// through the clone pipeline, and strict JSON parses downstream rejected the
// files as corrupt. All parsing of externally written JSON (staged manifests,
// registry entries) goes through UnmarshalJSONBOM so a BOM can no longer
// masquerade as corruption.
var utf8BOM = []byte{0xEF, 0xBB, 0xBF}

// UnmarshalJSONBOM decodes JSON that may carry a leading UTF-8 BOM.
func UnmarshalJSONBOM(data []byte, v any) error {
	return json.Unmarshal(bytes.TrimPrefix(data, utf8BOM), v)
}
