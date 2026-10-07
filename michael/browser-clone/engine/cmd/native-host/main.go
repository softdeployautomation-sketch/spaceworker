// Command native-host is the Chrome/Edge native messaging host bridge
// (directive §10). It is launched by the browser with no console (build it
// with -ldflags "-H windowsgui" on Windows) and must never be visible;
// it reads length-prefixed JSON messages from stdin and writes the JSON
// response to stdout using the same framing.
//
// The host implements three commands:
//
//	{ "command": "clone_browser", "browser_type": "brave", "hosted_pc_id": "..." }
//	→ { "status": "success", "clone_id": "..." }
//
//	{ "command": "get_clone_status", "clone_id": "..." }
//	→ { "status": "in-progress", "progress": "transferring|injecting" }
//	→ { "status": "active" }
//	→ { "status": "error", "error": "..." }
//
//	{ "command": "capture_cookies", "clone_job_id": "...", "browser": "chrome",
//	  "captured_at": "2026-09-25T00:00:00Z", "chunk_index": 0, "chunk_count": 3,
//	  "truncated": false, "cookies": [ { name, value, domain, path, secure,
//	  httpOnly, sameSite, expirationDate } ] }
//	→ { "status": "success", "accepted": 1204, "domains": 63, "truncated": false }
//	→ { "status": "error", "error": "clip_named_reason" }
//
// capture_cookies is TASK_119B (B9-B) — live session mode. The extension reads
// the cookies INSIDE the browser (chrome.cookies.getAll; every out-of-process
// route is dead on Chrome 127+ — TASK_117 F10/F11/F12), chunks them under the
// 1 MiB native-messaging framing limit, and this host accumulates the chunks
// IN MEMORY and makes ONE POST to the device-facing capture route. The cookie
// VALUES are a live credential: they are never logged, never echoed in an
// error, and never written to disk outside a harness's 0600 temp file.
//
// Work for the legacy clone commands is delegated to the hack-browser-clone CLI
// (expected next to this binary, or on PATH), which keeps the RMM-agent surface
// identical for both the extension path and the remote-admin path.
package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/json"

	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"spaceworker.browser-clone/pkg/procattr"
	"spaceworker.browser-clone/pkg/types"
	"spaceworker.browser-clone/pkg/wake"
)

// maxMessageBytes caps a single native-messaging message (1 MiB is far more
// than any command payload we emit; profile data never flows through here).
// TASK_119B: this is a FRAMING limit, which is exactly why capture_cookies
// arrives in chunks instead of one message.
const maxMessageBytes = 1 << 20

// ---------------------------------------------------------------------------
// TASK_119B — live session capture: config, caps and state
// ---------------------------------------------------------------------------

const (
	// captureConfigEnv overrides the config-file location. The one-click setup
	// writes the default path; the proof harness points this at a 0600 temp
	// file so nothing depends on a production install.
	captureConfigEnv = "SPACEWORKER_CLONE_CONFIG"
	// capturePayloadOutEnv is the harness-only escape hatch: when set, the
	// assembled POST body is written to that path (0600) and NO network call is
	// made — that is how capture is proven with Path A undeployed.
	capturePayloadOutEnv = "SPACEWORKER_CLONE_PAYLOAD_OUT"
	// captureConfigName is the host's own config file (0600), written by the
	// one-click setup (TASK_114 / Path A's A5a) — the same channel that
	// delivers the relay token. NEVER committed, NEVER inside the extension.
	captureConfigName = "live-capture.json"
	// cloneCapturePath is the device-facing route (Path A's A5). The device
	// token IS the credential: no server-side/internal bearer, ever.
	cloneCapturePath = "/api/devices/clone-capture"
	// defaultBaseURL is only a fallback for a config that omits base_url; the
	// real app origin is configuration, exactly like the extension's.
	defaultBaseURL = "https://spaceworker.top"
	// maxCaptureBytes is the hard cap on an assembled jar (the contract's
	// 25 MB). Chunks that would exceed it are refused, not truncated silently.
	maxCaptureBytes = 25 << 20
	// capturePOSTTimeout bounds the single POST.
	capturePOSTTimeout = 2 * time.Minute
	// captureRequestEnv / captureResultEnv override the mailbox file locations
	// (see pkg/wake). They default to the directory holding this host's own
	// config, i.e. the per-machine location the one-click setup already writes,
	// so the broker and the host agree without either of them inventing a path.
	captureRequestEnv = "SPACEWORKER_CLONE_REQUEST"
	captureResultEnv  = "SPACEWORKER_CLONE_RESULT"
	// captureRequestName / captureResultName are the default file names.
	captureRequestName = "capture-request.json"
	captureResultName  = "capture-result.json"
)

