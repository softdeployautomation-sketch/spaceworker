// Package wake, state half: carrying a browser PROFILE's state off the work PC
// and into the clone.
//
// The session half (cookies) is read by the extension inside the browser and is
// tiny. This half is the opposite: tens of megabytes of files, which is why it is
// fingerprinted, filtered, and (on a reconnect) sent as a delta.
//
// THE HARD RULES THIS FILE EXISTS TO SATISFY
//
//  1. COMPLETELY SILENT. Nothing here spawns a process, opens a window, shows a
//     dialog or blocks on input — it is file IO and one HTTPS POST. The source
//     browser may be CLOSED, or open, or mid-write; all three are fine, because a
//     file that cannot be read is reported as a named skip rather than retried
//     forever or surfaced to the user. There is no prompt anywhere in this path,
//     which is the whole point: the traveller's PC is unattended.
//
//  2. AV EXCLUSION. This binary only ever runs from, and writes state under,
//     directories that `preflight` has registered AND VERIFIED as excluded from
//     endpoint protection (cmd/hack-browser-clone/main.go → runPreflight). A
//     Defender quarantine mid-transfer would look exactly like a network fault,
//     so the exclusion is a precondition of running at all, not a nicety.
//
//  3. NOTHING SENSITIVE LEAVES. Passwords, the cookie jar and the ABE key store
//     are refused by name (sensitives.go), on both sides of the wire.
package wake

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// StatePathPlan is the server's answer to "what do you need?". Full means "send
// everything you can read"; delta means only the listed paths.
type StatePathPlan struct {
	Mode           string   `json:"mode"`
	Reason         string   `json:"reason"`
	RequestedPaths []string `json:"requested_paths"`
	// RemovedPaths are files the source no longer has. They are ECHOED BACK at
	// finalize rather than deleted at plan time, so the destructive half only
	// happens once the replacement bytes have actually landed.
	RemovedPaths []string `json:"removed_paths"`
	CachedFiles  int      `json:"cached_files"`
}

// StateUploadResult reports what actually crossed the wire, in counts and bytes
// only — never a path list and never a file's content.
type StateUploadResult struct {
	// Sent is the number of files whose bytes were POSTed successfully.
	Sent int `json:"sent"`
	// Bytes is the total payload size.
	Bytes int64 `json:"bytes"`
	// Skipped is every file refused, with a named reason.
	Skipped []CloneStateFilter `json:"skipped,omitempty"`
	// Mode and Reason are the server's decision, echoed for the record.
	Mode   string `json:"mode,omitempty"`
	Reason string `json:"reason,omitempty"`
	// Removed is how many stale paths the server deleted to keep the replica true.
	Removed int `json:"removed,omitempty"`
	// Pending is how many selected files were NOT sent because this run's budget
	// ran out. Non-zero means the replica is incomplete and a LATER run must
	// continue — which it can, cheaply, because the server already holds what did
	// land and fingerprints it (see Done).
	Pending int `json:"pending,omitempty"`
	// Done is true when every selected file was sent. A caller must treat a
	// non-done result as "more to come", never as a finished sync: reporting a
	// partial transfer as complete is how a replica silently loses bookmarks.
	// Done is also true when there was nothing to send at all.
	Done bool `json:"done"`
	// Failed is a named transport failure; the caller records it and moves on.
	Failed string `json:"failed,omitempty"`
}

// Named reasons for this half. Stable strings that end up in the audit trail, so
// they say what happened without describing the machine.
const (
	ReasonStateProfileMissing = "state_profile_missing"
	ReasonStatePlanFailed     = "state_plan_failed"
	ReasonStateUploadFailed   = "state_upload_failed"
	ReasonStateTooLarge       = "state_file_too_large"
	ReasonStateFileUnreadable = "state_file_unreadable"
	ReasonStateFinalizeFailed = "state_finalize_failed"
	// ReasonStateDigestFailed is reported when a collected file could not be
	// hashed. It is a WARNING, not a refusal: the file is still carried, with the
	// weaker size+mtime comparison (see fillDigests).
	ReasonStateDigestFailed = "state_digest_unavailable"
)

