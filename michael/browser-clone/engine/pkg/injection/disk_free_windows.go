//go:build windows

package injection

import (
	"syscall"
	"unsafe"
)

var (
	kernel32dll     = syscall.NewLazyDLL("kernel32.dll")
	procGetDiskFree = kernel32dll.NewProc("GetDiskFreeSpaceExW")
)

// diskFree returns the number of free bytes on the filesystem holding path
// (GetDiskFreeSpaceExW, available free bytes for the caller).
func diskFree(path string) (uint64, error) {
	var free, total, totalFree uint64
	r, _, err := procGetDiskFree.Call(
		uintptr(unsafe.Pointer(syscall.StringToUTF16Ptr(path))),
		uintptr(unsafe.Pointer(&free)),
		uintptr(unsafe.Pointer(&total)),
		uintptr(unsafe.Pointer(&totalFree)),
	)
	if r == 0 {
		return 0, err
	}
	return free, nil
}
