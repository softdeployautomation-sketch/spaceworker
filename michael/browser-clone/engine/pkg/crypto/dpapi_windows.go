//go:build windows

package crypto

import (
	"fmt"
	"syscall"
	"unsafe"
)

// This file implements Windows DPAPI via crypt32.dll using the stdlib syscall
// package only (no cgo, no external dependencies), so it cross-compiles to
// Windows from any host. It is compiled only for GOOS=windows builds.

type dataBlob struct {
	cbData uint32
	pbData *byte
}

var (
	crypt32dll       = syscall.NewLazyDLL("crypt32.dll")
	kernel32dll      = syscall.NewLazyDLL("kernel32.dll")
	procCryptProtect = crypt32dll.NewProc("CryptProtectData")
	procCryptUnprot  = crypt32dll.NewProc("CryptUnprotectData")
	procLocalFree    = kernel32dll.NewProc("LocalFree")
)

func blobToBytes(b *dataBlob) []byte {
	if b == nil || b.pbData == nil || b.cbData == 0 {
		return nil
	}
	// Copy out of the DPAPI-allocated buffer immediately: the caller frees the
	// buffer with LocalFree right after this, and returning a slice aliasing
	// freed memory corrupts the blob (observed as "The data is invalid" from
	// CryptUnprotectData on blobs re-read from the registry).
	out := make([]byte, int(b.cbData))
	copy(out, unsafe.Slice(b.pbData, int(b.cbData)))
	return out
}

func freeBlob(b *dataBlob) {
	if b != nil && b.pbData != nil {
		procLocalFree.Call(uintptr(unsafe.Pointer(b.pbData)))
		b.pbData = nil
		b.cbData = 0
	}
}

// dwFlags for CryptProtectData / CryptUnprotectData.
const (
	dwUIForbidden  uintptr = 0x1 // CRYPTPROTECT_UI_FORBIDDEN
	dwLocalMachine uintptr = 0x4 // CRYPTPROTECT_LOCAL_MACHINE
)

// protectData calls CryptProtectData with the given optional entropy and
// dwFlags (CRYPTPROTECT_UI_FORBIDDEN, optionally CRYPTPROTECT_LOCAL_MACHINE).
func protectData(data, entropy []byte, flags uintptr) ([]byte, error) {
	var in, ent, out dataBlob
	if len(data) > 0 {
		in.cbData = uint32(len(data))
		in.pbData = &data[0]
	}
	if len(entropy) > 0 {
		ent.cbData = uint32(len(entropy))
		ent.pbData = &entropy[0]
	}
	r, _, err := procCryptProtect.Call(
		uintptr(unsafe.Pointer(&in)),
		0, // szDataDescr
		uintptr(unsafe.Pointer(&ent)),
		0, // pvReserved
		0, // pPromptStruct
		flags,
		uintptr(unsafe.Pointer(&out)),
	)
	if r == 0 {
		return nil, fmt.Errorf("CryptProtectData failed: %v", err)
	}
	result := blobToBytes(&out)
	freeBlob(&out)
	return result, nil
}

// unprotectData calls CryptUnprotectData with the given optional entropy and
// dwFlags. The blob itself encodes user vs machine scope, so unprotect only
// ever needs UI_FORBIDDEN.
func unprotectData(data, entropy []byte, flags uintptr) ([]byte, error) {
	var in, ent, out dataBlob
	if len(data) > 0 {
		in.cbData = uint32(len(data))
		in.pbData = &data[0]
	}
	if len(entropy) > 0 {
		ent.cbData = uint32(len(entropy))
		ent.pbData = &entropy[0]
	}
	r, _, err := procCryptUnprot.Call(
		uintptr(unsafe.Pointer(&in)),
		0, // ppszDataDescr (optional)
		uintptr(unsafe.Pointer(&ent)),
		0, // pvReserved
		0, // pPromptStruct
		flags,
		uintptr(unsafe.Pointer(&out)),
	)
	if r == 0 {
		return nil, fmt.Errorf("CryptUnprotectData failed: %v", err)
	}
	result := blobToBytes(&out)
	freeBlob(&out)
	return result, nil
}

// ProtectBytes encrypts plaintext with Windows DPAPI (current-user scope).
// Used to decrypt Chrome "DPAPI"-prefixed key blobs and anything that must
// stay bound to the logged-in user's profile.
func ProtectBytes(plaintext, entropy []byte) ([]byte, error) {
	return protectData(plaintext, entropy, dwUIForbidden)
}

// UnprotectBytes decrypts a Windows DPAPI blob produced by ProtectBytes.
func UnprotectBytes(ciphertext, entropy []byte) ([]byte, error) {
	return unprotectData(ciphertext, entropy, dwUIForbidden)
}

// ProtectBytesMachine encrypts plaintext with Windows DPAPI at LOCAL_MACHINE
// scope: any session on the same machine can unprotect it. The clone registry
// uses this for the transport key at rest (directive §3/§10), because the key
// is minted in one logon session (e.g. an RMM agent run) and consumed by the
// receiver service in another - a user-scope blob cannot cross that boundary.
func ProtectBytesMachine(plaintext, entropy []byte) ([]byte, error) {
	return protectData(plaintext, entropy, dwUIForbidden|dwLocalMachine)
}

// UnprotectBytesMachine decrypts a machine-scope DPAPI blob produced by
// ProtectBytesMachine.
func UnprotectBytesMachine(ciphertext, entropy []byte) ([]byte, error) {
	return unprotectData(ciphertext, entropy, dwUIForbidden)
}

// DpapiAvailable always returns true on Windows.
func DpapiAvailable() bool {
	return true
}

// DpapiDescription describes the protection mechanism in use.
func DpapiDescription() string {
	return "Windows DPAPI (user + machine scope)"
}
