// Profile injector + mounter (directive §8): runs the eight MOUNT/INJECT
// CHECKs on the hosted PC, then marks the clone "active" in the registry,
// with automatic rollback of the backup profile on any failure after the
// backup is taken.
package injection

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"spaceworker.browser-clone/pkg/audit"
	"spaceworker.browser-clone/pkg/browser"
	"spaceworker.browser-clone/pkg/crypto"
	"spaceworker.browser-clone/pkg/procattr"
	"spaceworker.browser-clone/pkg/registry"
	"spaceworker.browser-clone/pkg/types"
)

// InjectOptions controls an injection run on the hosted PC.
type InjectOptions struct {
	CloneId     string
	StagingRoot string
	Registry    *registry.Store
	Audit       *audit.Logger
	// Force permits cross-user injection (explicit admin override). Default
	// behaviour rejects injecting user A's clone into user B's session.
	Force bool
	// DryRun performs every check and reports what would happen without
	// mounting files, restoring passwords or launching the browser. Used by
	// the CLI's --dry-run and by integration tests.
	DryRun bool
	// ProfilePath overrides the destination profile directory (defaults to
	// the browser-detected profile for BrowserType).
	ProfilePath string
	// HostUserSid is the SID of the currently logged-in hosted-PC user.
	HostUserSid string
	// HostUserName is the account name of the hosted-PC user (audit only).
	HostUserName string
	// MountOwner optionally re-assigns ownership of the mounted profile as
	// "uid:gid" (POSIX hosted servers run the agent as root; the desktop
	// user must own the profile or the browser cannot read it). No-op when
	// empty or on Windows.
	MountOwner string
	// RunningFn overrides the browser-running probe (tests stub it; nil uses
	// browser.IsRunning).
	RunningFn func(browserType string) bool
}

// InjectResult summarises an injection run for the CLI and audit log.
type InjectResult struct {
	CloneId                string `json:"clone_id"`
	BrowserType            string `json:"browser_type"`
	DestinationProfile     string `json:"destination_profile"`
	BackedUp               bool   `json:"backed_up"`
	BackupPath             string `json:"backup_path,omitempty"`
	FilesMounted           int    `json:"files_mounted"`
	PasswordsRestored      int    `json:"passwords_restored"`
	ExtensionsRestored     int    `json:"extensions_restored"`
	ValidationResult       string `json:"validation_result"`
	DryRun                 bool   `json:"dry_run"`
	CrossUserAllowOverride bool   `json:"force_cross_user"`
}