// DefaultStateFileMaxBytes is the per-file ceiling, matching the server's own cap
// (app/api/devices/clone-state/route.ts). A file above it is skipped BY NAME: a
// 2 GB file in a profile is not state, and silently truncating one would make the
// replica quietly wrong instead of loudly incomplete.
const DefaultStateFileMaxBytes = 256 * 1024 * 1024

// StateFile is one profile file selected for transfer.
type StateFile struct {
	Fingerprint FileFingerprint
	// Abs is the absolute source path. Never sent, never logged.
	Abs string
}

// CollectStateFiles walks a profile directory and returns the files that may be
// carried, plus every file refused with a reason.
//
// Deliberately conservative:
//   - only REGULAR files (a symlink or reparse point could point anywhere, and a
//     device has no legitimate reason to send one);
//   - names refused by the shared exclusion list (passwords, the cookie jar, the
//     ABE key store, lock files) and paths that escape the profile root;
//   - files above maxBytes, and files whose stat fails, are REPORTED, not dropped.
//
// An error on a SUBDIRECTORY does not abandon the transfer: a profile can contain
// a directory another process holds, and losing the whole sync to that would be
// worse than carrying everything else and naming the one failure.
func CollectStateFiles(profileDir string, maxBytes int64) ([]StateFile, []CloneStateFilter) {
	if maxBytes <= 0 {
		maxBytes = DefaultStateFileMaxBytes
	}
	root, err := filepath.Abs(profileDir)
	if err != nil {
		return nil, []CloneStateFilter{{Path: ".", Reason: "state_profile_unresolved"}}
	}
	if st, err := os.Stat(root); err != nil || !st.IsDir() {
		return nil, []CloneStateFilter{{Path: ".", Reason: ReasonStateProfileMissing}}
	}

	var kept []StateFile
	var dropped []CloneStateFilter

	walkErr := filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		rel, relErr := filepath.Rel(root, p)
		if relErr != nil {
			rel = p
		}
		// The manifest speaks ONE dialect: forward slashes, profile-relative.
		// Windows separators are normalised here so the server never sees two
		// spellings of one file.
		relSlash := strings.ReplaceAll(rel, string(os.PathSeparator), "/")
		if relSlash == "." {
			return nil
		}
		if err != nil {
			dropped = append(dropped, CloneStateFilter{Path: relSlash, Reason: ReasonStateFileUnreadable})
			// WalkDir already skips an unreadable directory's contents.
			return nil
		}
		if d.IsDir() {
			// A directory is not a state file, but it IS where the walk goes next.
			// Its own name is still checked, so a path that escapes the root, or a
			// refused name, cannot be descended INTO.
			if err := CloneStatePathSafe(relSlash); err != nil {
				dropped = append(dropped, CloneStateFilter{Path: relSlash, Reason: err.Error()})
				return filepath.SkipDir
			}
			return nil
		}
		if err := CloneStatePathSafe(relSlash); err != nil {
			dropped = append(dropped, CloneStateFilter{Path: relSlash, Reason: err.Error()})
			return nil
		}
		if reason, excluded := CloneStateFileExcluded(relSlash); excluded {
			dropped = append(dropped, CloneStateFilter{Path: relSlash, Reason: reason})
			return nil
		}
		info, statErr := d.Info()
		if statErr != nil {
			dropped = append(dropped, CloneStateFilter{Path: relSlash, Reason: ReasonStateFileUnreadable})
			return nil
		}
		if !info.Mode().IsRegular() {
			dropped = append(dropped, CloneStateFilter{Path: relSlash, Reason: "state_path_not_a_regular_file"})
			return nil
		}
		if info.Size() > maxBytes {
			dropped = append(dropped, CloneStateFilter{Path: relSlash, Reason: ReasonStateTooLarge})
			return nil
		}
		kept = append(kept, StateFile{
			Fingerprint: FileFingerprint{
				Path:    relSlash,
				Size:    info.Size(),
				ModTime: info.ModTime().Unix(),
			},
			Abs: p,
		})
		return nil
	})
	if walkErr != nil {
		dropped = append(dropped, CloneStateFilter{Path: ".", Reason: ReasonStateFileUnreadable})
	}

	// Deterministic order: the manifest is compared by the server and stored as
	// JSON, so an unstable order would make every diff look like a change.
	sort.Slice(kept, func(i, j int) bool { return kept[i].Fingerprint.Path < kept[j].Fingerprint.Path })
	return kept, dropped
}

