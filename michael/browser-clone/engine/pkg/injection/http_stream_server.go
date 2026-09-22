// Hosted-PC side of the §6 HTTP streaming protocol (directive §6,
// pkg/transport/mesh_stream.go). The receiver accepts chunked uploads on
// POST /rmm/inject-clone, ACKs every chunk, and on the final chunk
// reassembles the bundle, verifies the X-Signature bundle HMAC ([RECV
// CHECK 1] with the key provisioned out-of-band in the local registry), and
// delegates to Receive for RECV CHECKs 2-5. The transport key is never read
// from the data stream.
package injection

import (
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"spaceworker.browser-clone/pkg/audit"
	"spaceworker.browser-clone/pkg/registry"
	"spaceworker.browser-clone/pkg/transport"
	"spaceworker.browser-clone/pkg/types"
)

const (
	// streamPath is the §6 mesh endpoint path.
	streamPath = transport.HTTPPath
	// maxChunkBytes caps a single chunk request body server-side.
	maxChunkBytes = 64 << 20
)

// StreamServerOptions configures the hosted-PC clone receiver.
type StreamServerOptions struct {
	// Addr is the listen address for ListenAndServe (e.g. ":8080").
	Addr string
	// StagingRoot is the clones root (defaults to DefaultStagingRoot).
	StagingRoot string
	// Registry resolves transport keys by clone id (provisioned out-of-band
	// via the control-plane key exchange). Nil creates one under
	// <StagingRoot>/../registry.
	Registry *registry.Store
	// Audit is the audit logger; optional but strongly recommended.
	Audit *audit.Logger
	// HostBrowserType / HostBrowserVersion feed RECV CHECK 2.
	HostBrowserType    string
	HostBrowserVersion string
	// MaxChunkBytes caps a single chunk (default maxChunkBytes).
	MaxChunkBytes int64
}

// StreamServer is the HTTP receiver half of the §6 streaming protocol. It
// buffers incoming chunks on disk until the final chunk triggers validation.
type StreamServer struct {
	mu       sync.Mutex
	opts     StreamServerOptions
	incoming string // in-flight chunk directory
	sessions map[string]*streamSession
}

type streamSession struct {
	cloneID        string
	dir            string
	manifestJSON   []byte
	signature      string
	browserType    string
	browserVer     string
	sourcePC       string
	sourceUser     string
	profileParts   map[int]string
	extensionParts map[int]string
}

// NewStreamServer prepares the receiver (creates the in-flight directory).
func NewStreamServer(opts StreamServerOptions) (*StreamServer, error) {
	if opts.StagingRoot == "" {
		opts.StagingRoot = DefaultStagingRoot()
	}
	if opts.MaxChunkBytes <= 0 {
		opts.MaxChunkBytes = maxChunkBytes
	}
	incoming := filepath.Join(opts.StagingRoot, ".incoming")
	if err := os.MkdirAll(incoming, 0o700); err != nil {
		return nil, err
	}
	return &StreamServer{opts: opts, incoming: incoming, sessions: make(map[string]*streamSession)}, nil
}