// captureConfig is the host's own per-device configuration.
//
//	{ "base_url": "https://spaceworker.top",
//	  "device_id": "…", "live_capture_token": "…", "clone_job_id": "…" }
//
// live_capture_token is the per-device token minted by Path A (A5a) and
// delivered by the one-click setup. It is a device credential: it must never be
// sent as a server-side/internal bearer, embedded in the payload, put in the
// extension, logged, or included in an error message.
type captureConfig struct {
	BaseURL    string `json:"base_url"`
	DeviceID   string `json:"device_id"`
	Token      string `json:"live_capture_token"`
	CloneJobID string `json:"clone_job_id"`
}

// captureState accumulates the chunks of ONE capture, in memory, for the
// lifetime of the native-messaging port. It is deliberately not persisted: a
// partial jar must never be posted, and when the port closes the process exits
// and the memory goes with it.
type captureState struct {
	active     bool
	jobID      string
	browser    string
	capturedAt string
	chunkCount int
	nextIndex  int
	truncated  bool
	cookies    []types.Cookie
	bytes      int
	// pending is the claimed silent-capture request, when this capture came from
	// the mailbox rather than from the popup. Its nonce is what lets the broker
	// match the result to the wake it performed (pkg/wake), so it is carried for
	// the lifetime of the port and never written anywhere else.
	pending *wake.CaptureRequest
}

func (s *captureState) reset() { *s = captureState{} }

// request is a decoded native-messaging message. CaptureChunk is embedded so
// the frozen chunk shape lives in one place (pkg/types) and `go vet` checks it.
type request struct {
	Command     string `json:"command"`
	BrowserType string `json:"browser_type"`
	HostedPcId  string `json:"hosted_pc_id"`
	CloneId     string `json:"clone_id"`
	types.CaptureChunk
}

// response is written back to the browser. The capture members are omitted when
// zero (absent == zero) so the existing clone_browser / get_clone_status replies
// stay byte-identical; nothing here may ever carry a cookie value or a token.
type response struct {
	Status    string `json:"status"`
	CloneId   string `json:"clone_id,omitempty"`
	Progress  string `json:"progress,omitempty"`
	Error     string `json:"error,omitempty"`
	Accepted  int    `json:"accepted,omitempty"`
	Domains   int    `json:"domains,omitempty"`
	Truncated bool   `json:"truncated,omitempty"`
	// CloneJobID / Browser answer poll_capture_request: they tell the service
	// worker WHICH capture to run, and are echoed straight back in the chunks it
	// sends. Neither is a secret; the job id is already in the poll request.
	CloneJobID string `json:"clone_job_id,omitempty"`
	Browser    string `json:"browser,omitempty"`
}

func main() {
	r := bufio.NewReader(os.Stdin)
	var lenBuf [4]byte
	// One capture at a time. The state lives for the lifetime of this process —
	// i.e. of the extension's connectNative port — and is NEVER persisted, so a
	// partial jar cannot outlive the port that was feeding it.
	capture := &captureState{}
	for {
		if _, err := io.ReadFull(r, lenBuf[:]); err != nil {
			// EOF (or a closed pipe): the browser is done with us.
			return
		}
		n := binary.LittleEndian.Uint32(lenBuf[:])
		if n == 0 || n > maxMessageBytes {
			writeMessage(response{Status: "error", Error: "invalid_message_length"})
			continue
		}
		payload := make([]byte, n)
		if _, err := io.ReadFull(r, payload); err != nil {
			return
		}
		handle(payload, capture)
	}
}

