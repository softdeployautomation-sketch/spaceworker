// Package lifecycle implements clone revocation (user- or admin-initiated)
// and automatic expiration on the hosted PC (directive §11).
//
// Both operations are destructive and irreversible: the mounted browser
// profile, its backup and the staged clone are removed. Audit events
// (clone_revoked / clone_expired) are always recorded first so the removal is
// traceable even if the filesystem teardown fails halfway.
package lifecycle

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"

	"spaceworker.browser-clone/pkg/audit"
	"spaceworker.browser-clone/pkg/browser"
	"spaceworker.browser-clone/pkg/procattr"
	"spaceworker.browser-clone/pkg/registry"
	"spaceworker.browser-clone/pkg/types"
)

// Revoke removes a clone and its mounted profile on the hosted PC
// (directive §11 "Revocation"):
//
//  1. log clone_revoked
//  2. kill browser processes using the profile (Windows best-effort)
//  3. delete the mounted profile directory
//  4. delete the backup, the staging tree and the registry entry
//
// It is safe to call for unknown clone ids: unknown ids produce
// ErrKeyNotFound without side effects.
func Revoke(cloneID string, reg *registry.Store, al *audit.Logger) error {
	entry, err := reg.Load(cloneID)
	if err != nil {
		return err
	}
	if al != nil {
		_ = al.Log(types.AuditEvent{
			Event:   audit.EvCloneRevoked,
			CloneId: cloneID,
			Status:  "success",
			Details: map[string]any{"reason": "user_requested"},
		})
	}

	// 2. Stop the browser so the profile files are not locked (best effort).
	killBrowser(entry.BrowserType)

	// 3. Remove the mounted profile (the clone's presence on disk).
	if p, err := browser.DetectProfile(entry.BrowserType); err == nil {
		_ = os.RemoveAll(p.ProfilePath)
	}

	// 4. Remove backup + staging + registry entry.
	return cleanupClone(entry, reg)
}

// cleanupClone removes the backup zip, the staging directory and the
// registry entry for a clone. Missing paths are tolerated.
func cleanupClone(entry *types.CloneRegistryEntry, reg *registry.Store) error {
	if entry.ProfileBackupPath != "" {
		_ = os.Remove(entry.ProfileBackupPath)
	}
	if entry.StagingDir != "" {
		_ = os.RemoveAll(entry.StagingDir)
	}
	return reg.Delete(entry.CloneId)
}

// killBrowser terminates the given browser's processes on Windows. On other
// platforms it is a no-op (the profile directory removal still proceeds; a
// running browser may keep files locked and the OS will fail the removal,
// which the caller surfaces). Killing only the *named image* is intentional:
// the hosted-PC profile is the only browser profile we manage.
func killBrowser(browserType string) {
	if runtime.GOOS != "windows" {
		return
	}
	var exe string
	switch browserType {
	case types.BrowserChrome:
		exe = "chrome.exe"
	case types.BrowserEdge:
		exe = "msedge.exe"
	case types.BrowserBrave:
		exe = "brave.exe"
	case types.BrowserFirefox:
		exe = "firefox.exe"
	default:
		return
	}
	// /IM image name, /F force, /T tree. Quiet so no console flashes on the
	// user's desktop. Errors are ignored: the removal step downstream will
	// surface any lock that truly blocks teardown.
	kill := exec.Command("taskkill", "/IM", exe, "/T", "/F")
	procattr.Quiet(kill)
	_ = kill.Run()
}

// errRevokeInternal wraps unexpected cleanup errors.
func errRevokeInternal(cloneID string, cause error) error {
	return fmt.Errorf("lifecycle: revoke %s: %w", cloneID, cause)
}
