// Package types defines the shared data types, error codes, and small
// helpers used across the Spaceworker Browser Clone system (CLI, native
// host, extractor, bundler, transport, injection, lifecycle, audit).
//
// Field names follow the JSON schema in SPACEWORKER_BROWSER_CLONE_DIRECTIVE.md
// (snake_case) so structs marshal/unmarshal to/from JSON with the standard
// library's encoding/json package without per-field tuning.
package types

import (
	"crypto/rand"
	"encoding/hex"
	"strconv"
	"strings"
	"time"
)

// ---------------------------------------------------------------------------
// Browser types
// ---------------------------------------------------------------------------

const (
	BrowserChrome  = "chrome"
	BrowserEdge    = "edge"
	BrowserFirefox = "firefox"
	BrowserBrave   = "brave"
)

// IsBrowserType reports whether t is one of the supported browser types.
func IsBrowserType(t string) bool {
	return t == BrowserChrome || t == BrowserEdge || t == BrowserFirefox || t == BrowserBrave
}

// A BrowserProfile describes a detected browser installation and its profile.
//
//	Type        chrome | edge | firefox | brave
//	Version     e.g. "130.0.1.1" or "unknown"
//	DataPath    the "User Data" (Chromium) or profiles root (Firefox) dir
//	ProfilePath the specific profile directory to extract
//	IsRunning   whether the browser process is currently running
type BrowserProfile struct {
	Type        string
	Version     string
	DataPath    string
	ProfilePath string
	IsRunning   bool
}

// ---------------------------------------------------------------------------
// Error codes (see directive "Error Codes & Return Values" table)
// ---------------------------------------------------------------------------

const (
	ErrBrowserNotFound         = "ErrBrowserNotFound"
	ErrProfileLocked           = "ErrProfileLocked"
	ErrProfileTooLarge         = "ErrProfileTooLarge"
	ErrMeshUnavailable         = "ErrMeshUnavailable"
	ErrBrowserTypeMismatch     = "ErrBrowserTypeMismatch"
	ErrBrowserVersionMismatch  = "ErrBrowserVersionMismatch"
	ErrBrowserMismatch         = "ErrBrowserMismatch"
	ErrSignatureMismatch       = "ErrSignatureMismatch"
	ErrIntegrityCheckFailed    = "ErrIntegrityCheckFailed"
	ErrProfileValidationFailed = "ErrProfileValidationFailed"
	ErrUserMismatch            = "ErrUserMismatch"
	ErrCloneExpired            = "ErrCloneExpired"
	ErrInsufficientStorage     = "ErrInsufficientStorage"
	ErrDPAPIDecryptFailed      = "ErrDPAPIDecryptFailed"
	ErrKeyNotFound             = "ErrKeyNotFound"
	ErrKeyExchangeFailed       = "ErrKeyExchangeFailed"
	ErrStorageQuotaExceeded    = "ErrStorageQuotaExceeded"
	ErrTooManyFiles            = "ErrTooManyFiles"
	ErrFailedToReadFile        = "ErrFailedToReadFile"
	ErrInvalidManifest         = "ErrInvalidManifest"
	ErrAgentUnavailable        = "ErrAgentUnavailable"
	ErrNotSupported            = "ErrNotSupported"
	ErrOutputFailed            = "ErrOutputFailed"
)

// ---------------------------------------------------------------------------
// Clone lifecycle status values
// ---------------------------------------------------------------------------

const (
	StatusStarted           = "started"
	StatusReadyForTransfer  = "ready-for-transfer"
	StatusTransferring      = "transferring"
	StatusReadyForInjection = "ready-for-injection"
	StatusInjecting         = "injecting"
	StatusActive            = "active"
	StatusRevoked           = "revoked"
	StatusExpired           = "expired"
	StatusFailed            = "failed"
)

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

