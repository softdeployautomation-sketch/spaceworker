// Package crypto implements directive §3 (pkg/crypto/password_handler.go):
// Chromium DPAPI password decryption + AES-256-GCM transport re-encryption.
package crypto

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"io"
)

// KeySize is the AES-256 key size in bytes.
const KeySize = 32

// NonceSize is the GCM standard nonce size (12 bytes / 96 bits).
const NonceSize = 12

// ErrAuthFailed is returned when GCM tag verification fails.
var ErrAuthFailed = errors.New("crypto: GCM authentication failed")

// NewKey returns a fresh random 32-byte AES-256 key.
func NewKey() ([]byte, error) {
	key := make([]byte, KeySize)
	if _, err := io.ReadFull(rand.Reader, key); err != nil {
		return nil, err
	}
	return key, nil
}

// NewNonce returns a fresh random 12-byte GCM nonce.
func NewNonce() ([]byte, error) {
	nonce := make([]byte, NonceSize)
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	return nonce, nil
}

// SealGCM encrypts plaintext with AES-256-GCM.
func SealGCM(key, plaintext, aad []byte) (ciphertext, nonce, authTag []byte, err error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, nil, nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, nil, nil, err
	}
	nonce = make([]byte, aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, nil, nil, err
	}
	out := aead.Seal(nil, nonce, plaintext, aad)
	tagLen := aead.Overhead()
	return out[:len(out)-tagLen], nonce, out[len(out)-tagLen:], nil
}

// OpenGCM decrypts raw ciphertext with AES-256-GCM and verifies authTag.
func OpenGCM(key, ciphertext, nonce, authTag, aad []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(nonce) != aead.NonceSize() {
		return nil, ErrAuthFailed
	}
	sealed := make([]byte, 0, len(ciphertext)+len(authTag))
	sealed = append(sealed, ciphertext...)
	sealed = append(sealed, authTag...)
	pt, err := aead.Open(nil, nonce, sealed, aad)
	if err != nil {
		return nil, ErrAuthFailed
	}
	return pt, nil
}

// SealString wraps SealGCM with base64 JSON-friendly outputs.
func SealString(key []byte, plaintext string) (ctB64, nonceB64, tagB64 string, err error) {
	ct, nonce, tag, err := SealGCM(key, []byte(plaintext), nil)
	if err != nil {
		return "", "", "", err
	}
	return base64.StdEncoding.EncodeToString(ct), base64.StdEncoding.EncodeToString(nonce), base64.StdEncoding.EncodeToString(tag), nil
}

// OpenString is the inverse of SealString.
func OpenString(key []byte, ctB64, nonceB64, tagB64 string) (string, error) {
	ct, err := base64.StdEncoding.DecodeString(ctB64)
	if err != nil {
		return "", err
	}
	nonce, err := base64.StdEncoding.DecodeString(nonceB64)
	if err != nil {
		return "", err
	}
	tag, err := base64.StdEncoding.DecodeString(tagB64)
	if err != nil {
		return "", err
	}
	pt, err := OpenGCM(key, ct, nonce, tag, nil)
	if err != nil {
		return "", err
	}
	return string(pt), nil
}

// PBKDF2SHA1 implements PBKDF2-HMAC-SHA1 (RFC 2898, Chrome "peanuts" path).
func PBKDF2SHA1(password, salt []byte, iter, dkLen int) []byte {
	prf := func(data ...[]byte) []byte {
		h := hmac.New(sha1.New, password)
		for _, d := range data {
			h.Write(d)
		}
		return h.Sum(nil)
	}
	var out []byte
	var block [4]byte
	for counter := 1; len(out) < dkLen; counter++ {
		block[0] = byte(counter >> 24)
		block[1] = byte(counter >> 16)
		block[2] = byte(counter >> 8)
		block[3] = byte(counter)
		t := prf(salt, block[:])
		um := make([]byte, len(t))
		copy(um, t)
		for i := 1; i < iter; i++ {
			u := prf(um)
			for j := 0; j < len(t); j++ {
				t[j] ^= u[j]
			}
			um = u
		}
		out = append(out, t...)
	}
	return out[:dkLen]
}

// Sha256Hex returns lowercase hex SHA-256 of data.
func Sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// HmacSha256Hex returns lowercase hex HMAC-SHA256 of data under key.
func HmacSha256Hex(key, data []byte) string {
	h := hmacNewSha256(key)
	h.Write(data)
	return hex.EncodeToString(h.Sum(nil))
}

// B64Encode base64-encodes data.
func B64Encode(data []byte) string { return base64.StdEncoding.EncodeToString(data) }