// SelectStateFiles narrows a collected set to what the server asked for.
//
// A FULL plan (or an unrecognised one) means everything: the server asked for no
// specific paths, which is the only safe reading of "full". A DELTA returns only
// the requested paths, matched case-insensitively on the forward-slash spelling,
// and every requested path that is NOT in the collected set is returned as a
// refusal — that is how "the server wants a file we can no longer read" becomes
// visible instead of silently absent from the replica.
func SelectStateFiles(collected []StateFile, plan StatePathPlan) ([]StateFile, []CloneStateFilter) {
	if plan.Mode != SyncModeDelta || len(plan.RequestedPaths) == 0 {
		return collected, nil
	}
	want := make(map[string]struct{}, len(plan.RequestedPaths))
	for _, p := range plan.RequestedPaths {
		want[pathKey(p)] = struct{}{}
	}
	var out []StateFile
	for _, f := range collected {
		if _, ok := want[pathKey(f.Fingerprint.Path)]; ok {
			out = append(out, f)
		}
	}
	have := make(map[string]struct{}, len(out))
	for _, f := range out {
		have[pathKey(f.Fingerprint.Path)] = struct{}{}
	}
	var missing []CloneStateFilter
	for _, p := range plan.RequestedPaths {
		if _, ok := have[pathKey(p)]; !ok {
			missing = append(missing, CloneStateFilter{Path: p, Reason: "state_requested_file_missing"})
		}
	}
	sort.Slice(missing, func(i, j int) bool { return missing[i].Path < missing[j].Path })
	return out, missing
}

// pathKey is the comparison spelling: forward slashes, lower case — the same rule
// the server's own normaliser uses, so a path cannot be "requested" under one
// spelling and "sent" under another.
func pathKey(p string) string {
	return strings.ToLower(strings.TrimSpace(strings.ReplaceAll(p, "\\", "/")))
}

// fillDigests adds the content hash to every collected file, best effort.
//
// WHY THIS RUNS AT ALL. Without a hash the only comparison available is size +
// mtime, and mtime is worthless across the wire: the server writes each staged
// file at the moment it receives it, so its stored mtime is a server clock value
// that can never equal the source's. Every file would then look "changed" on the
// next run, and a transfer interrupted by the run-command timeout would re-send
// its whole self forever instead of converging. With the hash on both sides,
// `sameFile` compares content and an already-landed file is skipped — which is
// what makes a multi-minute first clone resumable at all.
//
// A file that cannot be hashed is NOT dropped: it keeps size+mtime and is sent
// normally. Hashing can fail on a file the browser holds open, and refusing to
// carry a bookmark over a transient lock would be worse than a weaker
// comparison. The failure is reported by name so it is visible, not guessed at.
func fillDigests(files []StateFile) []CloneStateFilter {
	var failed []CloneStateFilter
	for i := range files {
		digest, err := FileDigest(files[i].Abs)
		if err != nil {
			failed = append(failed, CloneStateFilter{
				Path:   files[i].Fingerprint.Path,
				Reason: ReasonStateDigestFailed,
			})
			continue
		}
		files[i].Fingerprint.SHA256 = digest
	}
	return failed
}