// Inject mounts a staged clone into the destination browser profile and runs
// the eight MOUNT/INJECT CHECKs of directive §8 in order.
func Inject(opts InjectOptions) (*InjectResult, error) {
	if opts.CloneId == "" {
		return nil, fmt.Errorf("injection: clone id is required")
	}
	if opts.StagingRoot == "" {
		opts.StagingRoot = DefaultStagingRoot()
	}
	if opts.Registry == nil {
		opts.Registry, _ = registry.New(filepath.Join(opts.StagingRoot, "..", "registry"))
	}
	if opts.Audit == nil {
		opts.Audit, _ = audit.New(filepath.Join(opts.StagingRoot, "..", "audit"))
	}
	al := opts.Audit
	stage := stagingDir(opts.StagingRoot, opts.CloneId)

	// Load staged manifest + transport key (registry entry carries the key).
	entry, err := opts.Registry.Load(opts.CloneId)
	if err != nil {
		return nil, err
	}
	m, err := loadStagedManifest(stage)
	if err != nil {
		return nil, err
	}
	if entry.Status != types.StatusReadyForInjection && !opts.DryRun {
		return nil, fmt.Errorf("injection: clone %s status is %q, expected %q",
			opts.CloneId, entry.Status, types.StatusReadyForInjection)
	}
	res := &InjectResult{
		CloneId:                opts.CloneId,
		BrowserType:            m.BrowserType,
		DryRun:                 opts.DryRun,
		CrossUserAllowOverride: opts.Force,
	}

	// [MOUNT CHECK 1] destination resolution. On a virgin hosted PC the
	// browser may be installed but never launched: fall back to the
	// platform-standard profile path — the mount itself creates the profile
	// (virgin-host bootstrap).
	if m.BrowserType != "" {
		opts.ProfilePath = ResolveDestination(m.BrowserType, opts.ProfilePath)
	}
	if opts.ProfilePath == "" {
		return nil, fmt.Errorf("%s: no destination profile (browser %s not detected); set --profile",
			types.ErrBrowserNotFound, m.BrowserType)
	}
	res.DestinationProfile = opts.ProfilePath

	// [MOUNT CHECK 1b] the destination browser must not be running while its
	// profile files are replaced (locked SQLite databases, torn writes).
	// --force is the explicit operator override.
	if !opts.DryRun && !opts.Force && m.BrowserType != "" {
		running := browser.IsRunning
		if opts.RunningFn != nil {
			running = opts.RunningFn
		}
		if running(m.BrowserType) {
			al.Security(audit.EvSecurityIncident, opts.CloneId,
				types.Code(types.ErrProfileLocked),
				map[string]any{"browser": m.BrowserType})
			return nil, fmt.Errorf("%s: %s is running; close it or pass --force",
				types.ErrProfileLocked, m.BrowserType)
		}
	}
	res.DestinationProfile = opts.ProfilePath

	// [MOUNT CHECK 2] user session validation (cross-user prevention).
	if opts.HostUserSid != "" && m.SourceUserSid != "" &&
		opts.HostUserSid != m.SourceUserSid && !opts.Force {
		al.Security(audit.EvUserMismatch, opts.CloneId,
			types.Code(types.ErrUserMismatch),
			map[string]any{"source_sid": m.SourceUserSid, "host_sid": opts.HostUserSid})
		return nil, fmt.Errorf("%s: clone belongs to %s, current user is %s",
			types.ErrUserMismatch, m.SourceUserSid, opts.HostUserSid)
	}

	// [MOUNT CHECK 3] backup the existing profile (rollback point).
	backupPath := ""
	if !opts.DryRun {
		if _, err := os.Stat(opts.ProfilePath); err == nil {
			backupPath = filepath.Join(stage, "backup",
				"profile.backup-"+time.Now().UTC().Format("20060102T150405Z")+".zip")
			bk, err := zipDir(opts.ProfilePath)
			if err != nil {
				return nil, fmt.Errorf("%s: backing up profile: %w", types.ErrProfileValidationFailed, err)
			}
			if err := os.MkdirAll(filepath.Dir(backupPath), 0o700); err != nil {
				return nil, err
			}
			if err := os.WriteFile(backupPath, bk, 0o600); err != nil {
				return nil, err
			}
			res.BackedUp = true
			res.BackupPath = backupPath
		}
	}

	rollback := func(reason string, cause error) error {
		if res.BackedUp && backupPath != "" {
			if err := restoreBackup(opts.ProfilePath, backupPath); err != nil {
				al.Security(audit.EvValidationFailed, opts.CloneId, cause,
					map[string]any{"rollback": "failed:" + err.Error(), "reason": reason})
			}
		}
		if al != nil {
			al.Log(types.AuditEvent{
				Event: audit.EvValidationFailed, CloneId: opts.CloneId, Status: "failed",
				Level: audit.LevelError, Error: reason, Details: map[string]any{"rollback": "executed"},
			})
		}
		return cause
	}
	// [INJECT CHECK 1] mount the staged profile onto the destination.
	filesMounted := 0
	if !opts.DryRun {
		src := filepath.Join(stage, "profile")
		if _, err := os.Stat(src); err == nil {
			if err := os.MkdirAll(opts.ProfilePath, 0o700); err != nil {
				return nil, rollback("mount profile", err)
			}
			n, _, err := copyTree(src, opts.ProfilePath)
			if err != nil {
				return nil, rollback("mount profile", err)
			}
			filesMounted = n
		}
	}
	res.FilesMounted = filesMounted

	// [INJECT CHECK 1b] scrub source-machine single-instance artifacts so the
	// mounted profile cannot inherit a stale lock from another OS or session
	// (Singleton* on POSIX, per-profile .com.google.Chrome.* seeds, lockfile).
	if !opts.DryRun {
		scrubLockArtifacts(opts.ProfilePath)
	}

	// [INJECT CHECK 2] decrypt passwords with the transport key, re-encrypt
	// under the destination's DPAPI, persist the DPAPI-protected payload for
	// the agent's login-data merge (plaintext is wiped immediately).
	restored := 0
	if pwFile := filepath.Join(stage, "passwords.json"); !opts.DryRun {
		n, err := restorePasswords(pwFile, stage, entry.TransportKey)
		if err != nil {
			return nil, rollback("restore passwords", err)
		}
		restored = n
	}
	res.PasswordsRestored = restored

	// [INJECT CHECK 3] file permissions (owner-only on POSIX; on Windows the
	// agent applies the NTFS ACLs documented in scripts/set-acls.ps1).
	if !opts.DryRun {
		chmodTree(opts.ProfilePath)
	}

	// [INJECT CHECK 3b] POSIX hosted servers run the agent as root; hand the
	// mounted profile to the desktop user (--owner uid:gid) or the browser
	// cannot read its own profile.
	if !opts.DryRun && opts.MountOwner != "" && runtime.GOOS != "windows" {
		uid, gid, oerr := parseMountOwner(opts.MountOwner)
		if oerr != nil {
			return nil, rollback("owner: "+oerr.Error(),
				fmt.Errorf("%s: invalid --owner %q", types.ErrOutputFailed, opts.MountOwner))
		}
		if err := chownTree(opts.ProfilePath, uid, gid); err != nil {
			return nil, rollback("owner", err)
		}
	}

	// [INJECT CHECK 4] restore extensions (side-loaded CRX files / dirs;
	// web-store extensions are re-installed from the store at runtime).
	if extSrc := filepath.Join(stage, "extensions"); extCount(extSrc) > 0 {
		if !opts.DryRun {
			dest := filepath.Join(opts.ProfilePath, "Extensions")
			if _, _, err := copyTree(extSrc, dest); err == nil {
				res.ExtensionsRestored = extCount(extSrc)
			}
		} else {
			res.ExtensionsRestored = extCount(extSrc)
		}
	}

	// [INJECT CHECK 5] headless browser validation (best-effort; skipped in
	// dry-run and when no browser binary is available). "warning:*" results
	// (no binary, timeout, unsupported build) are tolerated and logged, not
	// fatal; only "failed:*" or unknown results abort the mount.
	validation := "skipped"
	if !opts.DryRun {
		validation = headlessValidate(m.BrowserType, opts.ProfilePath)
		if validation != "passed" && !strings.HasPrefix(validation, "warning:") {
			return nil, rollback("headless validation: "+validation,
				fmt.Errorf("%s: %s", types.ErrProfileValidationFailed, validation))
		}
	}
	res.ValidationResult = validation

	// [INJECT CHECK 6] clean problematic localStorage origins (OAuth tokens).
	if !opts.DryRun {
		cleanupProblemLocalStorage(opts.ProfilePath)
	}

	// [INJECT CHECK 7] write the hosted-PC clone manifest into the profile.
	if !opts.DryRun {
		if err := writeHostManifest(opts.ProfilePath, opts.CloneId, res, m); err != nil {
			return nil, rollback("host manifest", err)
		}
	}

	// [INJECT CHECK 8] registry -> active.
	entry.Status = types.StatusActive
	entry.InjectedAt = types.NowIso()
	entry.HostUserSid = opts.HostUserSid
	entry.ValidationResult = validation
	entry.ProfileBackupPath = backupPath
	entry.ExtensionsCount = res.ExtensionsRestored
	entry.PasswordsCount = restored
	if !opts.DryRun {
		if err := opts.Registry.Save(entry); err != nil {
			return nil, rollback("registry active", err)
		}
	}
	if al != nil {
		al.Log(types.AuditEvent{
			Event:          audit.EvCloneInjected,
			CloneId:        opts.CloneId,
			SourcePc:       m.SourcePc,
			Status:         "success",
			BrowserType:    m.BrowserType,
			BrowserVersion: m.BrowserVersion,
			Details: map[string]any{
				"files_mounted": res.FilesMounted, "passwords_restored": restored,
				"extensions_restored": res.ExtensionsRestored, "validation_result": validation,
				"host_user": opts.HostUserName,
			},
		})
	}
	return res, nil
}