// handle decodes one message, dispatches it, and writes the response.
func handle(payload []byte, capture *captureState) {
	var req request
	if err := json.Unmarshal(payload, &req); err != nil {
		writeMessage(response{Status: "error", Error: "invalid_json"})
		return
	}
	switch req.Command {
	case "clone_browser":
		writeMessage(handleClone(req))
	case "get_clone_status":
		writeMessage(handleStatus(req))
	case "capture_cookies":
		// Intermediate chunks get NO reply: the port stays open and the host
		// answers once, when the jar is complete (see the frozen contract).
		if resp, reply := handleCaptureChunk(req, capture); reply {
			writeMessage(resp)
		}
	case "poll_capture_request":
		// TASK_135 — the silent path's trigger. The extension asks; the host
		// answers "capture_requested" or "idle". This is the ONLY way a capture
		// can start without a human, because a native host is started BY the
		// extension and can never push to it.
		writeMessage(handlePollCaptureRequest(capture))
	default:
		writeMessage(response{Status: "error", Error: "unknown_command"})
	}
}

// ---------------------------------------------------------------------------
// TASK_135 — the silent capture mailbox (poll + result)
// ---------------------------------------------------------------------------
//
// Why the extension must ASK and can never be TOLD: a native messaging host is
// started BY the extension, so the host cannot push to it, and an MV3 service
// worker has no listening socket. The extension therefore polls on an alarm, and
// poll_capture_request is what it polls. The whole exchange is shaped by the
// owner's hard condition — no popup, no click, no window, no notification — so
// the user must never learn a capture happened from anything on their screen.
//
// The request is CLAIMED here (single use, time-boxed; see pkg/wake), so a broker
// that walks away mid-wake cannot leave a capture armed for later. "idle" is the
// overwhelmingly common answer and is not an error.

// mailboxPath prefers an env override, then the directory of this host's own
// config (the per-machine dir the one-click setup already writes, so the broker
// and the host agree without either inventing a path), then the current dir.
func mailboxPath(env, name, cfgPath string) string {
	if p := strings.TrimSpace(os.Getenv(env)); p != "" {
		return p
	}
	base := strings.TrimSpace(cfgPath)
	if base == "" {
		return name
	}
	return filepath.Join(filepath.Dir(base), name)
}

// captureConfigFile resolves the first candidate config path, or "".
func captureConfigFile() string {
	if paths := captureConfigPaths(); len(paths) > 0 {
		return paths[0]
	}
	return ""
}

func captureRequestPath(cfgPath string) string {
	return mailboxPath(captureRequestEnv, captureRequestName, cfgPath)
}

func captureResultPath(cfgPath string) string {
	return mailboxPath(captureResultEnv, captureResultName, cfgPath)
}

// handlePollCaptureRequest claims a pending silent-capture request, if any.
func handlePollCaptureRequest(st *captureState) response {
	req, ok, reason := wake.ClaimRequest(captureRequestPath(captureConfigFile()), time.Now().UTC())
	if !ok {
		if reason != "" {
			// Worth reporting once: the file is already gone, so it cannot repeat.
			return response{Status: "error", Error: reason}
		}
		return response{Status: "idle"}
	}
	// Held for the life of the capture: the nonce is what stamps the result the
	// broker is waiting for, and the job id lets finishCapture address the jar
	// even when the broker did not supply one.
	st.pending = &req
	return response{Status: "capture_requested", CloneJobID: req.CloneJobID, Browser: req.Browser}
}

// writeCaptureResult records the COUNTS-ONLY outcome for the broker. Failures
// here are deliberately ignored: the capture has already succeeded or failed, and
// the broker's own deadline is the backstop.
func writeCaptureResult(st *captureState, resp response) {
	if st.pending == nil {
		return
	}
	res := wake.CaptureResult{
		Nonce:     st.pending.Nonce,
		Status:    resp.Status,
		Accepted:  resp.Accepted,
		Domains:   resp.Domains,
		Truncated: resp.Truncated,
		Reason:    resp.Error,
	}
	_ = wake.WriteResult(captureResultPath(captureConfigFile()), res, time.Now().UTC())
}

// handleClone runs the CLI clone command and returns the clone id.
func handleClone(req request) response {
	if req.BrowserType == "" {
		return response{Status: "error", Error: "browser_type_required"}
	}
	out, err := runCLI("clone", "--browser", req.BrowserType, "--include-passwords")
	if err != nil {
		return cliError(out, err)
	}
	cloneID, err := extractCloneID(out)
	if err != nil {
		return response{Status: "error", Error: "invalid_cli_response"}
	}
	return response{Status: "success", CloneId: cloneID}
}

