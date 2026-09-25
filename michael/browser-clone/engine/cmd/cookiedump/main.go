// Command cookiedump extracts Chromium cookies as PLAINTEXT JSON.
//
// Why this exists (TASK_117 / B7): the profile bundle ships Passwords but has no
// cookie path at all, and cookies are what make a clone look "signed in". It also
// cannot be fixed by copying the profile: a hosted clone runs on Linux, and
// Chromium (a) deletes cookie rows it did not write and (b) encrypts under a key
// the other machine cannot derive. So the only workable route is to decrypt on the
// SOURCE and re-inject through the target browser via CDP.
//
// Output shape is deliberately exactly what scripts/clone-cdp.mjs --cookies takes,
// so the pipeline is:  cookiedump.exe --out c.json  ->  clone-cdp.mjs inject
//
//	cookiedump --browser chrome --out cookies.json
//
// Two scheme notes, both measured:
//   - Windows `v10`/`v11` cookie values are AES-256-GCM: nonce is bytes [3:15],
//     then ciphertext, then a 16-byte tag. This uses crypto.OpenGCM.
//     (crypto.DecryptChromeValue is the LEGACY CBC scheme and does not decrypt
//     modern values — do not swap it in here.)
//   - expires_utc is microseconds since 1601-01-01, not a Unix timestamp.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"spaceworker.browser-clone/pkg/browser"
	"spaceworker.browser-clone/pkg/crypto"
	"spaceworker.browser-clone/pkg/sqlite"
)

// chromeEpochOffset converts Chromium's 1601-based microseconds to Unix seconds.
const chromeEpochOffset = 11644473600

type cookie struct {
	Name     string `json:"name"`
	Value    string `json:"value"`
	Domain   string `json:"domain"`
	Path     string `json:"path"`
	Expires  int64  `json:"expires,omitempty"`
	Secure   bool   `json:"secure,omitempty"`
	HTTPOnly bool   `json:"httpOnly,omitempty"`
}

type report struct {
	Browser    string         `json:"browser"`
	Profile    string         `json:"profile"`
	CookiesDB  string         `json:"cookies_db"`
	Total      int            `json:"total_rows"`
	Decrypted  int            `json:"decrypted"`
	Plain      int            `json:"plaintext"`
	Failed     int            `json:"failed"`
	Schemes    map[string]int `json:"schemes,omitempty"`
	Cookies    []cookie       `json:"cookies"`
	FailReason string         `json:"fail_reason,omitempty"`
}

func main() {
	browserType := flag.String("browser", "chrome", "chrome|edge|brave")
	out := flag.String("out", "", "write JSON here (default stdout)")
	flag.Parse()

	rep := report{Browser: *browserType}

	prof, err := browser.DetectProfile(*browserType)
	if err != nil {
		fatal(rep, *out, "detect profile: "+err.Error())
	}
	rep.Profile = prof.ProfilePath

	// Local State holds os_crypt.encrypted_key (DPAPI-wrapped on Windows).
	localState, err := os.ReadFile(filepath.Join(prof.DataPath, "Local State"))
	if err != nil {
		fatal(rep, *out, "read Local State: "+err.Error())
	}
	payload, err := crypto.ParseLocalStateKey(localState)
	if err != nil {
		fatal(rep, *out, "parse Local State key: "+err.Error())
	}
	key, err := crypto.DecodeChromeKey(payload)
	if err != nil {
		fatal(rep, *out, "decode Chrome key: "+err.Error())
	}

	// Modern Chromium keeps cookies under <profile>/Network/Cookies.
	cookiesPath := filepath.Join(prof.ProfilePath, "Network", "Cookies")
	if _, statErr := os.Stat(cookiesPath); statErr != nil {
		alt := filepath.Join(prof.ProfilePath, "Cookies")
		if _, altErr := os.Stat(alt); altErr != nil {
			fatal(rep, *out, "no Cookies DB at "+cookiesPath+" or "+alt)
		}
		cookiesPath = alt
	}
	rep.CookiesDB = cookiesPath

	data, err := os.ReadFile(cookiesPath)
	if err != nil {
		fatal(rep, *out, "read Cookies DB: "+err.Error())
	}
	db, err := sqlite.Open(data)
	if err != nil {
		// WAL-mode DBs are rejected by the reader; say so plainly rather than
		// reporting "no cookies", which would look like an empty profile.
		fatal(rep, *out, "open Cookies DB: "+err.Error())
	}

	rows, err := db.Query("cookies", sqlite.QueryOpts{})
	if err != nil {
		fatal(rep, *out, "query cookies: "+err.Error())
	}
	rep.Total = len(rows)

	for _, r := range rows {
		name, _ := r["name"].(string)
		host, _ := r["host_key"].(string)
		path, _ := r["path"].(string)
		plain, _ := r["value"].(string)
		enc, _ := r["encrypted_value"].([]byte)
		if name == "" || host == "" {
			continue
		}

		value := plain
		switch {
		case plain != "":
			rep.Plain++
		case len(enc) > 0:
			// Record the encryption scheme. This matters: Chrome 127+ uses
			// App-Bound Encryption ("v20"), whose key is NOT the DPAPI-wrapped
			// os_crypt key, so those values cannot be decrypted out-of-process.
			if rep.Schemes == nil {
				rep.Schemes = map[string]int{}
			}
			rep.Schemes[schemeOf(enc)]++
			dec, derr := decryptValue(key, enc)
			if derr != nil {
				rep.Failed++
				continue
			}
			value = string(dec)
			rep.Decrypted++
		default:
			continue // nothing to send
		}

		c := cookie{Name: name, Value: value, Domain: host, Path: path}
		if path == "" {
			c.Path = "/"
		}
		c.Secure = asBool(r["is_secure"])
		c.HTTPOnly = asBool(r["is_httponly"])
		if exp := asInt(r["expires_utc"]); exp > 0 {
			if unix := exp/1000000 - chromeEpochOffset; unix > 0 {
				c.Expires = unix
			}
		}
		rep.Cookies = append(rep.Cookies, c)
	}

	write(rep, *out)
	fmt.Printf("cookies=%d decrypted=%d plaintext=%d failed=%d profile=%s\n",
		len(rep.Cookies), rep.Decrypted, rep.Plain, rep.Failed, rep.Profile)
	if len(rep.Schemes) > 0 {
		fmt.Printf("schemes=%v\n", rep.Schemes)
	}
}

