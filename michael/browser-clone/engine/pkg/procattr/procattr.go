// Package procattr centralises "quiet" subprocess spawning for every
// os/exec call in the Spaceworker tooling (directive "Non-Negotiable UX
// Constraint": nothing the system runs may pop a console window, dialog or
// flash on the user's desktop). On Windows every spawned process gets
// CREATE_NO_WINDOW (0x08000000) + HideWindow so console-subsystem children
// (powershell, tasklist, taskkill, headless browsers) never open a visible
// console. On other platforms spawning is already window-free and the call
// is a no-op.
//
// Usage:
//
//	cmd := exec.Command("powershell", "-NoProfile", "-Command", ...)
//	procattr.Quiet(cmd)
package procattr

import "os/exec"

// Quiet configures cmd so it cannot open a console window on Windows.
// Call it before cmd.Start/Run for every spawned process.
func Quiet(cmd *exec.Cmd) { quiet(cmd) }