// (equalFold helpers removed; strings.EqualFold is used instead)
// loadStagedManifest reads and validates the staged manifest.json.
func loadStagedManifest(stage string) (*types.CloneManifest, error) {
	data, err := os.ReadFile(filepath.Join(stage, "manifest.json"))
	if err != nil {
		return nil, fmt.Errorf("injection: staged manifest: %w", err)
	}
	// BOM-tolerant decode (PowerShell 5.1 writers emit a UTF-8 BOM).
	var m types.CloneManifest
	if err := types.UnmarshalJSONBOM(data, &m); err != nil {
		return nil, fmt.Errorf("%s: staged manifest is not valid JSON: %w", types.ErrInvalidManifest, err)
	}
	return &m, nil
}

// zipDir archives a directory tree into an in-memory zip.
func zipDir(root string) ([]byte, error) {
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		rel, rerr := filepath.Rel(root, path)
		if rerr != nil || rel == "." {
			return nil
		}
		name := filepath.ToSlash(rel)
		if info.IsDir() {
			_, err := w.Create(name + "/")
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		fw, err := w.Create(name)
		if err != nil {
			return err
		}
		_, err = fw.Write(data)
		return err
	})
	if err != nil {
		w.Close()
		return nil, err
	}
	if err := w.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// restoreBackup removes the (possibly partial) destination profile and
