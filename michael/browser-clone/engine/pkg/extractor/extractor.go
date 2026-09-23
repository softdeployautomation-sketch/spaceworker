// Package extractor implements profile extraction (directive §2:
// pkg/extractor/extractor.go). Consolidates former extract.go helpers here.
package extractor

import (
	"os"
	"path/filepath"
	"strings"

	"spaceworker.browser-clone/pkg/crypto"
	"spaceworker.browser-clone/pkg/sqlite"
	"spaceworker.browser-clone/pkg/types"
)

// Limits (directive §4).
const (
	MaxBundleBytes = 200 * 1024 * 1024 // 200 MB profile size cap
	MaxFiles       = 2000              // file enumeration cap
	MaxExtensions  = 500
)

// ExtractOpts controls extraction behaviour.
type ExtractOpts struct {
	IncludePasswords bool
	SourcePc         string
	SourceUser       string
	SourceUserSid    string
	ExpiresInDays    int
	Profile          types.BrowserProfile
	TransportKey     []byte
	// EgressProxy is the work-PC egress relay endpoint recorded in the
	// manifest (directive §13: hosted clones browse via the work PC).
	EgressProxy string
}

// cryptoNewKey wraps crypto.NewKey for transport key generation.
func cryptoNewKey() ([]byte, error) { return crypto.NewKey() }

// codeErr converts a types Err* code string into an error value.
func codeErr(code string) error { return types.Code(code) }

// codeErrMsg converts a code string plus description into an error.
func codeErrMsg(code, msg string) error { return types.WithMessage(types.Code(code), msg) }

// Extract walks the profile and returns a fully populated ProfileBundle.
func Extract(opts ExtractOpts) (*types.ProfileBundle, error) {
	bundle := &types.ProfileBundle{}
	bundle.Metadata = types.CloneMetadata{
		CloneId:          types.NewUuid(),
		SourcePc:         opts.SourcePc,
		SourceUser:       opts.SourceUser,
		SourceUserSid:    opts.SourceUserSid,
		BrowserType:      opts.Profile.Type,
		BrowserVersion:   opts.Profile.Version,
		CreatedAt:        types.NowIso(),
		ExpiresAt:        types.AddDaysIso(types.NowIso(), opts.ExpiresInDays),
		IncludePasswords: opts.IncludePasswords,
		EgressProxy:      opts.EgressProxy,
	}
	if opts.TransportKey == nil {
		opts.TransportKey, _ = NewTransportKey()
	}
	files, _, err := collectProfileFiles(opts.Profile.ProfilePath)
	if err != nil {
		return nil, err
	}
	bundle.ProfileFiles = files
	if lsCount, ssCount, err := scanStorage(opts.Profile.ProfilePath); err == nil {
		bundle.LocalStorage = map[string]string{}
		bundle.SessionStorage = map[string]string{}
		if lsCount > 0 {
			bundle.LocalStorage["_count"] = types.Itoa(lsCount)
			bundle.LocalStorage["_source"] = "LevelDB (raw files bundled)"
		}
		if ssCount > 0 {
			bundle.SessionStorage["_count"] = types.Itoa(ssCount)
			bundle.SessionStorage["_source"] = "LevelDB (raw files bundled)"
		}
	}
	if opts.IncludePasswords {
		ok, err := extractPasswords(opts, bundle)
		if err != nil {
			return nil, err
		}
		if !ok {
			return nil, codeErr(types.ErrDPAPIDecryptFailed)
		}
	}
	if exts, err := collectExtensions(opts.Profile.DataPath, opts.Profile.ProfilePath); err == nil {
		bundle.Extensions = exts
	}
	return bundle, nil
}

// NewTransportKey returns a fresh random transport key.
func NewTransportKey() ([]byte, error) { return cryptoNewKey() }