// PasswordEntry is a decrypted saved login. The plaintext password exists only
// in memory on the work PC (see directive §3).
type PasswordEntry struct {
	Origin        string
	Username      string
	EncryptedPass []byte `json:"-"`
	UsernameField string
	PasswordField string
}

// EncryptedPassword is a password re-encrypted for transport with the
// AES-256-GCM transport key (directive §3).
type EncryptedPassword struct {
	Origin     string
	Username   string
	Ciphertext []byte `json:"-"`
	Nonce      []byte `json:"-"`
	AuthTag    []byte `json:"-"`
}

// EncryptedPasswordJSON is the on-disk representation (base64 fields).
type EncryptedPasswordJSON struct {
	Origin     string
	Username   string
	Ciphertext string
	Nonce      string
	AuthTag    string
}

// ---------------------------------------------------------------------------
// Extensions
// ---------------------------------------------------------------------------

// ExtensionInfo describes one installed browser extension.
//
//	Type  "web-store" | "crx" | "directory" | "xpi"
type ExtensionInfo struct {
	ID          string
	Version     string
	Name        string
	Type        string
	Path        string
	Hash        string
	Permissions []string
	Manifest    []byte `json:"-"`
}

// ---------------------------------------------------------------------------
// Clone metadata / bundled profile
// ---------------------------------------------------------------------------

type CloneMetadata struct {
	CloneId          string
	SourcePc         string
	SourceUser       string
	SourceUserSid    string
	BrowserType      string
	BrowserVersion   string
	CreatedAt        string
	ExpiresAt        string
	IncludePasswords bool
	// EgressProxy is "host:port" of the work-PC egress proxy (directive §13).
	// All hosted-clone browser traffic is silently relayed through the work
	// PC so the clone browses with the work PC's public IP and sessions
	// stay valid. Empty = proxy not deployed.
	EgressProxy string
}

// ProfileBundle is the in-memory extracted profile (directive §2).
type ProfileBundle struct {
	Metadata           CloneMetadata
	ProfileFiles       map[string][]byte
	Passwords          []PasswordEntry
	EncryptedPasswords []EncryptedPassword
	Extensions         []ExtensionInfo
	LocalStorage       map[string]string
	SessionStorage     map[string]string
	FilePath           string // absolute path of the bundle root on disk (if any)
}

// ManifestFile is one entry of manifest.json's files[] array.
type ManifestFile struct {
	Path   string
	Size   int
	Sha256 string
}

type ManifestExtension struct {
	ID      string
	Version string
	Type    string
	Name    string
	Hash    string
}

// CloneManifest mirrors manifest.json (directive §5).
type CloneManifest struct {
	CloneId               string
	SourcePc              string
	SourceUser            string
	SourceUserSid         string
	BrowserType           string
	BrowserVersion        string
	CreatedAt             string
	ExpiresAt             string
	EgressProxy           string              `json:"egress_proxy,omitempty"`
	FileCount             int                 `json:"total_files"`
	TotalSizeBytes        int64               `json:"total_size_bytes"`
	Files                 []ManifestFile      `json:"files"`
	PasswordCount         int                 `json:"password_count"`
	PasswordsEncrypted    bool                `json:"passwords_encrypted"`
	TransportKeyHash      string              `json:"transport_key_hash"`
	Extensions            []ManifestExtension `json:"extensions"`
	WebStoreCount         int                 `json:"web_store_count"`
	SideLoadedCount       int                 `json:"side_loaded_count"`
	LocalStorageEntries   int                 `json:"localstorage_entries"`
	SessionStorageEntries int                 `json:"session_storage_entries"`
	SessionValidityDays   int                 `json:"session_validity_days"`
	ProfileZipSha256      string              `json:"profile_zip_sha256"`
	ExtensionsZipSha256   string              `json:"extensions_zip_sha256"`
	SignatureMethod       string              `json:"signature_method"`
	Signature             string              `json:"signature"`
	Validation            string              `json:"validation"`
}

