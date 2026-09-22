// Clone receiver + validator (directive §7): the five RECV CHECKs run in
// order on the hosted PC, then the staged tree is written under the clones
// root with a ".status" marker and the registry is updated.
package injection

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"spaceworker.browser-clone/pkg/audit"
	"spaceworker.browser-clone/pkg/bundler"
	"spaceworker.browser-clone/pkg/crypto"
	"spaceworker.browser-clone/pkg/registry"
	"spaceworker.browser-clone/pkg/transport"
	"spaceworker.browser-clone/pkg/types"
)

// DefaultStagingRoot mirrors C:\ProgramData\TacticalRMM\Clones (directive §7)
// on the current platform.
func DefaultStagingRoot() string {
	switch runtime.GOOS {
	case "windows":
		base := os.Getenv("PROGRAMDATA")
		if base == "" {
			base = filepath.Join(os.Getenv("SystemDrive"), "ProgramData")
		}
		return filepath.Join(base, "TacticalRMM", "Clones")
	default:
		if d, err := os.UserConfigDir(); err == nil {
			return filepath.Join(d, "spaceworker-browser-clone", "clones")
		}
		return filepath.Join(os.TempDir(), "spaceworker-browser-clone", "clones")
	}
}

// ReceiveOptions carries everything the receiver needs to validate and stage
// an incoming parcel.
type ReceiveOptions struct {
	StagingRoot  string // clones root (defaults to DefaultStagingRoot)
	TransportKey []byte // in-band key override (test/dev); the hosted-PC
	// agent normally obtains the key via the control-plane key exchange
	// (directive §6) and it is resolved from the registry by clone id.
	Registry *registry.Store
	Audit    *audit.Logger
	// HostBrowserType is the installed browser type on the hosted PC. Empty
	// skips the type check (only used in tests/offline pipelines).
	HostBrowserType string
	// HostBrowserVersion is the installed browser version; a major-version
	// difference is logged (RECV CHECK 2 allows compatible versions).
	HostBrowserVersion string
}

