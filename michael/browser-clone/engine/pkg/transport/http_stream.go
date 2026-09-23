// HTTP streaming over the mesh tunnel (directive §6,
// pkg/transport/mesh_stream.go "Streaming Protocol"):
//
//	POST /rmm/inject-clone
//	  X-Clone-ID, X-Signature (HMAC-SHA256 over profile.zip+extensions.zip),
//	  X-Browser-Type, X-Browser-Version, X-Source-PC, X-Source-User,
//	  X-Manifest (base64 manifest.json)
//	  Body: 10 MB chunks; the hosted PC ACKs every chunk; the final chunk
//	  carries the validation result.
//
// Chunk failures are retried up to 3 times with 1s/2s/4s backoff under a
// 5-minute total deadline (§6 "Chunking & Retry"). The receiver never takes
// the transport key from the stream: it resolves the key from the local
// registry by clone id (provisioned out-of-band via the control-plane key
// exchange; see the provision-key CLI command), or rejects with
// ErrKeyNotFound ([RECV CHECK 1]).
package transport

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"spaceworker.browser-clone/pkg/crypto"
	"spaceworker.browser-clone/pkg/types"
)

// ---------------------------------------------------------------------------
// Wire constants (directive §6)
// ---------------------------------------------------------------------------

const (
	// HTTPPath is the mesh endpoint path on the hosted PC.
	HTTPPath = "/rmm/inject-clone"
	// DefaultChunkSize is the §6 chunk size (10 MB).
	DefaultChunkSize = 10 << 20
	// DefaultChunkAttempts is the per-chunk retry budget.
	DefaultChunkAttempts = 3
	// chunkBackoff is the §6 exponential backoff base (1s, 2s, 4s).
	chunkBackoff = time.Second
	// DefaultTransferTimeout is the §6 total transfer deadline (5 minutes).
	DefaultTransferTimeout = 5 * time.Minute
	// maxChunkBytes caps a single chunk request body server-side.
	maxChunkBytes = 64 << 20
)

// ---------------------------------------------------------------------------
// Client (work PC side)
// ---------------------------------------------------------------------------

// HTTPOptions tunes SendHTTP.
type HTTPOptions struct {
	// Endpoint is the hosted-PC base URL, e.g. "http://192.168.122.222:8080".
	Endpoint string
	// ChunkSize overrides the 10 MB default (tests use small values).
	ChunkSize int
	// TransferTimeout overrides the 5-minute §6 deadline.
	TransferTimeout time.Duration
	// ChunkAttempts overrides the 3-attempt retry budget per chunk.
	ChunkAttempts int
	// SourceUser overrides X-Source-User; empty uses the manifest SID.
	SourceUser string
}

// HTTPResult reports what the hosted PC answered on the final chunk.
type HTTPResult struct {
	CloneId        string `json:"clone_id"`
	RegistryStatus string `json:"registry_status"`
	StagingDir     string `json:"staging_dir"`
	ChunksSent     int    `json:"chunks_sent"`
	DurationSecs   int    `json:"duration_seconds"`
}

// BundleSignature computes the §6 X-Signature value: HMAC-SHA256 over
// profile.zip concatenated with extensions.zip, keyed by the transport key,
// hex-encoded (same encoding as the manifest signature).
func BundleSignature(profileZip, extensionsZip, key []byte) string {
	data := make([]byte, 0, len(profileZip)+len(extensionsZip))
	data = append(data, profileZip...)
	data = append(data, extensionsZip...)
	return crypto.HmacSha256Hex(key, data)
}

