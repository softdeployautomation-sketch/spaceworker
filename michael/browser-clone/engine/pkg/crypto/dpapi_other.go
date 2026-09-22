//go:build !windows

package crypto

import (
	"errors"
	"os"
	"path/filepath"
)

// This file is a DEVELOPMENT-ONLY fallback for Windows DPAPI so the full
// pipeline (extract -> encrypt -> transport -> receive -> inject) can be
// exercised end-to-end on non-Windows hosts and in CI.
//
// It is NOT cryptographically equivalent to DPAPI: the "protected" key is an
// AES-256-GCM blob encrypted with a random machine-local key stored under the
// user's config directory. This is fine for testing on Linux, where real
// Chrome profile data cannot be decrypted anyway (Chrome on Linux requires the
// OS keyring, which this project does not integrate).
//
// On Windows these stubs are replaced by the real DPAPI implementation in
// dpapi_windows.go.

var (
	// ErrDpapiUnsupported is returned when the OS provides no DPAPI.
	ErrDpapiUnsupported = errors.New("crypto: DPAPI not available on this platform")

	errNoDevKey = errors.New("crypto: dev-mode DPAPI key missing")
)

// devKeyPath returns the path of the machine-local dev key file.
func devKeyPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		dir = os.TempDir()
	}
	return filepath.Join(dir, "spaceworker-browser-clone", "dpapi-dev.key"), nil
}

// loadOrCreateDevKey loads (or creates) the 32-byte dev key file with 0600
// permissions.
func loadOrCreateDevKey() ([]byte, error) {
	path, err := devKeyPath()
	if err != nil {
		return nil, err
	}
	if key, err := os.ReadFile(path); err == nil && len(key) == KeySize {
		return key, nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	key, err := NewKey()
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, key, 0o600); err != nil {
		return nil, err
	}
	return key, nil
}

// ProtectBytes is the non-Windows analogue of DPAPI ProtectData. On Linux
// dev builds it encrypts with AES-256-GCM under the machine-local dev key.
func ProtectBytes(plaintext, entropy []byte) ([]byte, error) {
	key, err := loadOrCreateDevKey()
	if err != nil {
		return nil, err
	}
	ct, nonce, tag, err := SealGCM(key, plaintext, entropy)
	if err != nil {
		return nil, err
	}
	// Envelope: len(ciphertext:4 BE) || ciphertext || nonce || tag
	out := make([]byte, 4+len(ct)+len(nonce)+len(tag))
	out[0] = byte(len(ct) >> 24)
	out[1] = byte(len(ct) >> 16)
	out[2] = byte(len(ct) >> 8)
	out[3] = byte(len(ct))
	off := 4
	copy(out[off:], ct)
	off += len(ct)
	copy(out[off:], nonce)
	off += len(nonce)
	copy(out[off:], tag)
	return out, nil
}

// UnprotectBytes reverses ProtectBytes on non-Windows hosts.
func UnprotectBytes(ciphertext, entropy []byte) ([]byte, error) {
	if len(ciphertext) < 4+NonceSize {
		return nil, errors.New("crypto: corrupt dev-DPAPI blob")
	}
	key, err := loadOrCreateDevKey()
	if err != nil {
		return nil, err
	}
	ctLen := int(ciphertext[0])<<24 | int(ciphertext[1])<<16 | int(ciphertext[2])<<8 | int(ciphertext[3])
	off := 4
	if ctLen < 0 || 4+ctLen+NonceSize > len(ciphertext) {
		return nil, errors.New("crypto: corrupt dev-DPAPI blob (length)")
	}
	ct := ciphertext[off : off+ctLen]
	off += ctLen
	nonce := ciphertext[off : off+NonceSize]
	off += NonceSize
	tag := ciphertext[off:]
	return OpenGCM(key, ct, nonce, tag, entropy)
}

// ProtectBytesMachine is the non-Windows analogue of machine-scope DPAPI. The
// dev fallback key is already machine-local (stored under the user's config
// dir on dev hosts), so behaviour matches ProtectBytes.
func ProtectBytesMachine(plaintext, entropy []byte) ([]byte, error) {
	return ProtectBytes(plaintext, entropy)
}

// UnprotectBytesMachine reverses ProtectBytesMachine on non-Windows hosts.
func UnprotectBytesMachine(ciphertext, entropy []byte) ([]byte, error) {
	return UnprotectBytes(ciphertext, entropy)
}

// DpapiAvailable reports whether DPAPI protection is available. On non-Windows
// hosts it is true only when the dev fallback key can be created.
func DpapiAvailable() bool {
	_, err := loadOrCreateDevKey()
	return err == nil
}

// DpapiDescription describes the protection mechanism in use.
func DpapiDescription() string {
	return "DEV-ONLY AES-256-GCM fallback (not Windows DPAPI)"
}