// handleStatus queries the local registry via the CLI status command.
func handleStatus(req request) response {
	if req.CloneId == "" {
		return response{Status: "error", Error: "clone_id_required"}
	}
	out, err := runCLI("status", "--clone-id", req.CloneId)
	if err != nil {
		return cliError(out, err)
	}
	var entry struct {
		Status string `json:"Status"`
	}
	if err := json.Unmarshal([]byte(out), &entry); err != nil {
		return response{Status: "error", Error: errorReason(out, err)}
	}
	switch entry.Status {
	case "active":
		return response{Status: "active"}
	case "ready-for-injection", "injecting":
		return response{Status: "in-progress", Progress: "injecting"}
	case "ready-for-transfer", "transferring", "started":
		return response{Status: "in-progress", Progress: "transferring"}
	case "revoked", "expired", "failed":
		return response{Status: "error", Error: "clone_" + entry.Status}
	default:
		return response{Status: "error", Error: "unknown_status"}
	}
}

// ---------------------------------------------------------------------------
// TASK_119B — capture_cookies: accumulate, then ONE POST
// ---------------------------------------------------------------------------

// handleCaptureChunk validates and accumulates one chunk. The bool reports
// whether a reply must be written: only the FINAL chunk (and any error) is
// answered, because the host posts once the jar is complete.
func handleCaptureChunk(req request, st *captureState) (response, bool) {
	c := req.CaptureChunk
	if c.ChunkCount < 1 || c.ChunkIndex < 0 || c.ChunkIndex >= c.ChunkCount {
		st.reset()
		return response{Status: "error", Error: "invalid_chunk_index"}, true
	}
	switch {
	case c.ChunkIndex == 0:
		st.reset()
		st.active = true
		st.jobID = c.CloneJobID
		st.browser = c.Browser
		st.capturedAt = c.CapturedAt
		st.chunkCount = c.ChunkCount
	case !st.active || c.ChunkIndex != st.nextIndex || c.ChunkCount != st.chunkCount:
		// Out of order, or a second capture interleaved with this one: drop the
		// state rather than post a jar assembled from two different captures.
		st.reset()
		return response{Status: "error", Error: "chunk_out_of_order"}, true
	}

	for _, cookie := range c.Cookies {
		// Size by the marshalled cookie — that is what the cap is about.
		b, err := json.Marshal(cookie)
		if err != nil {
			st.reset()
			return response{Status: "error", Error: "invalid_cookie"}, true
		}
		if st.bytes+len(b) > maxCaptureBytes {
			st.reset()
			return response{Status: "error", Error: "capture_too_large"}, true
		}
		st.bytes += len(b)
		st.cookies = append(st.cookies, cookie)
	}
	st.truncated = st.truncated || c.Truncated
	st.nextIndex = c.ChunkIndex + 1

	if c.ChunkIndex != c.ChunkCount-1 {
		return response{}, false // more chunks coming; stay silent
	}
	defer st.reset()
	return finishCapture(st), true
}

// finishCapture assembles the ONE POST body, sends it, and then records the
// outcome in the mailbox, so a broker that performed a silent wake learns what
// happened at once instead of waiting out its whole deadline. Every failure is a
// named reason; neither the reply nor any log may contain a cookie value or the
// device token.
func finishCapture(st *captureState) response {
	resp := finishCaptureInner(st)
	writeCaptureResult(st, resp)
	return resp
}

// finishCaptureInner does the assembly and the single POST.
func finishCaptureInner(st *captureState) response {
	payload := types.CapturePayload{
		CloneJobID: st.jobID,
		Browser:    st.browser,
		CapturedAt: st.capturedAt,
		Cookies:    st.cookies,
		Truncated:  st.truncated,
	}
	if payload.Browser == "" {
		payload.Browser = types.BrowserChrome
	}
	if payload.CapturedAt == "" {
		payload.CapturedAt = types.NowIso()
	}
	if payload.Cookies == nil {
		// A nil slice marshals as `null`, but the contract says an ARRAY: an
		// empty capture must still be a well-formed payload (the route refuses
		// on 0 cookies with a named reason — it must not first fail to parse).
		payload.Cookies = []types.Cookie{}
	}

	// Harness mode: write the exact POST body to a 0600 temp file instead of
	// posting it, so capture is provable with the server route undeployed.
	if out := strings.TrimSpace(os.Getenv(capturePayloadOutEnv)); out != "" {
		if err := writeCapturePayload(out, payload); err != nil {
			return response{Status: "error", Error: "payload_write_failed"}
		}
		return captureReply(payload)
	}

	cfg, code := loadCaptureConfig()
	if code != "" {
		return response{Status: "error", Error: code}
	}
	if payload.CloneJobID == "" {
		payload.CloneJobID = cfg.CloneJobID // the one-click setup records it
	}
	if payload.CloneJobID == "" {
		return response{Status: "error", Error: "clone_job_id_required"}
	}
	payload.DeviceID = cfg.DeviceID
	return postCapture(cfg, payload)
}

