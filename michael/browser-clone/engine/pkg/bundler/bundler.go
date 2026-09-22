// Package bundler turns a types.ProfileBundle into the transfer artifact set
// (manifest.json + profile.zip + extensions.zip + passwords.json) following
// the directive §5/§8 layouts and signs it with HMAC-SHA256 under the
// transport key.
package bundler

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"

	"spaceworker.browser-clone/pkg/crypto"
	"spaceworker.browser-clone/pkg/types"
)

// Bundle is the materialized transfer artifact set.
type Bundle struct {
	Manifest      types.CloneManifest
	ManifestJSON  []byte
	ProfileZip    []byte
	ExtensionsZip []byte
	PasswordsJSON []byte
	StagingDir    string
}

// Build assembles the artifact set from an extracted profile bundle using the
// given transport key. Password records are emitted as already-encrypted
// (AES-256-GCM) base64 payloads (passwords.json).
func Build(pb *types.ProfileBundle, key []byte) (*Bundle, error) {
	b := &Bundle{}

	// 1. profile.zip
	if len(pb.ProfileFiles) > 0 {
		profileZip, err := zipFiles(pb.ProfileFiles)
		if err != nil {
			return nil, err
		}
		b.ProfileZip = profileZip
	}

	// 2. extensions.zip
	if len(pb.Extensions) > 0 {
		extZip, err := zipExtensions(pb.Extensions)
		if err != nil {
			return nil, err
		}
		b.ExtensionsZip = extZip
	}

	// 3. passwords.json (already-transport-encrypted)
	b.PasswordsJSON = encodePasswords(pb.EncryptedPasswords)

	// 4. manifest
	m := types.CloneManifest{
		CloneId:             pb.Metadata.CloneId,
		SourcePc:            pb.Metadata.SourcePc,
		SourceUser:          pb.Metadata.SourceUser,
		SourceUserSid:       pb.Metadata.SourceUserSid,
		BrowserType:         pb.Metadata.BrowserType,
		BrowserVersion:      pb.Metadata.BrowserVersion,
		CreatedAt:           pb.Metadata.CreatedAt,
		ExpiresAt:           pb.Metadata.ExpiresAt,
		EgressProxy:         pb.Metadata.EgressProxy,
		PasswordsEncrypted:  len(pb.EncryptedPasswords) > 0,
		TransportKeyHash:    crypto.Sha256Hex(key),
		SessionValidityDays: validityDays(pb.Metadata.CreatedAt, pb.Metadata.ExpiresAt),
		ProfileZipSha256:    crypto.Sha256Hex(b.ProfileZip),
		ExtensionsZipSha256: crypto.Sha256Hex(b.ExtensionsZip),
		SignatureMethod:     "HMAC-SHA256",
	}
	for _, p := range sortedKeys(pb.ProfileFiles) {
		data := pb.ProfileFiles[p]
		m.TotalSizeBytes += int64(len(data))
		m.FileCount++
		m.Files = append(m.Files, types.ManifestFile{
			Path:   p,
			Size:   len(data),
			Sha256: crypto.Sha256Hex(data),
		})
	}
	for _, e := range pb.Extensions {
		m.Extensions = append(m.Extensions, types.ManifestExtension{
			ID:      e.ID,
			Version: e.Version,
			Type:    e.Type,
			Name:    e.Name,
			Hash:    e.Hash,
		})
		if e.Type == "web-store" {
			m.WebStoreCount++
		} else {
			m.SideLoadedCount++
		}
	}
	if v, ok := pb.LocalStorage["_count"]; ok {
		fmt.Sscanf(v, "%d", &m.LocalStorageEntries)
	}
	if v, ok := pb.SessionStorage["_count"]; ok {
		fmt.Sscanf(v, "%d", &m.SessionStorageEntries)
	}
	m.PasswordCount = len(pb.EncryptedPasswords)

	// 5. sign
	canon, err := canonical(m)
	if err != nil {
		return nil, err
	}
	m.Validation = computeValidation(m, pb)
	m.Signature = crypto.HmacSha256Hex(key, canon)

	mj, err := json.MarshalIndent(&m, "", "  ")
	if err != nil {
		return nil, err
	}
	b.Manifest = m
	b.ManifestJSON = mj
	return b, nil
}