// ---------------------------------------------------------------------------
// Clone registry (local, per-PC)
// ---------------------------------------------------------------------------

// CloneRegistryEntry tracks a clone on the work PC or the hosted PC.
type CloneRegistryEntry struct {
	CloneId           string
	SourceWorkPc      string
	TargetHostedPcId  string
	BrowserType       string
	BrowserVersion    string
	Status            string
	CreatedAt         string
	ExpiresAt         string
	ReceivedAt        string
	InjectedAt        string
	HostUserSid       string
	ValidationResult  string
	ProfileBackupPath string
	StagingDir        string
	ExtensionsCount   int
	PasswordsCount    int
	TransportKeyB64   string // DPAPI-protected (Windows) or dev-fallback
	TransportKey      []byte `json:"-"`
	// EgressProxy is the work-PC relay endpoint (directive §13); the hosted
	// clone browses through it so sessions stay bound to the work PC's IP.
	EgressProxy string
}

// ---------------------------------------------------------------------------
// Audit events
// ---------------------------------------------------------------------------

// AuditEvent is one line of the JSON audit log (directive §12).
type AuditEvent struct {
	Event          string
	CloneId        string
	SourcePc       string
	TargetPc       string
	User           string
	UserSid        string
	BrowserType    string
	BrowserVersion string
	Status         string
	Error          string
	Timestamp      string
	Details        map[string]any
	Level          string // INFO | ERROR
}

// ---------------------------------------------------------------------------
// Live session capture (TASK_119B / B9-B) — the FROZEN wire shapes
// ---------------------------------------------------------------------------
//
// The extension reads the user's cookies INSIDE the browser process
// (chrome.cookies.getAll; App-Bound Encryption makes every out-of-process
// route dead — TASK_117 F10/F11/F12), chunks them into native messages and
// hands them to this native host, which accumulates the chunks in memory and
// makes ONE POST to POST /api/devices/clone-capture. Both shapes below are
// frozen: Path A (the server route) is written against them, so they must not
// be changed unilaterally.

// Cookie is one browser cookie in the contract shape.
//
// WARNING: Value is a live credential. It may exist only in (a) the native
// message that carries it, (b) the POST body, and (c) a 0600 temp file during
// a harness run. It must NEVER be logged, echoed in an error, audited or
// persisted anywhere else.
type Cookie struct {
	Name     string `json:"name"`
	Value    string `json:"value"`
	Domain   string `json:"domain"`
	Path     string `json:"path"`
	Secure   bool   `json:"secure"`
	HTTPOnly bool   `json:"httpOnly"`
	// SameSite is passed through verbatim from Chrome, including the values
	// Chrome itself uses ("unspecified", "no_restriction", "lax", "strict") —
	// never normalised, never invented.
	SameSite string `json:"sameSite"`
	// ExpirationDate is Unix seconds, absent for session cookies.
	ExpirationDate float64 `json:"expirationDate,omitempty"`
}

// CaptureChunk is ONE extension → native-host native message. Native
// messaging frames every message with a 4-byte little-endian length and caps a
// message at 1 MiB, so a real profile arrives as several of these:
//
//	{ "command": "capture_cookies", "clone_job_id": "...", "browser": "chrome",
//	  "captured_at": "...", "chunk_index": 0, "chunk_count": 3,
//	  "truncated": false, "cookies": [ Cookie, ... ] }
//
// ChunkIndex counts from 0. Truncated is true (on the last chunk) only when
// the EXTENSION hit its own cap — a partial jar must never be sent as whole.
type CaptureChunk struct {
	CloneJobID string   `json:"clone_job_id"`
	Browser    string   `json:"browser"`
	CapturedAt string   `json:"captured_at"`
	ChunkIndex int      `json:"chunk_index"`
	ChunkCount int      `json:"chunk_count"`
	Truncated  bool     `json:"truncated"`
	Cookies    []Cookie `json:"cookies"`
}