// captureReply is the counts-only success answer (never a value, never a name).
func captureReply(payload types.CapturePayload) response {
	return response{
		Status:    "success",
		Accepted:  len(payload.Cookies),
		Domains:   types.DomainCount(payload.Cookies),
		Truncated: payload.Truncated,
	}
}

// writeCapturePayload writes the assembled POST body with 0600. This is the
// harness's proof that capture works end-to-end without Path A; the harness
// deletes the file at the end of the run.
func writeCapturePayload(path string, payload types.CapturePayload) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	return os.WriteFile(path, body, 0o600)
}

// postCapture makes the ONE POST to the device-facing capture route, using the
// host's own installed PER-DEVICE token. The token travels in the Authorization
// header only — never in the payload, never in the extension — and the server's
// response body is never echoed back (the rule is structural, not optimistic).
func postCapture(cfg captureConfig, payload types.CapturePayload) response {
	body, err := json.Marshal(payload)
	if err != nil {
		return response{Status: "error", Error: "encode_failed"}
	}
	base := strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/")
	if base == "" {
		base = defaultBaseURL
	}
	req, err := http.NewRequest(http.MethodPost, base+cloneCapturePath, bytes.NewReader(body))
	if err != nil {
		return response{Status: "error", Error: "capture_request_failed"}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	req.Header.Set("User-Agent", "spaceworker-native-host")

	client := &http.Client{Timeout: capturePOSTTimeout}
	resp, err := client.Do(req)
	if err != nil {
		// Deliberately not wrapping err: its text is not needed to act on the
		// failure, and no transport detail belongs in an error we hand back.
		return response{Status: "error", Error: "capture_post_failed"}
	}
	defer resp.Body.Close()
	// Drain (bounded) and ignore: the reply is a count, and nothing from it may
	// be surfaced verbatim.
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return response{Status: "error", Error: "capture_rejected_http_" + types.Itoa(resp.StatusCode)}
	}
	return captureReply(payload)
}

// loadCaptureConfig reads the host's own config file and returns a NAMED error
// code (never a wrapped OS error, never the token). The raw token is only ever
// handed to postCapture, which puts it in the Authorization header.
func loadCaptureConfig() (captureConfig, string) {
	for _, path := range captureConfigPaths() {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		if runtime.GOOS != "windows" {
			// The file holds a device credential, so it must be 0600 where POSIX
			// modes exist. Windows inherits the install-dir ACL instead
			// (scripts/set-acls.ps1) and reports 0666 for every file.
			if fi, statErr := os.Stat(path); statErr == nil && fi.Mode().Perm()&0o077 != 0 {
				return captureConfig{}, "device_config_insecure"
			}
		}
		var cfg captureConfig
		if err := json.Unmarshal(data, &cfg); err != nil {
			return captureConfig{}, "device_config_invalid"
		}
		if strings.TrimSpace(cfg.Token) == "" {
			return captureConfig{}, "device_token_missing"
		}
		if strings.TrimSpace(cfg.DeviceID) == "" {
			return captureConfig{}, "device_id_missing"
		}
		return cfg, ""
	}
	return captureConfig{}, "device_config_missing"
}