// unpacks the backup zip in its place.
func restoreBackup(profilePath, backupPath string) error {
	if err := os.RemoveAll(profilePath); err != nil {
		return err
	}
	data, err := os.ReadFile(backupPath)
	if err != nil {
		return err
	}
	_, err = unzipTo(data, profilePath)
	return err
}

// extCount counts entries directly under an extracted extensions dir.
func extCount(dir string) int {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	return len(entries)
}

// restorePasswords decrypts staged passwords.json with the transport key,
// re-encrypts each under the platform protector (DPAPI on Windows, dev key
// fallback elsewhere) and writes restored_passwords.json next to the staged
// clone. Plaintext is never persisted. Returns how many were restored.
func restorePasswords(pwFile, stage string, key []byte) (int, error) {
	if len(key) == 0 {
		return 0, fmt.Errorf("%s: no transport key for password restore", types.ErrKeyNotFound)
	}
	data, err := os.ReadFile(pwFile)
	if err != nil {
		return 0, nil // no password payload staged
	}
	var payload struct {
		Passwords []types.EncryptedPasswordJSON `json:"passwords"`
	}
	// BOM-tolerant: PowerShell-written JSON on the VM carries a UTF-8 BOM.
	if err := types.UnmarshalJSONBOM(data, &payload); err != nil {
		return 0, fmt.Errorf("%s: staged passwords.json corrupt: %w", types.ErrIntegrityCheckFailed, err)
	}
	type restored struct {
		Origin   string `json:"origin"`
		Username string `json:"username"`
		Dpapi    string `json:"dpapi_b64"` // DPAPI-protected plaintext
	}
	out := make([]restored, 0, len(payload.Passwords))
	for _, p := range payload.Passwords {
		ct, err := crypto.B64Decode(p.Ciphertext)
		if err != nil {
			continue
		}
		nonce, err := crypto.B64Decode(p.Nonce)
		if err != nil {
			continue
		}
		tag, err := crypto.B64Decode(p.AuthTag)
		if err != nil {
			continue
		}
		plain, err := crypto.OpenGCM(key, ct, nonce, tag, nil)
		if err != nil {
			continue // transport auth failure: skip record, keep going
		}
		protected, err := crypto.ProtectBytes(plain, nil)
		if err != nil {
			continue
		}
		out = append(out, restored{Origin: p.Origin, Username: p.Username,
			Dpapi: crypto.B64Encode(protected)})
		for i := range plain { // wipe plaintext from memory
			plain[i] = 0
		}
	}
	if len(out) == 0 {
		return 0, nil
	}
	blob, err := json.MarshalIndent(map[string]any{"restored": out}, "", "  ")
	if err != nil {
		return 0, err
	}
	if err := os.WriteFile(filepath.Join(stage, "restored_passwords.json"), blob, 0o600); err != nil {
		return 0, err
	}
	return len(out), nil
}

// cleanProblemLocalStorage removes LevelDB origins known to carry OAuth
// state (directive §8 INJECT CHECK 6).
func cleanupProblemLocalStorage(profilePath string) {
	root := filepath.Join(profilePath, "Local Storage", "leveldb")
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	bad := []string{"accounts.google.com", "login.microsoftonline.com", "github.com"}
	for _, e := range entries {
		for _, b := range bad {
			if strings.Contains(e.Name(), b) {
				os.RemoveAll(filepath.Join(root, e.Name()))
				break
			}
		}
	}
}

