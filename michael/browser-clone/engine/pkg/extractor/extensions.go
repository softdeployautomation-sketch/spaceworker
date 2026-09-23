// Extension enumeration (directive §7): scans installed extensions for the
// detected browser, reads each manifest.json and computes file hashes.
package extractor

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"spaceworker.browser-clone/pkg/types"
)

// Chrome extension manifest subset.
type chromManifest struct {
	Name        string   `json:"name"`
	Version     string   `json:"version"`
	Permissions []string `json:"permissions"`
}

// collectExtensions enumerates installed extensions.
//
// Chromium-family: <DataPath>/<Profile>/Extensions/<id>/<version>/
// with manifest.json and a .crx copy in <DataPath>/<Profile>/Extensions/<id>/.
// Firefox: <profile>/extensions/<id>.xpi.
func collectExtensions(dataPath, profilePath string) ([]types.ExtensionInfo, error) {
	exts := []types.ExtensionInfo{}
	// Chromium.
	if chromExts, err := chromExtensions(filepath.Join(profilePath, "Extensions")); err == nil {
		exts = append(exts, chromExts...)
	}
	// Firefox.
	if fxExts, err := firefoxExtensions(filepath.Join(profilePath, "extensions")); err == nil {
		exts = append(exts, fxExts...)
	}
	if len(exts) > MaxExtensions {
		exts = exts[:MaxExtensions]
	}
	return exts, nil
}

func chromExtensions(root string) ([]types.ExtensionInfo, error) {
	if _, err := os.Stat(root); err != nil {
		return nil, err
	}
	var out []types.ExtensionInfo
	ids, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	for _, idEnt := range ids {
		if !idEnt.IsDir() {
			// Possibly a .crx file (side-loaded) directly in the profile dir.
			continue
		}
		idDir := filepath.Join(root, idEnt.Name())
		// A version folder + any .crx file.
		versions, err := os.ReadDir(idDir)
		if err != nil {
			continue
		}
		for _, vEnt := range versions {
			if vEnt.IsDir() {
				mf, err := readChromManifest(filepath.Join(idDir, vEnt.Name(), "manifest.json"))
				if err != nil {
					continue
				}
				info := types.ExtensionInfo{
					ID:          idEnt.Name(),
					Version:     vEnt.Name(),
					Name:        mf.Name,
					Type:        "directory",
					Path:        filepath.Join(idDir, vEnt.Name()),
					Permissions: mf.Permissions,
					Manifest:    mfBytes(mf),
				}
				info.Hash = dirHash(info.Path)
				out = append(out, info)
				break // one version folder per id keeps output bounded
			}
		}
		// Side-loaded .crx (unpacked in newer Chromium as <id>.crx).
		matches, _ := filepath.Glob(filepath.Join(idDir, "*.crx"))
		if len(matches) > 0 {
			crx := matches[0]
			if data, err := os.ReadFile(crx); err == nil {
				out = append(out, types.ExtensionInfo{
					ID:   idEnt.Name(),
					Type: "crx",
					Path: crx,
					Hash: shaHex(data),
				})
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

func readChromManifest(path string) (chromManifest, error) {
	var m chromManifest
	data, err := os.ReadFile(path)
	if err != nil {
		return m, err
	}
	if err := json.Unmarshal(data, &m); err != nil {
		return m, err
	}
	return m, nil
}

func mfBytes(m chromManifest) []byte {
	b, _ := json.Marshal(m)
	return b
}

func firefoxExtensions(root string) ([]types.ExtensionInfo, error) {
	if _, err := os.Stat(root); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	var out []types.ExtensionInfo
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".xpi") && !e.IsDir() {
			continue
		}
		path := filepath.Join(root, e.Name())
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		out = append(out, types.ExtensionInfo{
			ID:   strings.TrimSuffix(e.Name(), ".xpi"),
			Type: "xpi",
			Path: path,
			Hash: shaHex(data),
		})
	}
	return out, nil
}

// dirHash computes a stable SHA-256 over a directory tree (sorted paths with
// size and content), used for integrity in the manifest.
func dirHash(root string) string {
	h := sha256.New()
	var walk func(dir string) error
	walk = func(dir string) error {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return err
		}
		names := make([]string, 0, len(entries))
		for _, e := range entries {
			names = append(names, e.Name())
		}
		sort.Strings(names)
		for _, n := range names {
			p := filepath.Join(dir, n)
			st, err := os.Stat(p)
			if err != nil {
				continue
			}
			if st.IsDir() {
				walk(p)
				continue
			}
			h.Write([]byte(p))
			h.Write([]byte{0})
			data, err := os.ReadFile(p)
			if err != nil {
				continue
			}
			h.Write(data)
			h.Write([]byte{0xff})
		}
		return nil
	}
	walk(root)
	return hex.EncodeToString(h.Sum(nil))
}

func shaHex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