// ListenAndServe blocks serving the §6 endpoint on opts.Addr.
func (s *StreamServer) ListenAndServe() error {
	srv := &http.Server{
		Addr:              s.opts.Addr,
		Handler:           s,
		ReadHeaderTimeout: 30 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	return srv.ListenAndServe()
}

// ServeHTTP implements the §6 streaming endpoint (POST /rmm/inject-clone).
func (s *StreamServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != streamPath {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	cloneID := r.Header.Get("X-Clone-ID")
	if cloneID == "" || !safeID(cloneID) {
		httpError(w, http.StatusBadRequest, types.ErrInvalidManifest, "missing or invalid X-Clone-ID")
		return
	}
	if r.ContentLength > s.opts.MaxChunkBytes {
		httpError(w, http.StatusRequestEntityTooLarge, types.ErrProfileTooLarge, "chunk too large")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, s.opts.MaxChunkBytes+1))
	if err != nil {
		httpError(w, http.StatusBadRequest, types.ErrInvalidManifest, "chunk read failed")
		return
	}

	sess := s.session(cloneID)

	// Per-chunk metadata (headers repeat on every chunk; manifest first-wins,
	// scalars last-wins).
	if v := r.Header.Get("X-Manifest"); v != "" && sess.manifestJSON == nil {
		mj, derr := base64.StdEncoding.DecodeString(v)
		if derr != nil {
			httpError(w, http.StatusBadRequest, types.ErrInvalidManifest, "bad X-Manifest encoding")
			return
		}
		sess.manifestJSON = mj
	}
	sess.browserType = firstNonEmpty(sess.browserType, r.Header.Get("X-Browser-Type"))
	sess.browserVer = firstNonEmpty(sess.browserVer, r.Header.Get("X-Browser-Version"))
	sess.sourcePC = firstNonEmpty(sess.sourcePC, r.Header.Get("X-Source-PC"))
	sess.sourceUser = firstNonEmpty(sess.sourceUser, r.Header.Get("X-Source-User"))
	sess.signature = firstNonEmpty(sess.signature, r.Header.Get("X-Signature"))

	artifact := r.Header.Get("X-Artifact")
	idx, aerr := strconv.Atoi(r.Header.Get("X-Chunk-Index"))
	if aerr != nil || (artifact != "profile" && artifact != "extensions") {
		httpError(w, http.StatusBadRequest, types.ErrInvalidManifest, "bad X-Artifact/X-Chunk-Index")
		return
	}
	part, err := os.CreateTemp(sess.dir, "chunk-*")
	if err != nil {
		httpError(w, http.StatusInternalServerError, types.ErrOutputFailed, err.Error())
		return
	}
	if _, err := part.Write(body); err != nil {
		part.Close()
		httpError(w, http.StatusInternalServerError, types.ErrOutputFailed, err.Error())
		return
	}
	part.Close()
	partPath := fmt.Sprintf("%s.%s.%04d", part.Name(), artifact, idx)
	if err := os.Rename(part.Name(), partPath); err != nil {
		httpError(w, http.StatusInternalServerError, types.ErrOutputFailed, err.Error())
		return
	}

	s.mu.Lock()
	if artifact == "extensions" {
		sess.extensionParts[idx] = partPath
	} else {
		sess.profileParts[idx] = partPath
	}
	s.mu.Unlock()

	if r.Header.Get("X-Final") != "1" {
		// Chunk ACK (§6 step 3). The final chunk's response carries the
		// validation result instead, so it must be the only write there.
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "chunk-ack", "clone_id": cloneID})
		return
	}

	// Final chunk: reassemble, verify, stage (RECV CHECKs 1-5).
	result := s.finalize(sess)
	w.Header().Set("Content-Type", "application/json")
	if result.err != nil {
		w.WriteHeader(result.status)
		json.NewEncoder(w).Encode(map[string]string{"error": result.err.Error()})
		return
	}
	json.NewEncoder(w).Encode(map[string]string{
		"status":          "received",
		"clone_id":        sess.cloneID,
		"registry_status": result.registryStatus,
		"staging_dir":     result.stagingDir,
	})
}

// session returns (creating if needed) the in-flight session for a clone.
func (s *StreamServer) session(cloneID string) *streamSession {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[cloneID]
	if !ok {
		sess = &streamSession{
			cloneID:        cloneID,
			dir:            filepath.Join(s.incoming, cloneID),
			profileParts:   map[int]string{},
			extensionParts: map[int]string{},
		}
		_ = os.MkdirAll(sess.dir, 0o700)
		s.sessions[cloneID] = sess
	}
	return sess
}

type finalizeResult struct {
	status         int
	registryStatus string
	stagingDir     string
	err            error
}

// finalize reassembles the bundle, resolves the transport key from the local
// registry (never from the data stream — §6/§7), verifies the §6 bundle
// signature against X-Signature ([RECV CHECK 1]), and delegates to Receive
// for the remaining RECV CHECKs.
func (s *StreamServer) finalize(sess *streamSession) finalizeResult {
	if sess.manifestJSON == nil {
		s.cleanup(sess)
		return finalizeResult{status: http.StatusBadRequest,
			err: fmt.Errorf("%s: no manifest received", types.ErrInvalidManifest)}
	}
	var m types.CloneManifest
	if err := json.Unmarshal(sess.manifestJSON, &m); err != nil {
		s.cleanup(sess)
		return finalizeResult{status: http.StatusBadRequest,
			err: fmt.Errorf("%s: invalid manifest: %v", types.ErrInvalidManifest, err)}
	}
	profileZip, err := joinParts(sess.profileParts)
	if err != nil {
		s.cleanup(sess)
		return finalizeResult{status: http.StatusInternalServerError,
			err: fmt.Errorf("%s: profile reassembly failed: %v", types.ErrOutputFailed, err)}
	}
	extensionZip, err := joinParts(sess.extensionParts)
	if err != nil {
		s.cleanup(sess)
		return finalizeResult{status: http.StatusInternalServerError,
			err: fmt.Errorf("%s: extensions reassembly failed: %v", types.ErrOutputFailed, err)}
	}

	key, kerr := s.resolveKey(m.CloneId)
	if kerr != nil {
		if s.opts.Audit != nil {
			s.opts.Audit.Security(audit.EvKeyNotFound, m.CloneId,
				types.Code(types.ErrKeyNotFound), map[string]any{"check": "recv_key_exchange"})
		}
		s.cleanup(sess)
		return finalizeResult{status: http.StatusUnauthorized, err: kerr}
	}

	// [RECV CHECK 1] X-Signature: HMAC-SHA256 over the received bundle bytes
	// with the provisioned transport key (directive §6 "Signature").
	want := transport.BundleSignature(profileZip, extensionZip, key)
	if subtle.ConstantTimeCompare([]byte(want), []byte(sess.signature)) != 1 {
		if s.opts.Audit != nil {
			s.opts.Audit.Security(audit.EvSignatureMismatch, m.CloneId,
				types.Code(types.ErrSignatureMismatch), map[string]any{"check": "recv_signature"})
		}
		s.cleanup(sess)
		return finalizeResult{status: http.StatusUnauthorized,
			err: fmt.Errorf("%s: bundle signature mismatch", types.ErrSignatureMismatch)}
	}

	parcel := &transport.Parcel{
		CloneId:       m.CloneId,
		ManifestJSON:  sess.manifestJSON,
		ProfileZip:    profileZip,
		ExtensionsZip: extensionZip,
		// TransportKeyB64 deliberately empty: the key never rides the stream.
	}
	entry, rerr := Receive(parcel, ReceiveOptions{
		StagingRoot:        s.opts.StagingRoot,
		TransportKey:       key,
		Registry:           s.opts.Registry,
		Audit:              s.opts.Audit,
		HostBrowserType:    s.opts.HostBrowserType,
		HostBrowserVersion: s.opts.HostBrowserVersion,
	})
	if rerr != nil {
		s.cleanup(sess)
		return finalizeResult{status: statusFor(rerr), err: rerr}
	}
	s.cleanup(sess)
	return finalizeResult{registryStatus: entry.Status, stagingDir: entry.StagingDir}
}

