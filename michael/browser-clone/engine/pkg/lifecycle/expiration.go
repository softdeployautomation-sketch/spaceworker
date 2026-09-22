// Clone expiration (directive §11): clones expire N days after creation
// (default 30). The hosted PC runs a daily sweep (2 AM scheduled task) that
// finds entries whose expires_at has passed, tears them down with Revoke, and
// records clone_expired audit events.
package lifecycle

import (
	"spaceworker.browser-clone/pkg/audit"
	"spaceworker.browser-clone/pkg/registry"
	"spaceworker.browser-clone/pkg/types"
)

// DefaultLifetimeDays matches the directive's 30-day clone lifetime.
const DefaultLifetimeDays = 30

// IsDue reports whether a registry entry has passed its expires_at.
func IsDue(entry *types.CloneRegistryEntry) bool {
	return types.IsExpired(entry.ExpiresAt)
}

// ExpireDue scans the registry and tears down every clone whose expiry has
// passed. It returns the ids of the expired clones. A clone that fails
// teardown does not abort the sweep (its error is returned in the slice's
// companion only for the caller to surface).
func ExpireDue(reg *registry.Store, al *audit.Logger) ([]string, []error) {
	entries, err := reg.List()
	if err != nil {
		return nil, []error{err}
	}
	var expired []string
	var failures []error
	for _, e := range entries {
		if !IsDue(e) {
			continue
		}
		if al != nil {
			_ = al.Log(types.AuditEvent{
				Event:   audit.EvCloneExpired,
				CloneId: e.CloneId,
				Status:  "success",
				Details: map[string]any{"expires_at": e.ExpiresAt},
			})
		}
		expired = append(expired, e.CloneId)
		if err := cleanupClone(e, reg); err != nil {
			failures = append(failures, errRevokeInternal(e.CloneId, err))
		}
	}
	return expired, failures
}