// schemeOf names the encryption scheme of an encrypted_value, using only its
// 3-byte version prefix (never the ciphertext).
func schemeOf(enc []byte) string {
	if len(enc) >= 3 {
		switch string(enc[:3]) {
		case "v10", "v11", "v20":
			return string(enc[:3])
		case "DPA":
			return "DPAPI"
		}
	}
	if len(enc) == 0 {
		return "empty"
	}
	return "unknown"
}

// decryptValue handles the modern Chromium schemes.
func decryptValue(key *crypto.ChromeKey, enc []byte) ([]byte, error) {
	// v10/v11: "<3-byte version><12-byte nonce><ciphertext><16-byte tag>".
	if (strings.HasPrefix(string(enc), "v10") || strings.HasPrefix(string(enc), "v11")) && len(enc) > 3+12+16 {
		nonce := enc[3:15]
		rest := enc[15:]
		ct, tag := rest[:len(rest)-16], rest[len(rest)-16:]
		return crypto.OpenGCM(key.Raw, ct, nonce, tag, nil)
	}
	// Older profiles wrap the whole blob with DPAPI directly.
	if strings.HasPrefix(string(enc), "DPAPI") {
		return crypto.UnprotectBytes(enc[len("DPAPI"):], nil)
	}
	return nil, fmt.Errorf("unsupported cookie value scheme (%d bytes)", len(enc))
}

// asBool reads SQLite's integer booleans (0/1). Chromium stores is_secure and
// is_httponly as INTEGER, which the reader surfaces as int64.
func asBool(v any) bool {
	switch t := v.(type) {
	case int64:
		return t != 0
	case float64:
		return t != 0
	case bool:
		return t
	}
	return false
}

func asInt(v any) int64 {
	switch t := v.(type) {
	case int64:
		return t
	case float64:
		return int64(t)
	}
	return 0
}

func write(rep report, out string) {
	blob, _ := json.MarshalIndent(rep, "", "  ")
	if out == "" {
		fmt.Println(string(blob))
		return
	}
	// 0600: this file holds live session cookies.
	if err := os.WriteFile(out, blob, 0o600); err != nil {
		fmt.Fprintln(os.Stderr, "write out:", err)
		os.Exit(1)
	}
}

// fatal reports the failure INSIDE the JSON too, so a caller parsing the file
// never mistakes an error for an empty profile.
func fatal(rep report, out, msg string) {
	rep.FailReason = msg
	write(rep, out)
	fmt.Fprintln(os.Stderr, "cookiedump: "+msg)
	os.Exit(1)
}