// SendHTTP streams a parcel to the hosted-PC receiver endpoint in chunks
// (directive §6) and returns the final validation/staging result.
func SendHTTP(p *Parcel, opts HTTPOptions) (*HTTPResult, error) {
	if opts.Endpoint == "" {
		return nil, fmt.Errorf("%s: empty endpoint", types.ErrMeshUnavailable)
	}
	var m types.CloneManifest
	if err := types.UnmarshalJSONBOM(p.ManifestJSON, &m); err != nil {
		return nil, fmt.Errorf("%s: invalid manifest: %v", types.ErrInvalidManifest, err)
	}
	key, err := p.DecodeTransportKey()
	if err != nil || len(key) == 0 {
		return nil, fmt.Errorf("%s: parcel has no transport key", types.ErrKeyNotFound)
	}

	chunkSize := opts.ChunkSize
	if chunkSize <= 0 {
		chunkSize = DefaultChunkSize
	}
	attempts := opts.ChunkAttempts
	if attempts <= 0 {
		attempts = DefaultChunkAttempts
	}
	deadline := opts.TransferTimeout
	if deadline <= 0 {
		deadline = DefaultTransferTimeout
	}
	ctx, cancel := context.WithTimeout(context.Background(), deadline)
	defer cancel()

	endpoint := strings.TrimSuffix(opts.Endpoint, "/") + HTTPPath
	sig := BundleSignature(p.ProfileZip, p.ExtensionsZip, key)
	sourceUser := opts.SourceUser
	if sourceUser == "" {
		sourceUser = m.SourceUserSid
	}
	baseHeaders := map[string]string{
		"X-Clone-ID":        p.CloneId,
		"X-Signature":       sig,
		"X-Browser-Type":    m.BrowserType,
		"X-Browser-Version": m.BrowserVersion,
		"X-Source-PC":       m.SourcePc,
		"X-Source-User":     sourceUser,
		"X-Manifest":        base64.StdEncoding.EncodeToString(p.ManifestJSON),
		"Content-Type":      "application/octet-stream",
	}

	type chunkRef struct {
		artifact string
		index    int
		count    int
		data     []byte
		final    bool
	}
	var chunks []chunkRef
	addChunks := func(artifact string, data []byte) {
		if len(data) == 0 {
			return
		}
		count := (len(data) + chunkSize - 1) / chunkSize
		for i := 0; i < count; i++ {
			lo, hi := i*chunkSize, (i+1)*chunkSize
			if hi > len(data) {
				hi = len(data)
			}
			chunks = append(chunks, chunkRef{artifact: artifact, index: i, count: count, data: data[lo:hi]})
		}
	}
	addChunks("profile", p.ProfileZip)
	addChunks("extensions", p.ExtensionsZip)
	if len(chunks) == 0 {
		return nil, fmt.Errorf("%s: parcel has no bulk data", types.ErrInvalidManifest)
	}
	chunks[len(chunks)-1].final = true

	client := &http.Client{Timeout: 2 * time.Minute}
	start := time.Now()
	for i, c := range chunks {
		if err := ctx.Err(); err != nil {
			return nil, fmt.Errorf("%s: transfer deadline exceeded: %v", types.ErrMeshUnavailable, err)
		}
		hdrs := map[string]string{
			"X-Artifact":     c.artifact,
			"X-Chunk-Index":  fmt.Sprint(c.index),
			"X-Chunk-Count":  fmt.Sprint(c.count),
			"X-Content-Size": fmt.Sprint(len(c.data)),
		}
		if c.final {
			hdrs["X-Final"] = "1"
		}
		for k, v := range baseHeaders {
			hdrs[k] = v
		}
		respBody, err := postChunk(ctx, client, endpoint, hdrs, c.data, attempts)
		if err != nil {
			return nil, err
		}
		if !c.final {
			continue
		}
		var result struct {
			Status   string `json:"status"`
			CloneId  string `json:"clone_id"`
			Registry string `json:"registry_status"`
			Staging  string `json:"staging_dir"`
		}
		if err := types.UnmarshalJSONBOM(respBody, &result); err != nil {
			return nil, fmt.Errorf("%s: unreadable receiver response: %v", types.ErrMeshUnavailable, err)
		}
		if result.Status != "received" {
			return nil, fmt.Errorf("%s: receiver rejected bundle", types.ErrProfileValidationFailed)
		}
		return &HTTPResult{
			CloneId:        result.CloneId,
			RegistryStatus: result.Registry,
			StagingDir:     result.Staging,
			ChunksSent:     i + 1,
			DurationSecs:   int(time.Since(start).Seconds()),
		}, nil
	}
	return nil, fmt.Errorf("%s: transfer ended without a final chunk", types.ErrMeshUnavailable)
}

// postChunk issues one chunk POST with §6 retry semantics: network errors and
// 5xx responses are retried up to attempts times with 1s/2s/4s backoff; 4xx
// responses are terminal (validation failures are not transient).
func postChunk(ctx context.Context, client *http.Client, endpoint string,
	hdrs map[string]string, body []byte, attempts int) ([]byte, error) {
	var lastErr error
	for try := 0; try < attempts; try++ {
		if try > 0 {
			select {
			case <-time.After(chunkBackoff * time.Duration(1<<uint(try-1))):
			case <-ctx.Done():
				return nil, fmt.Errorf("%s: retry deadline exceeded: %v", types.ErrMeshUnavailable, ctx.Err())
			}
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(string(body)))
		if err != nil {
			return nil, fmt.Errorf("%s: %v", types.ErrMeshUnavailable, err)
		}
		for k, v := range hdrs {
			req.Header.Set(k, v)
		}
		resp, err := client.Do(req)
		if err != nil {
			lastErr = fmt.Errorf("%s: mesh endpoint unreachable: %v", types.ErrMeshUnavailable, err)
			continue
		}
		data, readErr := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		resp.Body.Close()
		if readErr != nil {
			lastErr = fmt.Errorf("%s: response read failed: %v", types.ErrMeshUnavailable, readErr)
			continue
		}
		if resp.StatusCode >= 500 || resp.StatusCode == http.StatusTooManyRequests {
			lastErr = fmt.Errorf("%s: receiver unavailable (http %d): %s",
				types.ErrMeshUnavailable, resp.StatusCode, strings.TrimSpace(string(data)))
			continue
		}
		if resp.StatusCode >= 400 {
			// Terminal: surface the receiver's error code verbatim.
			return nil, fmt.Errorf("%s", strings.TrimSpace(string(data)))
		}
		return data, nil
	}
	return nil, lastErr
}