// Write persists the artifact set under baseDir/<cloneId>/.
func (b *Bundle) Write(baseDir string) (string, error) {
	dir := filepath.Join(baseDir, b.Manifest.CloneId)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	write := func(name string, data []byte) error {
		if len(data) == 0 {
			return nil
		}
		return os.WriteFile(filepath.Join(dir, name), data, 0o600)
	}
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), b.ManifestJSON, 0o600); err != nil {
		return "", err
	}
	if err := write("profile.zip", b.ProfileZip); err != nil {
		return "", err
	}
	if err := write("extensions.zip", b.ExtensionsZip); err != nil {
		return "", err
	}
	if err := write("passwords.json", b.PasswordsJSON); err != nil {
		return "", err
	}
	b.StagingDir = dir
	return dir, nil
}

// zipFiles zips a flat map of slash-path -> bytes preserving relative paths.
func zipFiles(files map[string][]byte) ([]byte, error) {
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	for _, name := range sortedKeys(files) {
		data := files[name]
		fw, err := w.Create(name)
		if err != nil {
			return nil, err
		}
		if _, err := fw.Write(data); err != nil {
			return nil, err
		}
	}
	if err := w.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func sortedKeys(m map[string][]byte) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// zipExtensions archives extension directories/files under a stable prefix.
func zipExtensions(exts []types.ExtensionInfo) ([]byte, error) {
	if len(exts) == 0 {
		return nil, nil
	}
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	for _, e := range exts {
		if err := addExtToZip(w, e); err != nil {
			w.Close()
			return nil, err
		}
	}
	if err := w.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func addExtToZip(w *zip.Writer, e types.ExtensionInfo) error {
	// Windows-style extensions may be packaged as <id>.crx; directories are
	// represented by their manifest (already read during extraction).
	if len(e.Manifest) == 0 && e.Path == "" {
		return nil
	}
	if len(e.Manifest) > 0 {
		fw, err := w.Create("extensions/" + e.ID + "/manifest.json")
		if err != nil {
			return err
		}
		if _, err := fw.Write(e.Manifest); err != nil {
			return err
		}
		return nil
	}
	data, err := os.ReadFile(e.Path)
	if err != nil {
		return nil // missing file: skip
	}
	name := "extensions/" + e.ID + "/" + filepath.Base(e.Path)
	fw, err := w.Create(name)
	if err != nil {
		return err
	}
	if _, err := fw.Write(data); err != nil {
		return err
	}
	return nil
}

// canonical deterministically serialises a manifest (without signature and
// validation fields) for signing/verification.
func canonical(m types.CloneManifest) ([]byte, error) {
	cp := m
	cp.Signature = ""
	cp.Validation = ""
	return json.Marshal(&cp)
}

// VerifySignature recomputes the HMAC over canonical fields and compares.
func VerifySignature(m types.CloneManifest, key []byte) bool {
	canon, err := canonical(m)
	if err != nil {
		return false
	}
	want := crypto.HmacSha256Hex(key, canon)
	return want == m.Signature
}

// computeValidation runs the integrity checks described in the directive:
// every manifest file's SHA-256 must match the archived bytes.
func computeValidation(m types.CloneManifest, pb *types.ProfileBundle) string {
	for _, f := range m.Files {
		data, ok := pb.ProfileFiles[f.Path]
		if !ok {
			return "INVALID:missing:" + f.Path
		}
		if crypto.Sha256Hex(data) != f.Sha256 {
			return "INVALID:checksum:" + f.Path
		}
	}
	return "OK:integrity-verified"
}

// encodePasswords renders the transport-encrypted passwords as JSON.
func encodePasswords(enc []types.EncryptedPassword) []byte {
	if len(enc) == 0 {
		return nil
	}
	list := make([]types.EncryptedPasswordJSON, 0, len(enc))
	for _, p := range enc {
		list = append(list, types.EncryptedPasswordJSON{
			Origin:     p.Origin,
			Username:   p.Username,
			Ciphertext: crypto.B64Encode(p.Ciphertext),
			Nonce:      crypto.B64Encode(p.Nonce),
			AuthTag:    crypto.B64Encode(p.AuthTag),
		})
	}
	b, err := json.MarshalIndent(map[string]any{"passwords": list}, "", "  ")
	if err != nil {
		return nil
	}
	return b
}

// validityDays computes whole days between two RFC 3339 strings.
func validityDays(from, to string) int {
	f := types.ParseIso(from)
	t := types.ParseIso(to)
	if f.IsZero() || t.IsZero() {
		return 30
	}
	hours := int(t.Sub(f).Hours())
	d := hours / 24
	if d < 1 {
		d = 1
	}
	return d
}
