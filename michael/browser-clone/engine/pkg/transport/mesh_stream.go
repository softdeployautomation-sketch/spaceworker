// Package transport moves a clone parcel between work PC and hosted PC and
// implements the mesh wire protocol (directive §9/§10,
// pkg/transport/mesh_stream.go). The parcel envelope is transport-layer
// AES-256-GCM encrypted (in transit) on top of the already-encrypted bundle
// content; the CLI orchestrates key exchange (passphrase-derived test mode,
// DPAPI-protected key files in real deployments).
package transport

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"spaceworker.browser-clone/pkg/bundler"
	"spaceworker.browser-clone/pkg/crypto"
	"spaceworker.browser-clone/pkg/types"
)

// MeshEnvelope is the JSON wire unit exchanged between agent and host.
type MeshEnvelope struct {
	// Version is the mesh protocol version this build speaks.
	Version  int
	CloneId  string
	Nonce    string // base64
	AuthTag  string // base64
	Body     string // base64 AES-256-GCM(parcel bytes)
	SentAt   string
	SourcePc string
	TargetPc string
}

// MeshProtocolVersion is the wire format version.
const MeshProtocolVersion = 1

// ErrMesh is the mesh protocol error family.
var ErrMesh = errors.New("transport: mesh protocol error")

// ErrTransport is a generic transport error.
var ErrTransport = errors.New("transport: error")

// EncodeMesh builds a MeshEnvelope encrypting parcel bytes under key with aad
// = "sw-mesh-v1:" + cloneId.
func EncodeMesh(p *Parcel, key []byte, sourcePc, targetPc string) (*MeshEnvelope, error) {
	parcelBytes, err := marshalParcel(p)
	if err != nil {
		return nil, err
	}
	aad := []byte("sw-mesh-v1:" + p.CloneId)
	ct, nonce, tag, err := cryptoSeal(key, parcelBytes, aad)
	if err != nil {
		return nil, fmtWrap(err)
	}
	return &MeshEnvelope{
		Version:  MeshProtocolVersion,
		CloneId:  p.CloneId,
		Nonce:    base64.StdEncoding.EncodeToString(nonce),
		AuthTag:  base64.StdEncoding.EncodeToString(tag),
		Body:     base64.StdEncoding.EncodeToString(ct),
		SentAt:   time.Now().UTC().Format(time.RFC3339),
		SourcePc: sourcePc,
		TargetPc: targetPc,
	}, nil
}

// DecodeMesh reverses EncodeMesh; returns the parcel bytes.
func DecodeMesh(env *MeshEnvelope, key []byte) ([]byte, error) {
	if env.Version != MeshProtocolVersion {
		return nil, fmt.Errorf("%w: unsupported version %d", ErrMesh, env.Version)
	}
	nonce, err := base64.StdEncoding.DecodeString(env.Nonce)
	if err != nil {
		return nil, err
	}
	tag, err := base64.StdEncoding.DecodeString(env.AuthTag)
	if err != nil {
		return nil, err
	}
	ct, err := base64.StdEncoding.DecodeString(env.Body)
	if err != nil {
		return nil, err
	}
	aad := []byte("sw-mesh-v1:" + env.CloneId)
	pt, err := cryptoOpen(key, ct, nonce, tag, aad)
	if err != nil {
		return nil, fmt.Errorf("%w: envelope auth failed: %v", ErrMesh, err)
	}
	return pt, nil
}

// marshalParcel serialises a parcel into a single JSON byte blob.
func marshalParcel(p *Parcel) ([]byte, error) {
	return json.Marshal(map[string]any{
		"clone_id":        p.CloneId,
		"manifest_json":   string(p.ManifestJSON),
		"profile_zip_b64": base64.StdEncoding.EncodeToString(p.ProfileZip),
		"extensions_b64":  base64.StdEncoding.EncodeToString(p.ExtensionsZip),
		"passwords_json":  string(p.PasswordsJSON),
		"key_b64":         p.TransportKeyB64,
	})
}

// UnmarshalParcel reverses marshalParcel.
func UnmarshalParcel(b []byte) (*Parcel, error) {
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, err
	}
	p := &Parcel{}
	if s, ok := m["clone_id"].(string); ok {
		p.CloneId = s
	}
	if s, ok := m["manifest_json"].(string); ok {
		p.ManifestJSON = []byte(s)
	}
	if s, ok := m["profile_zip_b64"].(string); ok {
		p.ProfileZip, _ = base64.StdEncoding.DecodeString(s)
	}
	if s, ok := m["extensions_b64"].(string); ok {
		p.ExtensionsZip, _ = base64.StdEncoding.DecodeString(s)
	}
	if s, ok := m["passwords_json"].(string); ok {
		p.PasswordsJSON = []byte(s)
	}
	if s, ok := m["key_b64"].(string); ok {
		p.TransportKeyB64 = s
	}
	return p, nil
}