// resolveKey looks up the transport key provisioned out-of-band in the local
// registry (stand-in for the control-plane key exchange). The underlying
// registry error is surfaced so misprovisioned keys are diagnosable (e.g. a
// user-scope DPAPI blob minted in a different logon session).
func (s *StreamServer) resolveKey(cloneID string) ([]byte, error) {
	if s.opts.Registry == nil {
		return nil, fmt.Errorf("%s: no provisioned transport key for clone %s (key exchange never completed)",
			types.ErrKeyNotFound, cloneID)
	}
	e, err := s.opts.Registry.Load(cloneID)
	if err != nil {
		return nil, fmt.Errorf("%s: registry lookup for clone %s failed: %w", types.ErrKeyNotFound, cloneID, err)
	}
	if len(e.TransportKey) == 0 {
		return nil, fmt.Errorf("%s: registry entry for clone %s has no transport key (key exchange never completed)",
			types.ErrKeyNotFound, cloneID)
	}
	return e.TransportKey, nil
}

// cleanup removes the in-flight chunk directory for a finished session.
func (s *StreamServer) cleanup(sess *streamSession) {
	s.mu.Lock()
	delete(s.sessions, sess.cloneID)
	s.mu.Unlock()
	os.RemoveAll(sess.dir)
}

// joinParts concatenates chunk files in index order.
func joinParts(parts map[int]string) ([]byte, error) {
	if len(parts) == 0 {
		return nil, nil
	}
	keys := make([]int, 0, len(parts))
	for k := range parts {
		keys = append(keys, k)
	}
	sort.Ints(keys)
	var out []byte
	for _, k := range keys {
		b, err := os.ReadFile(parts[k])
		if err != nil {
			return nil, err
		}
		out = append(out, b...)
	}
	return out, nil
}

// safeID allows only registry-safe clone ids into filesystem paths.
func safeID(id string) bool {
	if id == "" || len(id) > 64 {
		return false
	}
	for _, c := range id {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// statusFor maps a receiver error onto an HTTP status for the final chunk.
func statusFor(err error) int {
	msg := err.Error()
	switch {
	case strings.Contains(msg, types.ErrKeyNotFound),
		strings.Contains(msg, types.ErrSignatureMismatch):
		return http.StatusUnauthorized
	case strings.Contains(msg, types.ErrInvalidManifest):
		return http.StatusBadRequest
	case strings.Contains(msg, types.ErrBrowserTypeMismatch),
		strings.Contains(msg, types.ErrBrowserMismatch),
		strings.Contains(msg, types.ErrUserMismatch):
		return http.StatusForbidden
	case strings.Contains(msg, types.ErrCloneExpired):
		return http.StatusGone
	case strings.Contains(msg, types.ErrInsufficientStorage):
		return http.StatusInsufficientStorage
	case strings.Contains(msg, types.ErrIntegrityCheckFailed),
		strings.Contains(msg, types.ErrProfileValidationFailed):
		return http.StatusUnprocessableEntity
	default:
		return http.StatusInternalServerError
	}
}

// httpError writes a §6 error-code body with a mapped HTTP status.
func httpError(w http.ResponseWriter, status int, code string, msg string) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(status)
	fmt.Fprintf(w, "%s: %s", code, msg)
}