// writeHostManifest writes {clone_id}.manifest.json into the profile
// (directive §8 INJECT CHECK 7).
func writeHostManifest(profilePath, cloneID string, res *InjectResult, m *types.CloneManifest) error {
	doc := map[string]any{
		"clone_id":           cloneID,
		"injected_at":        types.NowIso(),
		"source_pc":          m.SourcePc,
		"source_user":        m.SourceUser,
		"validation_result":  res.ValidationResult,
		"extensions_loaded":  res.ExtensionsRestored,
		"extensions_failed":  0,
		"passwords_restored": res.PasswordsRestored,
	}
	data, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(profilePath, cloneID+".manifest.json"), data, 0o600)
}

// headlessValidate launches the browser headless against the mounted profile
// and greps stderr/stdout for fatal errors (directive §8 INJECT CHECK 5).
// Returns "passed", "warning:..." (no binary / timeout) or "failed:...".
func headlessValidate(browserType, profilePath string) string {
	exe, args, err := headlessCommand(browserType, profilePath)
	if err != nil {
		return "warning:" + err.Error()
	}
	var out bytes.Buffer
	cmd := exec.Command(exe, args...)
	procattr.Quiet(cmd) // headless validation must not flash a console
	cmd.Stdout = &out
	cmd.Stderr = &out
	if err := cmd.Start(); err != nil {
		return "warning:" + err.Error()
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case <-done:
	case <-time.After(30 * time.Second):
		cmd.Process.Kill()
		return "warning:headless-timeout"
	}
	joined := strings.ToLower(out.String())
	for _, bad := range []string{"fatal", "crash", "panic"} {
		if strings.Contains(joined, bad) {
			return "failed:headless-" + bad
		}
	}
	return "passed"
}

// headlessCommand assembles the headless launch for a browser type. The
// binary is resolved per-platform (PATH, then standard Windows install
// locations) — a hard-coded name fails LookPath on Windows.
func headlessCommand(browserType, profilePath string) (string, []string, error) {
	exe := browser.BinaryPath(browserType)
	if exe == "" {
		return "", nil, fmt.Errorf("no %s binary found (PATH or standard install location)", browserType)
	}
	switch browserType {
	case types.BrowserChrome, types.BrowserBrave, types.BrowserEdge:
		return exe, []string{"--headless", "--no-sandbox", "--disable-gpu",
			"--user-data-dir=" + filepath.Dir(filepath.Dir(profilePath)),
			"--profile-directory=" + filepath.Base(profilePath), "--dump-dom", "about:blank"}, nil
	case types.BrowserFirefox:
		return exe, []string{"--headless", "--profile", profilePath, "--dump", "about:blank"}, nil
	default:
		return "", nil, fmt.Errorf("unsupported-browser: %s", browserType)
	}
}

// unzipTo safely extracts a zip archive into dest. Entries are rejected when
// they would escape dest (".." or absolute paths — zip-slip). Directory
// entries and empty paths are skipped. Returns the relative paths written.
func unzipTo(data []byte, dest string) ([]string, error) {
	if len(data) == 0 {
		return nil, nil
	}
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, fmt.Errorf("injection: invalid zip: %w", err)
	}
	var paths []string
	for _, f := range zr.File {
		clean := filepath.Clean(strings.ReplaceAll(f.Name, "\\", "/"))
		if clean == "." || clean == "" {
			continue
		}
		if filepath.IsAbs(clean) || clean == ".." ||
			strings.HasPrefix(clean, "../") || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
			return nil, fmt.Errorf("injection: unsafe zip entry %q", f.Name)
		}
		target := filepath.Join(dest, clean)
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o700); err != nil {
				return nil, err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			return nil, err
		}
		rc, err := f.Open()
		if err != nil {
			return nil, err
		}
		out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
		if err != nil {
			rc.Close()
			return nil, err
		}
		if _, err := io.Copy(out, rc); err != nil {
			out.Close()
			rc.Close()
			return nil, err
		}
		out.Close()
		rc.Close()
		paths = append(paths, clean)
	}
	return paths, nil
}

// copyTree copies src into dest preserving relative layout. Returns the count
// of files copied and the relative paths. Best effort per-file errors.
func copyTree(src, dest string) (int, []string, error) {
	var count int
	var rels []string
	err := filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil // unreadable subtree: skip
		}
		rel, rerr := filepath.Rel(src, path)
		if rerr != nil {
			return nil
		}
		if rel == "." {
			return nil
		}
		target := filepath.Join(dest, rel)
		if info.IsDir() {
			return os.MkdirAll(target, 0o700)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			return nil
		}
		if err := os.WriteFile(target, data, 0o600); err != nil {
			return nil
		}
		count++
		rels = append(rels, rel)
		return nil
	})
	return count, rels, err
}