// FileDigest is the optional authoritative fingerprint. It is computed only when
// asked for, because hashing a whole profile on every clone costs more than the
// transfer it would save.
func FileDigest(abs string) (string, error) {
	f, err := os.Open(abs)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// StateSyncOptions is everything SyncState needs. No globals, so the whole flow is
// testable against a stand-in HTTP server.
type StateSyncOptions struct {
	// BaseURL is the Spaceworker origin, e.g. https://app.example.com.
	BaseURL string
	// Token is the device's bearer token (Device.liveCaptureTokenHash's preimage).
	Token string
	// Client, if nil, is a 120s-timeout client. A whole-profile POST can be slow,
	// but a hung socket must never hold a clone open forever.
	Client *http.Client
	// CloneJobID identifies the job this state belongs to.
	CloneJobID string
	// DeviceID must match the token's device, or the server refuses.
	DeviceID string
	// Browser is the lowercase family: chrome, edge, chromium, brave.
	Browser string
	// ProfileName is the Chromium profile directory ("Default", "Profile 1").
	ProfileName string
	// Version is the source browser's full version, recorded on the manifest.
	Version string
	// ProfileDir is the profile root to collect from.
	ProfileDir string
	// MaxFileBytes overrides DefaultStateFileMaxBytes.
	MaxFileBytes int64
	// Budget bounds how long this run spends SENDING files. Zero means no bound.
	//
	// WHY A BUDGET EXISTS. The platform runs this over its own run-command path,
	// which kills a command that outlives its timeout, and a first clone of a real
	// profile (history, favicons, extensions) takes longer than that. Without a
	// budget the command is killed mid-request: the transfer stops at an arbitrary
	// point AND the caller gets no result to record, so a partial replica is
	// indistinguishable from a failed one. With a budget the run stops at a file
	// boundary, reports how many files are still outstanding, and lets the caller
	// ask again — each later run sends only what has not landed.
	Budget time.Duration
	// Now is injectable so a manifest's capturedAt is testable.
	Now func() time.Time
}

// SyncState carries one profile's state to the server, in three requests:
// declare → send → close.
//
// IT NEVER RETURNS AN ERROR, and that is deliberate. This runs inside a silent
// capture on a machine nobody is watching; a failure must be a NAMED FIELD on the
// result so the caller can record it and let the clone continue with whatever did
// arrive. Returning an error would tempt a caller into aborting a clone whose
// session half (cookies) already succeeded.
func SyncState(ctx context.Context, opts StateSyncOptions) StateUploadResult {
	var res StateUploadResult
	profile := strings.TrimSpace(opts.ProfileName)
	if profile == "" {
		profile = "Default"
	}
	maxBytes := opts.MaxFileBytes
	if maxBytes <= 0 {
		maxBytes = DefaultStateFileMaxBytes
	}
	client := opts.Client
	if client == nil {
		client = &http.Client{Timeout: 120 * time.Second}
	}
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	base := strings.TrimRight(strings.TrimSpace(opts.BaseURL), "/")
	if base == "" || opts.Token == "" || opts.CloneJobID == "" || opts.DeviceID == "" {
		res.Failed = ReasonStatePlanFailed
		return res
	}

	collected, dropped := CollectStateFiles(opts.ProfileDir, maxBytes)
	res.Skipped = append(res.Skipped, dropped...)
	if len(collected) == 0 {
		// Nothing to send. Reported by name when the PROFILE itself was missing,
		// because "the profile path is wrong" and "the profile is empty" are
		// different problems and only one of them is a misconfiguration.
		for _, d := range dropped {
			if d.Reason == ReasonStateProfileMissing {
				res.Failed = ReasonStateProfileMissing
				res.Mode = ""
				return res
			}
		}
	}

	// Hashes are added BEFORE the plan is posted, because the server compares
	// them: a run that resumes an interrupted transfer is only cheap if both
	// sides describe a file the same way.
	res.Skipped = append(res.Skipped, fillDigests(collected)...)

	plan, err := postStatePlan(ctx, client, base, opts, profile, collected, now())
	if err != nil {
		res.Failed = ReasonStatePlanFailed
		return res
	}
	res.Mode, res.Reason = plan.Mode, plan.Reason

	// Nothing to do is DONE, not "no result": an already-current replica must
	// report success so the caller has no reason to run again.
	res.Done = true

	if len(collected) > 0 {
		selected, missing := SelectStateFiles(collected, plan)
		res.Skipped = append(res.Skipped, missing...)
		started := now()
		for i, f := range selected {
			// Checked BEFORE each file, never mid-file: a file is either posted
			// whole or not at all, so stopping on the boundary can never leave a
			// half-written file in the replica.
			if opts.Budget > 0 && now().Sub(started) >= opts.Budget {
				res.Pending = len(selected) - i
				break
			}
			n, err := postStateFile(ctx, client, base, opts, profile, f)
			if err != nil {
				res.Skipped = append(res.Skipped, CloneStateFilter{
					Path:   f.Fingerprint.Path,
					Reason: ReasonStateUploadFailed,
				})
				continue
			}
			res.Sent++
			res.Bytes += n
		}
		res.Done = res.Pending == 0
	}

	// Finalize runs even when the budget stopped the run, and that is the point:
	// it stores what the cache ACTUALLY holds as the next baseline, so the next
	// run's plan is a delta of exactly the files still missing. Skipping it would
	// leave this run's landed bytes with no record, and the next run would send
	// them all again.
	removed, err := postStateFinalize(ctx, client, base, opts, profile, plan.RemovedPaths, now())
	if err != nil {
		res.Failed = ReasonStateFinalizeFailed
		return res
	}
	res.Removed = removed
	return res
}

// ------------------------------------------------------------------ the requests

type planRequest struct {
	CloneJobID string            `json:"cloneJobId"`
	DeviceID   string            `json:"deviceId"`
	Browser    string            `json:"browser"`
	Profile    string            `json:"profile"`
	Version    string            `json:"version,omitempty"`
	CapturedAt string            `json:"capturedAt"`
	Files      []FileFingerprint `json:"files"`
}

type finalizeRequest struct {
	CloneJobID string   `json:"cloneJobId"`
	DeviceID   string   `json:"deviceId"`
	Browser    string   `json:"browser"`
	Profile    string   `json:"profile"`
	Version    string   `json:"version,omitempty"`
	CapturedAt string   `json:"capturedAt"`
	Removed    []string `json:"removed"`
}

// postStatePlan declares the fingerprints and returns the server's decision.
func postStatePlan(
	ctx context.Context,
	client *http.Client,
	base string,
	opts StateSyncOptions,
	profile string,
	files []StateFile,
	now time.Time,
) (StatePathPlan, error) {
	fps := make([]FileFingerprint, 0, len(files))
	for _, f := range files {
		fps = append(fps, f.Fingerprint)
	}
	body := planRequest{
		CloneJobID: opts.CloneJobID,
		DeviceID:   opts.DeviceID,
		Browser:    strings.ToLower(strings.TrimSpace(opts.Browser)),
		Profile:    profile,
		Version:    opts.Version,
		CapturedAt: now.UTC().Format(time.RFC3339),
		Files:      fps,
	}
	var plan StatePathPlan
	if err := postJSON(ctx, client, base+"/api/devices/clone-state?stage=plan", opts.Token, body, &plan); err != nil {
		return StatePathPlan{}, err
	}
	return plan, nil
}

// postStateFile sends ONE file's bytes.
//
// The path rides in a URL-encoded HEADER and the body is raw octet-stream: a
// profile path can contain spaces and backslashes, and a query string is not a
// safe place for either. Content-Length is set explicitly so the server can refuse
// an over-size body BEFORE reading it.
func postStateFile(
	ctx context.Context,
	client *http.Client,
	base string,
	opts StateSyncOptions,
	profile string,
	f StateFile,
) (int64, error) {
	blob, err := os.ReadFile(f.Abs)
	if err != nil {
		return 0, err
	}
	req, err := http.NewRequestWithContext(
		ctx, http.MethodPost, base+"/api/devices/clone-state?stage=file", bytes.NewReader(blob),
	)
	if err != nil {
		return 0, err
	}
	req.Header.Set("content-type", "application/octet-stream")
	req.Header.Set("content-length", strconv.FormatInt(int64(len(blob)), 10))
	req.Header.Set("x-sw-clone-job", opts.CloneJobID)
	req.Header.Set("x-sw-browser", strings.ToLower(strings.TrimSpace(opts.Browser)))
	req.Header.Set("x-sw-profile", profile)
	// url.QueryEscape, and deliberately NOT PathEscape: a Windows profile path
	// contains backslashes, and QueryEscape is the encoding that survives every
	// intermediary for an opaque value like this.
	req.Header.Set("x-sw-profile-path", url.QueryEscape(f.Fingerprint.Path))
	req.Header.Set("authorization", "Bearer "+opts.Token)

	return doState(req, client, int64(len(blob)))
}

// postStateFinalize closes the transfer. The removals are echoed back from the
// plan, so the destructive half happens only after the bytes have landed — a
// device that dies mid-transfer must never leave the replica with a file deleted
// and no replacement.
func postStateFinalize(
	ctx context.Context,
	client *http.Client,
	base string,
	opts StateSyncOptions,
	profile string,
	removed []string,
	now time.Time,
) (int, error) {
	if removed == nil {
		removed = []string{}
	}
	body := finalizeRequest{
		CloneJobID: opts.CloneJobID,
		DeviceID:   opts.DeviceID,
		Browser:    strings.ToLower(strings.TrimSpace(opts.Browser)),
		Profile:    profile,
		Version:    opts.Version,
		CapturedAt: now.UTC().Format(time.RFC3339),
		Removed:    removed,
	}
	var out struct {
		Removed int `json:"removed"`
	}
	if err := postJSON(ctx, client, base+"/api/devices/clone-state?stage=finalize", opts.Token, body, &out); err != nil {
		return 0, err
	}
	return out.Removed, nil
}

// postJSON performs one small, authenticated JSON request.
func postJSON(ctx context.Context, client *http.Client, url, token string, in any, out any) error {
	blob, err := json.Marshal(in)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(blob))
	if err != nil {
		return err
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("authorization", "Bearer "+token)
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()

	// The reply is read with a hard ceiling. A refusal body may name a policy
	// reason, and none of it is ever echoed to a log or a user — but the STATUS is
	// what decides, and the body is only parsed for a 2xx.
	reply, err := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	if err != nil {
		return err
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return fmt.Errorf("clone-state: HTTP %d", res.StatusCode)
	}
	if out == nil {
		return nil
	}
	// A 2xx that cannot be parsed is an ERROR, not a zero value. A zero plan reads
	// as "full transfer", which is safe but would be recorded as a decision the
	// server never made — so it is reported as the anomaly it is.
	if err := json.Unmarshal(reply, out); err != nil {
		return fmt.Errorf("clone-state: unreadable reply")
	}
	return nil
}

// doState performs the file POST and discards the reply body, returning the bytes
// actually sent. A non-2xx is an error so the caller records the file as skipped.
func doState(req *http.Request, client *http.Client, sent int64) (int64, error) {
	res, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 1<<20))
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return 0, fmt.Errorf("clone-state file: HTTP %d", res.StatusCode)
	}
	return sent, nil
}