// Receive validates the parcel (RECV CHECKs 1-5) and stages it. The returned
// registry entry has status "ready-for-injection" and carries the unwrapped
// transport key in memory.
func Receive(p *transport.Parcel, opts ReceiveOptions) (*types.CloneRegistryEntry, error) {
	if opts.StagingRoot == "" {
		opts.StagingRoot = DefaultStagingRoot()
	}
	if opts.Registry == nil {
		opts.Registry, _ = registry.New(filepath.Join(opts.StagingRoot, "..", "registry"))
	}
	var al *audit.Logger
	if opts.Audit != nil {
		al = opts.Audit
	}

	// --- manifest ---------------------------------------------------------
	var m types.CloneManifest
	// BOM-tolerant decode: Windows-side writers (PowerShell 5.1) emit a UTF-8
	// BOM that encoding/json rejects with "invalid character 'ï'".
	if err := types.UnmarshalJSONBOM(p.ManifestJSON, &m); err != nil ||
		m.CloneId == "" || m.BrowserType == "" {
		if al != nil {
			al.Security(audit.EvSecurityIncident, p.CloneId,
				types.Code(types.ErrInvalidManifest), map[string]any{"check": "recv_manifest"})
		}
		return nil, fmt.Errorf("%s: invalid or missing manifest", types.ErrInvalidManifest)
	}

	// Transport key resolution (never from the bulk-data stream).
	key := opts.TransportKey
	if key == nil {
		if e, err := opts.Registry.Load(m.CloneId); err == nil && len(e.TransportKey) > 0 {
			key = e.TransportKey
		}
	}
	if key == nil {
		if al != nil {
			al.Security(audit.EvKeyNotFound, m.CloneId,
				types.Code(types.ErrKeyNotFound), map[string]any{"check": "recv_key_exchange"})
		}
		return nil, fmt.Errorf("%s: no transport key for clone %s (key exchange never completed)", types.ErrKeyNotFound, m.CloneId)
	}

	// [RECV CHECK 1] signature (HMAC-SHA256 under the transport key).
	if !bundler.VerifySignature(m, key) {
		if al != nil {
			al.Security(audit.EvSignatureMismatch, m.CloneId,
				types.Code(types.ErrSignatureMismatch), map[string]any{"check": "recv_signature"})
		}
		return nil, fmt.Errorf("%s: HMAC verification failed for %s", types.ErrSignatureMismatch, m.CloneId)
	}

	// [RECV CHECK 2] browser type + version compatibility.
	if opts.HostBrowserType != "" && opts.HostBrowserType != m.BrowserType {
		if al != nil {
			al.Security(audit.EvSecurityIncident, m.CloneId,
				types.Code(types.ErrBrowserTypeMismatch),
				map[string]any{"check": "recv_browser_type", "want": m.BrowserType, "have": opts.HostBrowserType})
		}
		return nil, fmt.Errorf("%s: work PC has %s but hosted PC has %s",
			types.ErrBrowserTypeMismatch, m.BrowserType, opts.HostBrowserType)
	}
	if opts.HostBrowserVersion != "" && m.BrowserVersion != "" &&
		major(opts.HostBrowserVersion) != major(m.BrowserVersion) {
		if al != nil {
			al.Log(types.AuditEvent{
				Event:          audit.EvVersionMismatch,
				CloneId:        m.CloneId,
				Status:         "warning",
				BrowserType:    m.BrowserType,
				BrowserVersion: m.BrowserVersion,
				Details:        map[string]any{"hosted_version": opts.HostBrowserVersion, "check": "recv_version"},
			})
		}
	}

	// [RECV CHECK 3] expiry.
	if types.IsExpired(m.ExpiresAt) {
		if al != nil {
			al.Security(audit.EvValidationFailed, m.CloneId,
				types.Code(types.ErrCloneExpired), map[string]any{"check": "recv_expiry", "expires_at": m.ExpiresAt})
		}
		return nil, fmt.Errorf("%s: clone expired at %s", types.ErrCloneExpired, m.ExpiresAt)
	}

	// [RECV CHECK 4] storage quota: need 1.5x the manifest size free
	// (directive §7).
	free, err := diskFree(opts.StagingRoot)
	if err == nil {
		need := m.TotalSizeBytes * 3 / 2
		if need > 0 && free < uint64(need) {
			return nil, fmt.Errorf("%s: need ~%d bytes, only %d free on %s",
				types.ErrInsufficientStorage, need, free, opts.StagingRoot)
		}
	}

	// [RECV CHECK 5] decompress + verify SHA-256 per manifest entry.
	dir := stagingDir(opts.StagingRoot, m.CloneId)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	profileDir := filepath.Join(dir, "profile")
	if err := os.MkdirAll(profileDir, 0o700); err != nil {
		return nil, err
	}
	if _, err := unzipTo(p.ProfileZip, profileDir); err != nil {
		return nil, fmt.Errorf("%s: profile.zip: %w", types.ErrIntegrityCheckFailed, err)
	}
	for _, f := range m.Files {
		data, err := os.ReadFile(filepath.Join(profileDir, filepath.FromSlash(f.Path)))
		if err != nil {
			return nil, fmt.Errorf("%s: missing file %s: %w", types.ErrIntegrityCheckFailed, f.Path, err)
		}
		if crypto.Sha256Hex(data) != f.Sha256 {
			if al != nil {
				al.Security(audit.EvValidationFailed, m.CloneId,
					types.Code(types.ErrIntegrityCheckFailed),
					map[string]any{"check": "recv_sha256", "file": f.Path})
			}
			return nil, fmt.Errorf("%s: sha256 mismatch on %s", types.ErrIntegrityCheckFailed, f.Path)
		}
	}
	if len(p.ExtensionsZip) > 0 {
		if _, err := unzipTo(p.ExtensionsZip, filepath.Join(dir, "extensions")); err != nil {
			return nil, fmt.Errorf("%s: extensions.zip: %w", types.ErrIntegrityCheckFailed, err)
		}
	}

	// --- stage the validated artifact set --------------------------------
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), p.ManifestJSON, 0o600); err != nil {
		return nil, err
	}
	if len(p.PasswordsJSON) > 0 {
		if err := os.WriteFile(filepath.Join(dir, "passwords.json"), p.PasswordsJSON, 0o600); err != nil {
			return nil, err
		}
	}
	if err := os.WriteFile(filepath.Join(dir, ".status"), []byte("ready-for-injection\n"), 0o600); err != nil {
		return nil, err
	}

	entry := &types.CloneRegistryEntry{
		CloneId:         m.CloneId,
		SourceWorkPc:    m.SourcePc,
		BrowserType:     m.BrowserType,
		BrowserVersion:  m.BrowserVersion,
		Status:          types.StatusReadyForInjection,
		CreatedAt:       m.CreatedAt,
		ExpiresAt:       m.ExpiresAt,
		ReceivedAt:      types.NowIso(),
		StagingDir:      dir,
		PasswordsCount:  m.PasswordCount,
		ExtensionsCount: m.SideLoadedCount + m.WebStoreCount,
		TransportKey:    key,
		EgressProxy:     m.EgressProxy,
	}
	if err := opts.Registry.Save(entry); err != nil {
		return nil, err
	}
	if al != nil {
		al.Info(audit.EvCloneTransferred, m.CloneId, "success", map[string]any{
			"browser": m.BrowserType, "staging": dir,
		})
	}
	return entry, nil
}

// major extracts the leading numeric component of a dotted version string.
func major(v string) string {
	v = strings.TrimSpace(v)
	i := strings.IndexByte(v, '.')
	if i < 0 {
		return v
	}
	return v[:i]
}