func collectProfileFiles(root string) (map[string][]byte, int64, error) {
	files := map[string][]byte{}
	var total int64
	var count int
	var walk func(dir string, depth int) error
	walk = func(dir string, depth int) error {
		entries, e := os.ReadDir(dir)
		if e != nil {
			return nil
		}
		for _, ent := range entries {
			full := filepath.Join(dir, ent.Name())
			if ent.IsDir() {
				if depth < 6 {
					if e := walk(full, depth+1); e != nil {
						return e
					}
				}
				continue
			}
			rel, rerr := filepath.Rel(root, full)
			if rerr != nil {
				continue
			}
			if skipPath(filepath.ToSlash(rel)) {
				continue
			}
			st, e := os.Stat(full)
			if e != nil {
				continue
			}
			if st.Size() > int64(MaxBundleBytes) {
				return codeErrMsg(types.ErrProfileTooLarge, "file "+rel)
			}
			if total+st.Size() > int64(MaxBundleBytes) {
				return codeErrMsg(types.ErrProfileTooLarge, "profile exceeds cap")
			}
			data, e := os.ReadFile(full)
			if e != nil {
				if strings.Contains(strings.ToLower(e.Error()), "in use") || strings.Contains(strings.ToLower(e.Error()), "sharing violation") {
					return codeErrMsg(types.ErrProfileLocked, "locked file "+rel)
				}
				continue
			}
			files[filepath.ToSlash(rel)] = data
			total += int64(len(data))
			count++
			if count > MaxFiles {
				return codeErrMsg(types.ErrTooManyFiles, "too many files")
			}
		}
		return nil
	}
	if err := walk(root, 0); err != nil {
		return nil, 0, err
	}
	return files, total, nil
}

func skipPath(rel string) bool {
	lower := strings.ToLower(rel)
	switch {
	case strings.HasSuffix(lower, ".png"), strings.HasSuffix(lower, ".jpg"),
		strings.HasSuffix(lower, ".jpeg"), strings.HasSuffix(lower, ".gif"),
		strings.HasSuffix(lower, ".ico"), strings.HasSuffix(lower, ".woff"),
		strings.HasSuffix(lower, ".woff2"), strings.HasSuffix(lower, ".ttf"),
		strings.HasSuffix(lower, ".tmp"), strings.HasSuffix(lower, ".lock"):
		return true
	}
	if strings.Contains(lower, "cache") || strings.Contains(lower, "shader") || strings.Contains(lower, "process singleton") {
		return true
	}
	return false
}

func scanStorage(profilePath string) (int, int, error) {
	return countDbFiles(filepath.Join(profilePath, "Local Storage", "leveldb")), countDbFiles(filepath.Join(profilePath, "Session Storage")), nil
}

func countDbFiles(dir string) int {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	n := 0
	for _, e := range entries {
		name := strings.ToLower(e.Name())
		if strings.Contains(name, ".ldb") || strings.Contains(name, ".log") {
			n++
		}
	}
	return n
}

// extractPasswords reads Login Data, decrypts each password blob, and stores
// PasswordEntry + transport-EncryptedPassword pairs on the bundle. Returns
// (true, nil) on success; (false, nil) when no logins exist; (false,
// encrypted) when a supported Chrome key exists but can't be decrypted.
func extractPasswords(opts ExtractOpts, bundle *types.ProfileBundle) (bool, error) {
	switch bundle.Metadata.BrowserType {
	case types.BrowserChrome, types.BrowserEdge, types.BrowserBrave:
		return extractChromePasswords(opts, bundle)
	case types.BrowserFirefox:
		// Firefox stores logins in logins.json with per-record Triple-DES /
		// AES-GCM keys inside key4.db; the copies are bundled as-is and
		// decryption is handled by the native host on Windows with the real
		// primary password. This keeps Firefox out of scope for automatic
		// decryption (documented in IMPLEMENTATION.md).
		return true, nil
	default:
		return false, codeErr(types.ErrNotSupported)
	}
}

