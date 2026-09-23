//go:build windows

package procattr

import (
	"os/exec"
	"syscall"
)

// CREATE_NO_WINDOW: the child gets no console window (and inherits none).
const createNoWindow = 0x08000000

func quiet(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: createNoWindow,
	}
}