func fmtWrap(err error) error {
	return errors.New("transport: " + err.Error())
}

// cryptoSeal/cryptoOpen keep the code reading clearly at the call sites.
func cryptoSeal(key, data, aad []byte) ([]byte, []byte, []byte, error) {
	return crypto.SealGCM(key, data, aad)
}

func cryptoOpen(key, data, nonce, tag, aad []byte) ([]byte, error) {
	return crypto.OpenGCM(key, data, nonce, tag, aad)
}

// ---------------------------------------------------------------------------
// Parcel: the on-disk transfer unit (one file per artifact)
// ---------------------------------------------------------------------------

// Parcel is the on-disk transfer unit (one file per artifact).
type Parcel struct {
	CloneId         string
	ManifestJSON    []byte
	ProfileZip      []byte
	ExtensionsZip   []byte
	PasswordsJSON   []byte
	TransportKeyB64 string
}

// BuildParcel assembles a Parcel from a Bundle. The transport key is kept
// alongside the artifacts so the receiving host can stage them (in the real
// deployment the key itself travels via DPAPI/key-exchange; this project keeps
// it in a sidecar file protected by file permissions).
func BuildParcel(b *bundler.Bundle, key []byte) (*Parcel, error) {
	return &Parcel{
		CloneId:         b.Manifest.CloneId,
		ManifestJSON:    b.ManifestJSON,
		ProfileZip:      b.ProfileZip,
		ExtensionsZip:   b.ExtensionsZip,
		PasswordsJSON:   b.PasswordsJSON,
		TransportKeyB64: base64.StdEncoding.EncodeToString(key),
	}, nil
}

// Write persists a parcel into a directory (one file per artifact).
func (p *Parcel) Write(dir string) (string, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	write := func(name string, data []byte) error {
		if len(data) == 0 {
			return nil
		}
		return os.WriteFile(filepath.Join(dir, name), data, 0o600)
	}
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), p.ManifestJSON, 0o600); err != nil {
		return "", err
	}
	if err := write("profile.zip", p.ProfileZip); err != nil {
		return "", err
	}
	if err := write("extensions.zip", p.ExtensionsZip); err != nil {
		return "", err
	}
	if err := write("passwords.json", p.PasswordsJSON); err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(dir, "transport.key"), []byte(p.TransportKeyB64), 0o600); err != nil {
		return "", err
	}
	return dir, nil
}

// ReadParcel loads a parcel from a directory written by Write.
func ReadParcel(dir string) (*Parcel, error) {
	p := &Parcel{}
	read := func(name string) ([]byte, error) {
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			return nil, err
		}
		return data, nil
	}
	var err error
	p.ManifestJSON, err = read("manifest.json")
	if err != nil {
		return nil, err
	}
	if kb, err := read("transport.key"); err == nil {
		p.TransportKeyB64 = string(kb)
	}
	if b, err := read("profile.zip"); err == nil {
		p.ProfileZip = b
	}
	if b, err := read("extensions.zip"); err == nil {
		p.ExtensionsZip = b
	}
	if b, err := read("passwords.json"); err == nil {
		p.PasswordsJSON = b
	}
	var m types.CloneManifest
	if err := json.Unmarshal(p.ManifestJSON, &m); err != nil {
		return nil, fmt.Errorf("%w: invalid manifest: %v", ErrTransport, err)
	}
	p.CloneId = m.CloneId
	return p, nil
}

// DecodeTransportKey returns the raw transport key bytes.
func (p *Parcel) DecodeTransportKey() ([]byte, error) {
	return base64.StdEncoding.DecodeString(stringsTrim(p.TransportKeyB64))
}

func stringsTrim(s string) string {
	// strip trailing newline/spaces
	i := len(s)
	for i > 0 && (s[i-1] == ' ' || s[i-1] == '\n' || s[i-1] == '\r' || s[i-1] == '\t') {
		i--
	}
	return s[:i]
}

// VerifyParcel re-checks the manifest signature and zip hashes.
func VerifyParcel(p *Parcel, key []byte) (bool, string, error) {
	var m types.CloneManifest
	if err := json.Unmarshal(p.ManifestJSON, &m); err != nil {
		return false, "", fmt.Errorf("%w: invalid manifest JSON: %v", ErrTransport, err)
	}
	if !bundler.VerifySignature(m, key) {
		return false, "signature", types.Code(types.ErrSignatureMismatch)
	}
	if crypto.Sha256Hex(p.ProfileZip) != m.ProfileZipSha256 {
		return false, "profile.zip", types.Code(types.ErrIntegrityCheckFailed)
	}
	if len(p.ExtensionsZip) > 0 && crypto.Sha256Hex(p.ExtensionsZip) != m.ExtensionsZipSha256 {
		return false, "extensions.zip", types.Code(types.ErrIntegrityCheckFailed)
	}
	return true, "", nil
}