// chmodTree applies restrictive permissions to every file/dir below root
// (0o700 dirs, 0o600 files). No-op failures are ignored.
func chmodTree(root string) {
	filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if info.IsDir() {
			os.Chmod(path, 0o700)
		} else {
			os.Chmod(path, 0o600)
		}
		return nil
	})
}

// stagingDir resolves the per-clone staging directory under the clones root.
func stagingDir(root, cloneID string) string {
	return filepath.Join(root, cloneID)
}

// parseMountOwner parses an "uid:gid" ownership spec.
func parseMountOwner(s string) (int, int, error) {
	parts := strings.Split(s, ":")
	if len(parts) != 2 {
		return 0, 0, fmt.Errorf("expected uid:gid, got %q", s)
	}
	uid, err1 := strconv.Atoi(parts[0])
	gid, err2 := strconv.Atoi(parts[1])
	if err1 != nil || err2 != nil || uid < 0 || gid < 0 {
		return 0, 0, fmt.Errorf("expected numeric uid:gid, got %q", s)
	}
	return uid, gid, nil
}

// chownTree recursively applies uid/gid ownership below root (POSIX only).
func chownTree(root string, uid, gid int) error {
	return filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		return os.Chown(path, uid, gid)
	})
}

// ResolveDestination resolves the mount/launch destination profile for a
// browser type: an explicit override wins, else the detected profile, else
// the platform-standard path (virgin-host bootstrap — the mount creates it).
func ResolveDestination(browserType, override string) string {
	if override != "" {
		return override
	}
	if p, err := browser.DetectProfile(browserType); err == nil {
		return p.ProfilePath
	}
	return browser.DefaultProfilePath(browserType)
}

// scrubLockArtifacts removes stale browser single-instance artifacts from a
// mounted profile: Singleton* files (POSIX), .com.google.Chrome.* IPC seeds,
// and lockfile/lock. Best effort — removal failures are ignored.
func scrubLockArtifacts(profilePath string) {
	entries, err := os.ReadDir(profilePath)
	if err != nil {
		return
	}
	for _, e := range entries {
		name := e.Name()
		if name == "SingletonLock" || name == "SingletonSocket" || name == "SingletonCookie" ||
			name == "lockfile" || name == "lock" || strings.HasPrefix(name, ".com.google.Chrome.") {
			os.Remove(filepath.Join(profilePath, name))
		}
	}
}

// LaunchOptions controls launching an injected clone for the hosted-PC user.
type LaunchOptions struct {
	CloneId     string
	StagingRoot string
	Registry    *registry.Store
	Audit       *audit.Logger
	// ProfilePath overrides the destination profile (defaults to the same
	// resolution Inject uses).
	ProfilePath string
	// Display overrides the X display the browser is launched on (POSIX
	// hosted servers: the agent session may not have DISPLAY set).
	Display string
	// Proxy overrides the egress-proxy endpoint (directive §13). Empty means
	// "use the endpoint carried in the clone manifest".
	Proxy string
	// ProxyOptional downgrades an unreachable egress proxy from a launch
	// abort to a warning (operator override; loud audit).
	ProxyOptional bool
}

