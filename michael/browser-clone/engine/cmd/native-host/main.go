// Command native-host is the Chrome/Edge native messaging host bridge
// (directive §10). It is launched by the browser with no console (build it
// with -ldflags "-H windowsgui" on Windows) and must never be visible;
// it reads length-prefixed JSON messages from stdin and writes the JSON
// response to stdout using the same framing.
//
// The host implements two commands:
//
//	{ "command": "clone_browser", "browser_type": "brave", "hosted_pc_id": "..." }
//	→ { "status": "success", "clone_id": "..." }
//
//	{ "command": "get_clone_status", "clone_id": "..." }
//	→ { "status": "in-progress", "progress": "transferring|injecting" }
//	→ { "status": "active" }
//	→ { "status": "error", "error": "..." }
//
// Work is delegated to the hack-browser-clone CLI (expected next to this
// binary, or on PATH), which keeps the RMM-agent surface identical for both
// the extension path and the remote-admin path.
package main

import (
	"bufio"
	"encoding/binary"
	"encoding/json"

	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"spaceworker.browser-clone/pkg/procattr"
)

// maxMessageBytes caps a single native-messaging message (1 MiB is far more
// than any command payload we emit; profile data never flows through here).
const maxMessageBytes = 1 << 20

// request is a decoded native-messaging message.
type request struct {
	Command     string `json:"command"`
	BrowserType string `json:"browser_type"`
	HostedPcId  string `json:"hosted_pc_id"`
	CloneId     string `json:"clone_id"`
}

// response is written back to the browser.
type response struct {
	Status   string `json:"status"`
	CloneId  string `json:"clone_id,omitempty"`
	Progress string `json:"progress,omitempty"`
	Error    string `json:"error,omitempty"`
}

func main() {
	r := bufio.NewReader(os.Stdin)
	var lenBuf [4]byte
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
		handle(payload)
	}
}

// handle decodes one message, dispatches it, and writes the response.
func handle(payload []byte) {
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
	default:
		writeMessage(response{Status: "error", Error: "unknown_command"})
	}
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