// captureConfigPaths resolves the config file: an explicit override first (the
// harness, or a scripted install), then next to the host binary, then the
// standard install locations.
func captureConfigPaths() []string {
	if p := strings.TrimSpace(os.Getenv(captureConfigEnv)); p != "" {
		return []string{p}
	}
	var paths []string
	if exe, err := os.Executable(); err == nil {
		paths = append(paths, filepath.Join(filepath.Dir(exe), captureConfigName))
	}
	if runtime.GOOS == "windows" {
		paths = append(paths,
			filepath.Join(`C:\ProgramData\TacticalRMM\CloneTool`, captureConfigName),
			filepath.Join(`C:\Program Files\TacticalRMM`, captureConfigName),
		)
	} else if dir, err := os.UserConfigDir(); err == nil {
		paths = append(paths, filepath.Join(dir, "spaceworker", captureConfigName))
	}
	return paths
}

// cliError maps a failed CLI invocation to the directive §10 error strings.
func cliError(out string, err error) response {
	if err == nil {
		return response{Status: "error", Error: "unknown_error"}
	}
	if errors.Is(err, exec.ErrNotFound) {
		return response{Status: "error", Error: "rmm_agent_unavailable"}
	}
	msg := strings.TrimSpace(out)
	switch {
	case strings.Contains(msg, "ErrBrowserNotFound"), strings.Contains(msg, "ErrNotSupported"):
		return response{Status: "error", Error: "browser_not_found"}
	case strings.Contains(msg, "ErrProfileLocked"):
		return response{Status: "error", Error: "profile_locked"}
	case strings.Contains(msg, "ErrMeshUnavailable"):
		return response{Status: "error", Error: "network_unavailable"}
	case strings.Contains(msg, "ErrKeyNotFound"):
		return response{Status: "error", Error: "clone_not_found"}
	}
	return response{Status: "error", Error: "rmm_agent_unavailable"}
}

// errorReason is a fallback for parse failures of the status payload.
func errorReason(out string, _ error) string {
	if s := strings.TrimSpace(out); s != "" {
		return s
	}
	return "invalid_cli_response"
}

// extractCloneID pulls the clone_id out of the CLI's "clone ready" output:
//
//	clone ready for transfer:
//	{
//	  "clone_id": "uuid",
//	  ...
//	}
func extractCloneID(out string) (string, error) {
	i := strings.IndexByte(out, '{')
	if i < 0 {
		return "", fmt.Errorf("no JSON object in CLI output")
	}
	var doc struct {
		CloneId string `json:"clone_id"`
	}
	if err := json.Unmarshal([]byte(out[i:]), &doc); err != nil {
		return "", err
	}
	if doc.CloneId == "" {
		return "", fmt.Errorf("empty clone_id")
	}
	return doc.CloneId, nil
}

// runCLI executes the hack-browser-clone CLI with args and returns its
// combined output.
func runCLI(args ...string) (string, error) {
	exe := cliPath()
	cmd := exec.Command(exe, args...)
	var out strings.Builder
	cmd.Stdout = &out
	cmd.Stderr = &out
	// Never let a spawned CLI open a console window on Windows: routed
	// through pkg/procattr so every spawn site shares one implementation.
	procattr.Quiet(cmd)
	if err := cmd.Run(); err != nil {
		return strings.TrimSpace(out.String()), err
	}
	return strings.TrimSpace(out.String()), nil
}

// cliPath prefers the CLI deployed next to this executable, then PATH.
func cliPath() string {
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		for _, name := range []string{"hack-browser-clone", "spaceworker-browser-clone"} {
			cand := filepath.Join(dir, name)
			if runtime.GOOS == "windows" {
				cand += ".exe"
			}
			if _, err := os.Stat(cand); err == nil {
				return cand
			}
		}
	}
	return "hack-browser-clone"
}

// hideWindow silences the spawned CLI on Windows (the native host itself is
// a GUI-subsystem binary so it never owns a console). Delegates to the
// shared procattr helper used across the tooling.
func hideWindow(cmd *exec.Cmd) { procattr.Quiet(cmd) }

// writeMessage writes a response with the native-messaging length prefix.
func writeMessage(r response) {
	data, err := json.Marshal(r)
	if err != nil {
		data = []byte(`{"status":"error","error":"encode_failed"}`)
	}
	var lenBuf [4]byte
	binary.LittleEndian.PutUint32(lenBuf[:], uint32(len(data)))
	_, _ = os.Stdout.Write(lenBuf[:])
	_, _ = os.Stdout.Write(data)
	_ = os.Stdout.Sync()
}