// getChromeKey loads the AES key from Local State (the DataPath root) for
// Chromium-family browsers.
func getChromeKey(opts ExtractOpts) (*crypto.ChromeKey, error) {
	localState := filepath.Join(opts.Profile.DataPath, "Local State")
	raw, err := os.ReadFile(localState)
	if err != nil {
		return nil, codeErr(types.ErrKeyNotFound)
	}
	payload, err := crypto.ParseLocalStateKey(raw)
	if err != nil {
		return nil, codeErr(types.ErrKeyNotFound)
	}
	key, err := crypto.DecodeChromeKey(payload)
	if err != nil {
		return nil, codeErr(types.ErrDPAPIDecryptFailed)
	}
	return key, nil
}

func extractChromePasswords(opts ExtractOpts, bundle *types.ProfileBundle) (bool, error) {
	ck, err := getChromeKey(opts)
	if err != nil {
		// Without the key we cannot decrypt; surface the failure so the CLI
		// can warn, but still keep the (encrypted) Login Data bundled.
		bundle.EncryptedPasswords = nil
		return false, err
	}
	loginDB := filepath.Join(opts.Profile.ProfilePath, "Login Data")
	data, err := os.ReadFile(loginDB)
	if err != nil {
		return true, nil // no logins file: nothing to do
	}
	db, err := sqlite.Open(data)
	if err != nil {
		// WAL-mode or corrupt: report locked/unsupported to the caller.
		if strings.Contains(err.Error(), "WAL") {
			return false, codeErr(types.ErrProfileLocked)
		}
		return true, nil
	}
	// Map Login Data column names to indexes defensively (Chromium versions
	// differ). We need origin_url, username_value, password_value.
	cols, err := db.TableColumns("logins")
	if err != nil {
		return true, nil
	}
	idxOrigin, idxUser, idxPass, idxUserEl, idxPassEl := -1, -1, -1, -1, -1
	for i, c := range cols {
		switch c {
		case "origin_url":
			idxOrigin = i
		case "username_value":
			idxUser = i
		case "password_value":
			idxPass = i
		case "username_element":
			idxUserEl = i
		case "password_element":
			idxPassEl = i
		}
	}
	if idxOrigin < 0 || idxUser < 0 || idxPass < 0 {
		return true, nil // unexpected schema; keep blob copy
	}
	rows, err := db.Query("logins", sqlite.QueryOpts{})
	if err != nil {
		return true, nil
	}
	key := opts.TransportKey
	for _, r := range rows {
		origin, _ := r["origin_url"].(string)
		username, _ := r["username_value"].(string)
		pwBlob, _ := r["password_value"].([]byte)
		if pwBlob == nil || len(pwBlob) < 3 {
			continue
		}
		plaintext, derr := ck.DecryptChromeValue(pwBlob, true)
		if derr != nil {
			// One bad record shouldn't abort the batch; skip it.
			continue
		}
		entry := types.PasswordEntry{
			Origin:        origin,
			Username:      username,
			EncryptedPass: pwBlob,
		}
		if idxUserEl >= 0 {
			entry.UsernameField, _ = r[cols[idxUserEl]].(string)
		}
		if idxPassEl >= 0 {
			entry.PasswordField, _ = r[cols[idxPassEl]].(string)
		}
		bundle.Passwords = append(bundle.Passwords, entry)

		// Re-encrypt in memory with the transport key (AES-256-GCM).
		ct, nonce, tag, serr := crypto.SealGCM(key, plaintext,
			[]byte("swclone:"+origin+":"+username))
		if serr != nil {
			continue
		}
		bundle.EncryptedPasswords = append(bundle.EncryptedPasswords, types.EncryptedPassword{
			Origin:     origin,
			Username:   username,
			Ciphertext: ct,
			Nonce:      nonce,
			AuthTag:    tag,
		})
	}
	return true, nil
}