// B64Decode base64-decodes s.
func B64Decode(s string) ([]byte, error) { return base64.StdEncoding.DecodeString(s) }

// HexEncode hex-encodes data.
func HexEncode(data []byte) string { return hex.EncodeToString(data) }

// HexDecode hex-decodes s.
func HexDecode(s string) ([]byte, error) { return hex.DecodeString(s) }

func hmacNewSha256(key []byte) hash.Hash { return hmac.New(sha256.New, key) }

// ChromeSalt is the hard-coded PBKDF2 salt used by Chromium (directive §3).
var ChromeSalt = []byte("peanuts")

// ErrChromeKey is returned when a Chrome key cannot be derived.
var ErrChromeKey = errors.New("crypto: cannot derive Chrome encryption key")

// ChromeLocalState mirrors the Local State os_crypt section.
type ChromeLocalState struct {
	OsCrypt struct {
		EncryptedKey string `json:"encrypted_key"`
	} `json:"os_crypt"`
}

// ParseLocalStateKey decodes os_crypt.encrypted_key from Local State.
func ParseLocalStateKey(localStateJSON []byte) ([]byte, error) {
	var ls ChromeLocalState
	if err := json.Unmarshal(localStateJSON, &ls); err != nil {
		return nil, fmt.Errorf("%w: invalid Local State JSON: %v", ErrChromeKey, err)
	}
	if ls.OsCrypt.EncryptedKey == "" {
		return nil, fmt.Errorf("%w: os_crypt.encrypted_key missing", ErrChromeKey)
	}
	return base64.StdEncoding.DecodeString(ls.OsCrypt.EncryptedKey)
}

// ChromeKey holds the derived raw AES key.
type ChromeKey struct {
	Raw []byte
}

// DecodeChromeKey turns the Local State payload into the final AES key.
func DecodeChromeKey(payload []byte) (*ChromeKey, error) {
	switch {
	case bytes.HasPrefix(payload, []byte("DPAPI")):
		blob := payload[len("DPAPI"):]
		if len(blob) == 0 {
			return nil, fmt.Errorf("%w: empty DPAPI blob", ErrChromeKey)
		}
		raw, err := UnprotectBytes(blob, nil)
		if err != nil {
			return nil, fmt.Errorf("%w: DPAPI unprotect failed: %v", ErrChromeKey, err)
		}
		return &ChromeKey{Raw: raw}, nil
	case bytes.HasPrefix(payload, []byte("v10")):
		raw := payload[len("v10"):]
		if len(raw) == 0 {
			return nil, fmt.Errorf("%w: empty v10 key", ErrChromeKey)
		}
		return &ChromeKey{Raw: raw}, nil
	case len(payload) == 16 || len(payload) == 24 || len(payload) == 32:
		return &ChromeKey{Raw: payload}, nil
	default:
		return nil, fmt.Errorf("%w: unsupported key payload (len=%d)", ErrChromeKey, len(payload))
	}
}

// DeriveChromeKey derives the key via PBKDF2-HMAC-SHA1 (legacy keyring path).
func DeriveChromeKey(password []byte) (*ChromeKey, error) {
	if len(password) == 0 {
		return nil, fmt.Errorf("%w: empty keyring password", ErrChromeKey)
	}
	return &ChromeKey{Raw: PBKDF2SHA1([]byte("peanuts"), password, 1, 16)}, nil
}

// DecryptChromeValue decrypts a Chrome AES-CBC password/cookie blob.
func (k *ChromeKey) DecryptChromeValue(encrypted []byte, stripV10 bool) ([]byte, error) {
	block, err := aes.NewCipher(k.Raw)
	if err != nil {
		return nil, err
	}
	data := encrypted
	if stripV10 {
		if !bytes.HasPrefix(data, []byte("v10")) || len(data) < 3+16+16 {
			return nil, ErrAuthFailed
		}
		data = data[3:]
	}
	if len(data) < 16+16 || len(data[16:])%16 != 0 {
		return nil, ErrAuthFailed
	}
	dec := cipher.NewCBCDecrypter(block, data[:16])
	out := make([]byte, len(data)-16)
	dec.CryptBlocks(out, data[16:])
	return pkcs7Unpad(out), nil
}

// Hash returns lowercase hex SHA-256 of the raw key.
func (k *ChromeKey) Hash() string { return Sha256Hex(k.Raw) }

func pkcs7Unpad(b []byte) []byte {
	if len(b) == 0 {
		return b
	}
	n := int(b[len(b)-1])
	if n <= 0 || n > aes.BlockSize || n > len(b) {
		return b
	}
	return b[:len(b)-n]
}