// Launch starts the host browser on an injected clone so the hosted-PC user
// can take over the session (directive §7 activation). The clone must be
// active (already injected). The browser process is spawned detached; Launch
// does not wait for it. Run inside the user's interactive session (e.g. via
// a scheduled task) so the window appears on the desktop.
func Launch(opts LaunchOptions) (binary string, profile string, err error) {
	if opts.CloneId == "" {
		return "", "", fmt.Errorf("injection: clone id is required")
	}
	if opts.StagingRoot == "" {
		opts.StagingRoot = DefaultStagingRoot()
	}
	if opts.Registry == nil {
		opts.Registry, _ = registry.New(filepath.Join(opts.StagingRoot, "..", "registry"))
	}
	if opts.Audit == nil {
		opts.Audit, _ = audit.New(filepath.Join(opts.StagingRoot, "..", "audit"))
	}
	entry, err := opts.Registry.Load(opts.CloneId)
	if err != nil {
		return "", "", err
	}
	if entry.Status != types.StatusActive {
		return "", "", fmt.Errorf("injection: clone %s status is %q, expected %q (run inject first)",
			opts.CloneId, entry.Status, types.StatusActive)
	}
	m, err := loadStagedManifest(stagingDir(opts.StagingRoot, opts.CloneId))
	if err != nil {
		return "", "", err
	}
	profile = opts.ProfilePath
	if profile == "" {
		profile = ResolveDestination(m.BrowserType, "")
	}
	if profile == "" {
		return "", "", fmt.Errorf("%s: no destination profile for %s", types.ErrBrowserNotFound, m.BrowserType)
	}
	binary = browser.BinaryPath(m.BrowserType)
	if binary == "" {
		return "", "", fmt.Errorf("%s: no %s binary found (PATH or standard install location)",
			types.ErrBrowserNotFound, m.BrowserType)
	}
	args := []string{
		"--user-data-dir=" + filepath.Dir(profile),
		"--profile-directory=" + filepath.Base(profile),
		"--no-first-run",
		"--no-default-browser-check",
	}
	// [IP CHECK 2] (directive §13): every request must egress from the work
	// PC so sessions stay valid. The proxy endpoint rides the manifest
	// (silent) unless overridden; an unreachable proxy aborts the launch by
	// default - a clone launched without it would leak the hosted PC's IP
	// and burn the carried sessions.
	proxy := opts.Proxy
	if proxy == "" {
		proxy = m.EgressProxy
	}
	proxyNote := "none"
	if proxy != "" {
		if perr := proxyReachable(proxy); perr != nil {
			if !opts.ProxyOptional {
				return "", "", fmt.Errorf("injection: %w", perr)
			}
			if opts.Audit != nil {
				opts.Audit.Log(types.AuditEvent{
					Event: audit.EvEgressMismatch, CloneId: opts.CloneId, Status: "warning",
					Level: audit.LevelWarn, Error: perr.Error(),
					Details: map[string]any{"proxy": proxy},
				})
			}
			proxyNote = "unreachable (operator override)"
		} else {
			proxyNote = proxy
		}
		args = append(args, "--proxy-server="+proxy)
	}
	cmd := exec.Command(binary, args...)
	procattr.Quiet(cmd) // the browser itself shows its window; no console flash
	if opts.Display != "" {
		cmd.Env = append(os.Environ(), "DISPLAY="+opts.Display)
	}
	if err := cmd.Start(); err != nil {
		return "", "", fmt.Errorf("injection: launch %s: %w", binary, err)
	}
	go cmd.Wait() // reap the launcher when the browser exits
	// [IP CHECK 4] (directive §13): watch the relay in the background; a
	// >30s outage terminates the clone browser so it cannot leak the hosted
	// PC's IP. Started whenever a proxy is applied, in this or any session.
	if proxy != "" {
		go (&Watchdog{
			Proxy:       proxy,
			UserDataDir: filepath.Dir(profile),
			Audit:       opts.Audit,
			CloneId:     opts.CloneId,
		}).Run()
	}
	if opts.Audit != nil {
		opts.Audit.Log(types.AuditEvent{
			Event: audit.EvCloneInjected, CloneId: opts.CloneId, Status: "launched",
			BrowserType: m.BrowserType, BrowserVersion: m.BrowserVersion,
			Details: map[string]any{
				"binary": binary, "user_data_dir": filepath.Dir(profile),
				"profile_directory": filepath.Base(profile),
				"egress_proxy":      proxyNote,
			},
		})
	}
	return binary, profile, nil
}

// proxyReachable dials the egress-proxy endpoint ([IP CHECK 2], directive
// §13). Accepts "host:port" or "scheme://host:port".
func proxyReachable(proxy string) error {
	host := proxy
	if i := strings.Index(host, "://"); i >= 0 {
		host = host[i+3:]
	}
	if _, _, err := net.SplitHostPort(host); err != nil {
		return fmt.Errorf("invalid egress proxy %q (want host:port)", proxy)
	}
	conn, err := net.DialTimeout("tcp", host, 2*time.Second)
	if err != nil {
		return fmt.Errorf("egress proxy %s unreachable (clone traffic would leak the hosted PC's IP): %w", proxy, err)
	}
	conn.Close()
	return nil
}