// CapturePayload is the native host → server POST body for
// POST /api/devices/clone-capture (a public, device-facing route; the
// PER-DEVICE token is the credential). It deliberately carries no token:
// auth travels in the Authorization header only, and the token is never
// embedded in the payload.
type CapturePayload struct {
	CloneJobID string   `json:"cloneJobId"`
	DeviceID   string   `json:"deviceId"`
	Browser    string   `json:"browser"`
	CapturedAt string   `json:"capturedAt"`
	Cookies    []Cookie `json:"cookies"`
	Truncated  bool     `json:"truncated"`
}

// DomainCount returns the number of distinct cookie domains in a jar.
// It is the only per-cookie aggregate the reply may carry (counts and domains
// only — never a value, never a name).
func DomainCount(cookies []Cookie) int {
	seen := make(map[string]struct{}, len(cookies))
	for _, c := range cookies {
		if c.Domain == "" {
			continue
		}
		seen[c.Domain] = struct{}{}
	}
	return len(seen)
}

// ---------------------------------------------------------------------------
// Error-code-to-error adapter
// ---------------------------------------------------------------------------

// CodeError is an error value carrying one of the Err* code strings defined
// above, so callers can pass string codes where Go expects an error value
// and the CLI can present stable machine-readable codes.
type CodeError struct {
	Code    string
	Message string
}

func (e *CodeError) Error() string {
	if e.Message != "" {
		return e.Code + ": " + e.Message
	}
	return e.Code
}

// Code wraps an error-code string into a real error value.
func Code(code string) error {
	return &CodeError{Code: code}
}

// CodeOf extracts the Err* code string from an error value, or "".
func CodeOf(e error) string {
	if c, ok := e.(*CodeError); ok {
		return c.Code
	}
	return ""
}

// WithMessage attaches a detail message to a CodeError.
func WithMessage(e error, msg string) error {
	if c, ok := e.(*CodeError); ok {
		return &CodeError{Code: c.Code, Message: msg}
	}
	return e
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// NewUuid returns a random RFC 4122 version 4 UUID string.
func NewUuid() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6] = byte((int(b[6]) & 0x0F) | 0x40) // version 4
	b[8] = byte((int(b[8]) & 0x3F) | 0x80) // variant 10
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

// NowIso returns the current time as an RFC 3339 (ISO 8601) string, e.g.
// "2026-09-21T14:32:00Z".
func NowIso() string {
	return time.Now().UTC().Format(time.RFC3339)
}

// AddDaysIso returns the RFC 3339 string d days after the given RFC 3339
// string. Returns "" if input is unparseable.
func AddDaysIso(iso string, d int) string {
	t, err := time.Parse(time.RFC3339, iso)
	if err != nil || t.IsZero() {
		return ""
	}
	return t.Add(time.Duration(d) * 24 * time.Hour).UTC().Format(time.RFC3339)
}

// ParseIso parses an RFC 3339 string into a Time. Returns time.Time{} (zero)
// on failure.
func ParseIso(iso string) time.Time {
	t, err := time.Parse(time.RFC3339, iso)
	if err != nil {
		return time.Time{}
	}
	return t
}

// IsExpired compares an RFC 3339 expiry to now.
func IsExpired(expiresAt string) bool {
	exp := ParseIso(expiresAt)
	if exp.IsZero() {
		return true // unparseable -> treat as expired
	}
	return exp.Before(time.Now().UTC())
}

// TimeToIso formats a Time as RFC 3339.
func TimeToIso(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}

// Itoa converts an int to a string.
func Itoa(n int) string {
	return strconv.Itoa(n)
}

// Itoa64 converts an int64 to a string.
func Itoa64(n int64) string {
	return strconv.FormatInt(n, 10)
}

// JoinString joins a string slice with sep.
func JoinString(v []string, sep string) string {
	return strings.Join(v, sep)
}
