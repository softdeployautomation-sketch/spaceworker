package injection

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"spaceworker.browser-clone/pkg/audit"
	"spaceworker.browser-clone/pkg/crypto"
	"spaceworker.browser-clone/pkg/registry"
	"spaceworker.browser-clone/pkg/transport"
	"spaceworker.browser-clone/pkg/types"
)

// testZipContent is the payload stored inside the fixture profile zip.
var testZipContent = []byte(`{"clone":"stream-test"}`)

// makeTestZip builds a real in-memory zip with one profile file, matching the
// manifest entry created by streamFixture.
func makeTestZip(t *testing.T) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, err := zw.Create("Preferences")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write(testZipContent); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// streamFixture builds a signed two-artifact parcel with a per-file manifest
// entry, small enough to force multi-chunk behaviour at tiny chunk sizes.
func streamFixture(t *testing.T, root string, corrupt bool) (*transport.Parcel, []byte, string) {
	t.Helper()
	key := []byte("0123456789abcdef0123456789abcdef")
	profileZip, exts := makeTestZip(t), makeTestZip(t)
	if corrupt {
		profileZip[8] ^= 0xFF
	}
	manifest := types.CloneManifest{
		CloneId:        "streamclone0001",
		SourcePc:       "WORKPC",
		SourceUserSid:  "S-1-5-21-1",
		BrowserType:    "chrome",
		BrowserVersion: "130.0.1.1",
		CreatedAt:      types.NowIso(),
		// One hour of validity: the RECV CHECK 3 expiry comparison is strict.
		ExpiresAt: time.Now().Add(time.Hour).UTC().Format(time.RFC3339),
		Files: []types.ManifestFile{{
			Path:   "Preferences",
			Size:   len(testZipContent),
			Sha256: crypto.Sha256Hex(testZipContent),
		}},
		ProfileZipSha256:    crypto.Sha256Hex(profileZip),
		ExtensionsZipSha256: crypto.Sha256Hex(exts),
		SignatureMethod:     "HMAC-SHA256",
	}
	// Sign the canonical manifest exactly like bundler.Build does (§5).
	canon := manifest
	canon.Signature = ""
	canon.Validation = ""
	canonBytes, err := json.Marshal(&canon)
	if err != nil {
		t.Fatal(err)
	}
	manifest.Signature = crypto.HmacSha256Hex(key, canonBytes)
	mj, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	parcel := &transport.Parcel{
		CloneId:         manifest.CloneId,
		ManifestJSON:    mj,
		ProfileZip:      profileZip,
		ExtensionsZip:   exts,
		TransportKeyB64: crypto.B64Encode(key),
	}
	// Provision the key out-of-band (stand-in for the control-plane exchange).
	reg, err := registry.New(filepath.Join(root, "registry"))
	if err != nil {
		t.Fatal(err)
	}
	if err := reg.Save(&types.CloneRegistryEntry{
		CloneId:      manifest.CloneId,
		Status:       types.StatusTransferring,
		TransportKey: key,
	}); err != nil {
		t.Fatal(err)
	}
	return parcel, key, manifest.Signature
}

// newStreamTestServer wires a StreamServer on a temp root.
func newStreamTestServer(t *testing.T, root string) *StreamServer {
	t.Helper()
	reg, err := registry.New(filepath.Join(root, "registry"))
	if err != nil {
		t.Fatal(err)
	}
	al, err := audit.New(filepath.Join(root, "audit"))
	if err != nil {
		t.Fatal(err)
	}
	s, err := NewStreamServer(StreamServerOptions{
		StagingRoot: filepath.Join(root, "clones"),
		Registry:    reg,
		Audit:       al,
	})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// postChunk is a raw-HTTP test client for one §6 chunk.
func postChunk(s *StreamServer, hdrs map[string]string, body []byte) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, transport.HTTPPath, bytes.NewReader(body))
	for k, v := range hdrs {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	return rec
}

func itoa(n int) string { return strconv.Itoa(n) }

// split divides data into n near-equal chunks.
func split(data []byte, n int) [][]byte {
	size := (len(data) + n - 1) / n
	var out [][]byte
	for i := 0; i < len(data); i += size {
		hi := i + size
		if hi > len(data) {
			hi = len(data)
		}
		out = append(out, data[i:hi])
	}
	return out
}

