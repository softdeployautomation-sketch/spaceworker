//go:build !windows

package procattr

import "os/exec"

// quiet is a no-op off Windows: POSIX children never open console windows.
func quiet(cmd *exec.Cmd) {}
