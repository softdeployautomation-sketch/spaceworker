// Package registry tracks clone lifecycle state on each PC (directive §6/§7/§8).
//
// On Windows deployments entries live in
//
//	HKLM\Software\TacticalRMM\CloneRegistry\{clone_id}
//
// (values: status, expires_at, browser_type, ..., transport_key as a
// DPAPI-protected blob). This package provides the same schema as a small
// file-per-entry JSON store under a base directory so the full pipeline is
// exercisable cross-platform and in CI without registry access. The CLI and
// native host use this store; scripts/install-registry.ps1 documents the
// mapping to the real Windows registry for production.
package registry

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"

	"spaceworker.browser-clone/pkg/crypto"
	"spaceworker.browser-clone/pkg/types"
)

// Store is a file-backed clone registry.
type Store struct {
	Dir string
}

// New creates (if needed) the registry directory and returns a Store.
func New(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("registry: cannot create %s: %w", dir, err)
	}
	return &Store{Dir: dir}, nil
}

// DefaultDir returns the platform default registry directory. Windows mirrors
// HKLM\Software\TacticalRMM\CloneRegistry under %ProgramData%; other platforms
// use the user config dir.
func DefaultDir() string {
	switch runtime.GOOS {
	case "windows":
		base := os.Getenv("PROGRAMDATA")
		if base == "" {
			base = filepath.Join(os.Getenv("SystemDrive"), "ProgramData")
		}
		return filepath.Join(base, "TacticalRMM", "CloneRegistry")
	default:
		if d, err := os.UserConfigDir(); err == nil {
			return filepath.Join(d, "spaceworker-browser-clone", "registry")
		}
		return filepath.Join(os.TempDir(), "spaceworker-browser-clone", "registry")
	}
}

// path returns the entry file for a clone id.
func (s *Store) path(cloneID string) string {
	return filepath.Join(s.Dir, safeName(cloneID)+".json")
}

// safeName sanitises a clone id for use as a file name.
func safeName(id string) string {
	id = strings.ReplaceAll(id, "/", "_")
	id = strings.ReplaceAll(id, "\\", "_")
	id = strings.ReplaceAll(id, "..", "_")
	return id
}

// Save persists an entry. If the entry carries a plaintext TransportKey it is
// wrapped with the platform protector (DPAPI at MACHINE scope on Windows, dev
// key elsewhere) before being written; plaintext keys are never written to
// disk. Machine scope is required so the receiver service (running in its own
// logon session) can unwrap a key provisioned from an RMM agent session.
func (s *Store) Save(e *types.CloneRegistryEntry) error {
	cp := *e
	if len(cp.TransportKey) > 0 {
		wrapped, err := crypto.ProtectBytesMachine(cp.TransportKey, nil)
		if err != nil {
			return fmt.Errorf("registry: cannot protect transport key: %w", err)
		}
		cp.TransportKeyB64 = crypto.B64Encode(wrapped)
	}
	cp.TransportKey = nil
	data, err := json.MarshalIndent(&cp, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(s.Dir, 0o700); err != nil {
		return err
	}
	return os.WriteFile(s.path(cp.CloneId), data, 0o600)
}

// Load reads an entry by clone id and unwraps the protected transport key.
func (s *Store) Load(cloneID string) (*types.CloneRegistryEntry, error) {
	data, err := os.ReadFile(s.path(cloneID))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("%s: no clone %s in registry", types.ErrKeyNotFound, cloneID)
		}
		return nil, err
	}
	var e types.CloneRegistryEntry
	// BOM-tolerant: entries may be provisioned by PowerShell tooling.
	if err := types.UnmarshalJSONBOM(data, &e); err != nil {
		return nil, fmt.Errorf("registry: corrupt entry %s: %w", cloneID, err)
	}
	if e.TransportKeyB64 != "" {
		wrapped, err := crypto.B64Decode(e.TransportKeyB64)
		if err != nil {
			return nil, fmt.Errorf("registry: corrupt key for %s: %w", cloneID, err)
		}
		key, err := crypto.UnprotectBytesMachine(wrapped, nil)
		if err != nil {
			return nil, fmt.Errorf("registry: cannot unwrap key for %s: %w", cloneID, err)
		}
		e.TransportKey = key
	}
	return &e, nil
}

// List returns all entries, newest created first.
func (s *Store) List() ([]*types.CloneRegistryEntry, error) {
	entries, err := os.ReadDir(s.Dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var out []*types.CloneRegistryEntry
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		ev, err := s.Load(strings.TrimSuffix(e.Name(), ".json"))
		if err != nil {
			continue
		}
		out = append(out, ev)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt > out[j].CreatedAt })
	return out, nil
}

// Delete removes an entry from the registry.
func (s *Store) Delete(cloneID string) error {
	err := os.Remove(s.path(cloneID))
	if err != nil && os.IsNotExist(err) {
		return nil
	}
	return err
}

// UpdateStatus flips the status of an entry (creating it with the default
// fields if needed) and persists the change.
func (s *Store) UpdateStatus(cloneID, status string) error {
	e, err := s.Load(cloneID)
	if err != nil {
		e = &types.CloneRegistryEntry{CloneId: cloneID, CreatedAt: types.NowIso()}
	}
	e.Status = status
	return s.Save(e)
}