func TestStreamServerChunkedTransfer(t *testing.T) {
	root := t.TempDir()
	parcel, key, _ := streamFixture(t, root, false)
	s := newStreamTestServer(t, root)

	var m types.CloneManifest
	json.Unmarshal(parcel.ManifestJSON, &m)
	base := map[string]string{
		"X-Clone-ID":        parcel.CloneId,
		"X-Signature":       transport.BundleSignature(parcel.ProfileZip, parcel.ExtensionsZip, key),
		"X-Browser-Type":    m.BrowserType,
		"X-Browser-Version": m.BrowserVersion,
		"X-Source-PC":       m.SourcePc,
		"X-Source-User":     m.SourceUserSid,
		"X-Manifest":        base64.StdEncoding.EncodeToString(parcel.ManifestJSON),
	}

	// profile.zip in 3 chunks, extensions.zip in 2; X-Final on the last one.
	pChunks := split(parcel.ProfileZip, 3)
	eChunks := split(parcel.ExtensionsZip, 2)
	for i, c := range pChunks {
		h := map[string]string{"X-Artifact": "profile", "X-Chunk-Index": itoa(i), "X-Content-Size": itoa(len(c))}
		for k, v := range base {
			h[k] = v
		}
		rec := postChunk(s, h, c)
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "chunk-ack") {
			t.Fatalf("profile chunk %d: status=%d body=%s", i, rec.Code, rec.Body.String())
		}
	}
	for i, c := range eChunks {
		h := map[string]string{"X-Artifact": "extensions", "X-Chunk-Index": itoa(i), "X-Content-Size": itoa(len(c))}
		for k, v := range base {
			h[k] = v
		}
		last := i == len(eChunks)-1
		if last {
			h["X-Final"] = "1"
		}
		rec := postChunk(s, h, c)
		if !last {
			if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "chunk-ack") {
				t.Fatalf("extensions chunk %d: status=%d body=%s", i, rec.Code, rec.Body.String())
			}
			continue
		}
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"received"`) {
			t.Fatalf("final chunk: status=%d body=%s", rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), m.CloneId) ||
			!strings.Contains(rec.Body.String(), types.StatusReadyForInjection) {
			t.Fatalf("final response missing clone id/status: %s", rec.Body.String())
		}
	}

	// Staged tree exists with the .status marker.
	st := filepath.Join(root, "clones", m.CloneId, ".status")
	if b, err := os.ReadFile(st); err != nil || !strings.Contains(string(b), "ready-for-injection") {
		t.Fatalf(".status marker missing: %v %q", err, b)
	}
}

func TestStreamServerBadSignature(t *testing.T) {
	root := t.TempDir()
	parcel, _, _ := streamFixture(t, root, false)
	s := newStreamTestServer(t, root)
	h := map[string]string{
		"X-Clone-ID":  parcel.CloneId,
		"X-Signature": transport.BundleSignature(parcel.ProfileZip, parcel.ExtensionsZip, []byte("wrong-key-wrong-key!!")),
		"X-Artifact":  "profile", "X-Chunk-Index": "0", "X-Final": "1",
		"X-Manifest": base64.StdEncoding.EncodeToString(parcel.ManifestJSON),
	}
	rec := postChunk(s, h, parcel.ProfileZip)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), types.ErrSignatureMismatch) {
		t.Fatalf("want %s in body, got %s", types.ErrSignatureMismatch, rec.Body.String())
	}
}

func TestStreamServerKeyNotProvisioned(t *testing.T) {
	root := t.TempDir()
	parcel, key, _ := streamFixture(t, root, false)
	s := newStreamTestServer(t, root)
	// Simulate a clone whose key exchange never happened: fresh registry.
	reg2, err := registry.New(filepath.Join(root, "registry-empty"))
	if err != nil {
		t.Fatal(err)
	}
	s.opts.Registry = reg2
	h := map[string]string{
		"X-Clone-ID":  parcel.CloneId,
		"X-Signature": transport.BundleSignature(parcel.ProfileZip, parcel.ExtensionsZip, key),
		"X-Artifact":  "profile", "X-Chunk-Index": "0", "X-Final": "1",
		"X-Manifest": base64.StdEncoding.EncodeToString(parcel.ManifestJSON),
	}
	rec := postChunk(s, h, parcel.ProfileZip)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), types.ErrKeyNotFound) {
		t.Fatalf("want %s in body, got %s", types.ErrKeyNotFound, rec.Body.String())
	}
}
