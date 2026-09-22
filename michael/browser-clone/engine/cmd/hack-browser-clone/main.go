// Command hack-browser-clone is the CLI entry point of the Spaceworker
// Browser Clone system (directive "Code Structure"). It runs the whole
// pipeline on the work PC and the hosted PC:
//
//	list                 list detected browsers (Week 1 deliverable)
//	detect --browser X   show one detected browser + profile path
//	clone                extract + encrypt passwords + bundle + register
//	package/send         emit the parcel (bundle artifact set)
//	receive              validate + stage an incoming parcel (hosted PC)
//	inject               mount the staged clone into the profile (hosted PC)
//	status / status-all  registry lookup for a clone
//	revoke               tear down a clone (hosted PC)
//	expire               sweep expired clones (hosted PC)
//	audit                show / prune audit logs
//
// On the work PC every operation is silent by design (directive "Non-Negotiable
// UX Constraint"); the CLI is the admin/RMM-side interface.
package main

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"spaceworker.browser-clone/pkg/audit"
	"spaceworker.browser-clone/pkg/browser"
	"spaceworker.browser-clone/pkg/bundler"
	"spaceworker.browser-clone/pkg/crypto"
	"spaceworker.browser-clone/pkg/extractor"
	"spaceworker.browser-clone/pkg/injection"
	"spaceworker.browser-clone/pkg/lifecycle"
	"spaceworker.browser-clone/pkg/procattr"
	"spaceworker.browser-clone/pkg/registry"
	"spaceworker.browser-clone/pkg/transport"
	"spaceworker.browser-clone/pkg/types"
)

const version = "0.1.0"

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	cmd := os.Args[1]
	args := os.Args[2:]
	var err error
	switch cmd {
	case "list", "ls":
		err = cmdList(args)
	case "detect":
		err = cmdDetect(args)
	case "clone":
		err = cmdClone(args)
	case "package", "send":
		err = cmdSend(args)
	case "receive":
		err = cmdReceive(args)
	case "serve":
		err = cmdServe(args)
	case "provision-key":
		err = cmdProvisionKey(args)
	case "show-key":
		err = cmdShowKey(args)
	case "inject":
		err = cmdInject(args)
	case "launch":
		err = cmdLaunch(args)
	case "preflight":
		err = cmdPreflight(args)
	case "status":
		err = cmdStatus(args)
	case "status-all":
		err = cmdStatusAll(args)
	case "revoke":
		err = cmdRevoke(args)
	case "expire":
		err = cmdExpire(args)
	case "audit":
		err = cmdAudit(args)
	case "-v", "--version", "version":
		fmt.Printf("hack-browser-clone %s\n", version)
		return
	case "-h", "--help", "help":
		usage()
		return
	default:
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Print(`usage: hack-browser-clone <command> [flags]

commands:
  list                    list detected browsers
  detect --browser X      show profile info for one browser
  clone --browser X       extract profile, encrypt passwords, bundle
      [--include-passwords] [--expires-days N] [--out DIR] [--profile PATH]
      [--source-pc NAME] [--egress-proxy HOST:PORT]
  send --clone-id ID      stream the clone to the hosted PC (§6 chunks)
      [--endpoint http://HOST:PORT] or materialise the parcel [--out DIR]
  receive --parcel DIR    validate + stage a parcel (hosted PC)
      [--staging-root DIR] [--host-browser TYPE] [--host-browser-version V]
  serve                   hosted-PC §6 HTTP receiver (POST /rmm/inject-clone)
      [--addr :8080] [--staging-root DIR] [--host-browser TYPE]
      [--host-browser-version V]
  provision-key --clone-id ID --key B64
                          store the transport key out-of-band on the hosted
                          PC (stand-in for the control-plane key exchange)
  show-key --clone-id ID  print the transport key (base64) from the local
                          registry - the operator-side half of the dev/test
                          key exchange (production: control-plane)
  inject --clone-id ID    mount staged clone (hosted PC)
      [--force] [--dry-run] [--staging-root DIR] [--profile PATH] [--host-sid SID]
      [--owner UID:GID (POSIX hosted servers: hand the profile to a user)]
  launch --clone-id ID    start the host browser on the injected clone (§7
      activation) [--staging-root DIR] [--profile PATH] [--display :0]
  preflight --dir DIR     quarantine the install folder BEFORE the binary is
      installed there (Windows: Defender path+process exclusions; POSIX:
      owner-only 0700). [--exe BINARY-NAME] selects the process-exclusion
      name (default hack-browser-clone.exe, e.g. --exe hack-relay.exe for
      the relay). Install scripts abort when this fails.
  status --clone-id ID    show one clone's registry entry [--staging-root DIR]
  status-all              list all registry entries
  revoke --clone-id ID    tear down a clone (hosted PC)
      [--staging-root DIR]
  expire                  sweep clones past expiry (hosted PC)
      [--staging-root DIR]
  audit --days N          show audit log (or purge with --prune)
  version                 print version
`)
}

func usageErr(msg string) error { return fmt.Errorf("usage: %s (see --help)", msg) }

// take consumes a --key[=value] style flag from args and returns the value, a
// "present" bool, and the remaining args. It builds a fresh slice for the
// remainder so the caller's backing array is never mutated (safe to call
// repeatedly on the same args).
func take(args []string, name string) (string, bool, []string) {
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == name {
			if i+1 < len(args) {
				v := args[i+1]
				rest := make([]string, 0, len(args)-2)
				rest = append(rest, args[:i]...)
				rest = append(rest, args[i+2:]...)
				return v, true, rest
			}
			return "", true, args[:i]
		}
		if strings.HasPrefix(a, name+"=") {
			v := strings.TrimPrefix(a, name+"=")
			rest := make([]string, 0, len(args)-1)
			rest = append(rest, args[:i]...)
			rest = append(rest, args[i+1:]...)
			return v, true, rest
		}
	}
	return "", false, args
}

func hasFlag(args []string, name string) bool {
	for _, a := range args {
		if a == name {
			return true
		}
	}
	return false
}

// removeFlag returns a copy of args with the exact flag name removed.
func removeFlag(args []string, name string) []string {
	out := make([]string, 0, len(args))
	for _, a := range args {
		if a != name {
			out = append(out, a)
		}
	}
	return out
}

// hostname returns a stable source-PC identifier for metadata.
func hostname() string {
	if h, err := os.Hostname(); err == nil && h != "" {
		return h
	}
	return "unknown-pc"
}

func jsonOut(v any) {
	b, _ := json.MarshalIndent(v, "", "  ")
	fmt.Println(string(b))
}

// cmdList prints detected browsers as JSON (Week 1 deliverable).
func cmdList(args []string) error {
	profiles := browser.ListDetected()
	if len(profiles) == 0 {
		fmt.Println("[]")
		fmt.Println("no browsers detected")
		return nil
	}
	jsonOut(profiles)
	return nil
}

// cmdDetect shows one detected browser profile.
func cmdDetect(args []string) error {
	b, _, rest := take(args, "--browser")
	if b == "" || len(rest) > 0 {
		return usageErr("detect --browser <chrome|edge|brave|firefox>")
	}
	p, err := browser.DetectProfile(b)
	if err != nil {
		return err
	}
	jsonOut(p)
	return nil
}

// cmdClone runs extraction + password re-encryption + bundle + registration
// (Week 2 deliverable: `hack-browser-clone clone --browser chrome`).
func cmdClone(args []string) error {
	bt, _, rest := take(args, "--browser")
	if bt == "" {
		return usageErr("clone --browser <chrome|edge|brave|firefox>")
	}
	expires, hadExp, rest := take(rest, "--expires-days")
	days := lifecycle.DefaultLifetimeDays
	if hadExp {
		if _, err := fmt.Sscanf(expires, "%d", &days); err != nil || days < 1 {
			return usageErr("clone --expires-days <positive int>")
		}
	}
	outDir, _, rest := take(rest, "--out")
	profOverride, _, rest := take(rest, "--profile")
	srcPc, _, rest := take(rest, "--source-pc")
	egressProxy, _, rest := take(rest, "--egress-proxy")
	withPasswords := hasFlag(rest, "--include-passwords")
	if withPasswords {
		rest = removeFlag(rest, "--include-passwords")
	}
	if len(rest) > 0 {
		return usageErr("clone " + strings.Join(rest, " "))
	}

	prof, err := browser.DetectProfile(bt)
	if err != nil {
		return err
	}
	if profOverride != "" {
		prof.ProfilePath = profOverride
	}
	if srcPc == "" {
		srcPc = hostname()
	}

	key, err := extractor.NewTransportKey()
	if err != nil {
		return err
	}
	reg, err := registry.New(registry.DefaultDir())
	if err != nil {
		return err
	}
	al, err := audit.New(auditDir())
	if err != nil {
		return err
	}

	bundle, err := extractor.Extract(extractor.ExtractOpts{
		IncludePasswords: withPasswords,
		SourcePc:         srcPc,
		ExpiresInDays:    days,
		Profile:          *prof,
		TransportKey:     key,
		EgressProxy:      egressProxy,
	})
	if err != nil {
		return err
	}

	artifact, err := bundler.Build(bundle, key)
	if err != nil {
		return err
	}
	if outDir == "" {
		outDir = injection.DefaultStagingRoot()
	}
	dir, err := artifact.Write(outDir)
	if err != nil {
		return err
	}

	// Register the clone for transfer (directive §6 pre-stream checks).
	entry := &types.CloneRegistryEntry{
		CloneId:         bundle.Metadata.CloneId,
		SourceWorkPc:    srcPc,
		BrowserType:     prof.Type,
		BrowserVersion:  prof.Version,
		Status:          types.StatusReadyForTransfer,
		CreatedAt:       bundle.Metadata.CreatedAt,
		ExpiresAt:       bundle.Metadata.ExpiresAt,
		StagingDir:      dir,
		ExtensionsCount: len(bundle.Extensions),
		PasswordsCount:  len(bundle.EncryptedPasswords),
		TransportKey:    key,
	}
	if err := reg.Save(entry); err != nil {
		return err
	}
	_ = al.Info(audit.EvCloneInitiated, entry.CloneId, "success", map[string]any{
		"browser": bt, "browser_version": prof.Version, "file_count": artifact.Manifest.FileCount,
	})

	fmt.Println("clone ready for transfer:")
	jsonOut(map[string]any{
		"clone_id":        entry.CloneId,
		"browser":         bt,
		"browser_version": prof.Version,
		"expires_at":      entry.ExpiresAt,
		"files":           artifact.Manifest.FileCount,
		"passwords":       entry.PasswordsCount,
		"extensions":      entry.ExtensionsCount,
		"bundle_dir":      dir,
	})
	return nil
}

// cmdSend either (a) streams a registered clone to the hosted-PC HTTP
// receiver endpoint (--endpoint, directive §6 chunked transfer with
// per-chunk ACK and retry), or (b) materialises the parcel to disk with the
// transport key in a sidecar (--out, offline/dev path).
func cmdSend(args []string) error {
	id, _, rest := take(args, "--clone-id")
	endpoint, _, rest := take(rest, "--endpoint")
	out, _, rest := take(rest, "--out")
	if id == "" || len(rest) > 0 || (endpoint == "" && out == "") {
		return usageErr("send --clone-id <id> [--endpoint http://HOST:PORT | --out DIR]")
	}
	reg, err := registry.New(registry.DefaultDir())
	if err != nil {
		return err
	}
	entry, err := reg.Load(id)
	if err != nil {
		return err
	}
	parcel, err := parcelFromBundleDir(entry.StagingDir, entry.TransportKey)
	if err != nil {
		return fmt.Errorf("read bundle: %w", err)
	}
	if endpoint != "" {
		if err := reg.UpdateStatus(id, types.StatusTransferring); err != nil {
			return err
		}
		res, err := transport.SendHTTP(parcel, transport.HTTPOptions{Endpoint: endpoint})
		if err != nil {
			_ = reg.UpdateStatus(id, types.StatusFailed)
			return err
		}
		if err := reg.UpdateStatus(id, types.StatusReadyForInjection); err != nil {
			return err
		}
		fmt.Println("clone streamed to hosted PC:")
		jsonOut(map[string]any{
			"clone_id":         res.CloneId,
			"chunks_sent":      res.ChunksSent,
			"duration_seconds": res.DurationSecs,
			"registry_status":  res.RegistryStatus,
			"staging_dir":      res.StagingDir,
		})
		return nil
	}
	if out == "" {
		out = filepath.Join(injection.DefaultStagingRoot(), "parcels")
	}
	dir, err := parcel.Write(filepath.Join(out, id))
	if err != nil {
		return err
	}
	if err := reg.UpdateStatus(id, types.StatusTransferring); err != nil {
		return err
	}
	fmt.Println("parcel written:")
	jsonOut(map[string]any{"clone_id": id, "parcel_dir": dir})
	return nil
}

// cmdServe runs the hosted-PC §6 HTTP receiver (POST /rmm/inject-clone,
// per-chunk ACK, RECV CHECKs 1-5 on the final chunk). Intended to run as a
// service next to the RMM agent; it is silent by design.
func cmdServe(args []string) error {
	addr, _, rest := take(args, "--addr")
	staging, _, rest := take(rest, "--staging-root")
	hostBrowser, _, rest := take(rest, "--host-browser")
	hostVersion, _, rest := take(rest, "--host-browser-version")
	if len(rest) > 0 {
		return usageErr("serve [--addr :8080] [--staging-root DIR] [--host-browser TYPE] [--host-browser-version V]")
	}
	if staging == "" {
		staging = injection.DefaultStagingRoot()
	}
	// Port preflight: refuse to start on an occupied port. A stale receiver
	// squatting the endpoint made every later relay/deploy "bind" silently
	// fail, so this is a hard, explicit failure instead.
	bindAddr := addr
	if bindAddr == "" {
		bindAddr = ":8080"
	}
	if !portFree(bindAddr) {
		return fmt.Errorf("%s: %s is already in use - stop the stale listener first (netstat/ss -tlnp)", types.ErrOutputFailed, bindAddr)
	}
	regDir := filepath.Join(staging, "..", "registry")
	reg, err := registry.New(regDir)
	if err != nil {
		return err
	}
	al, err := audit.New(auditDir())
	if err != nil {
		return err
	}
	srv, err := injection.NewStreamServer(injection.StreamServerOptions{
		Addr:               addr,
		StagingRoot:        staging,
		Registry:           reg,
		Audit:              al,
		HostBrowserType:    hostBrowser,
		HostBrowserVersion: hostVersion,
	})
	if err != nil {
		return err
	}
	fmt.Println("clone receiver listening on", addr, "at", transport.HTTPPath)
	return srv.ListenAndServe()
}

// portFree reports whether a TCP port is bindable (no listener holds it).
// Used by cmdServe's preflight against stale-receiver squatting.
func portFree(addr string) bool {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return false
	}
	ln.Close()
	return true
}

// provision-key stores a clone's transport key in the hosted-PC registry
// out-of-band (the receiver resolves keys by clone id; the key never rides
// the data stream). Dev/test path: the operator copies the key from the work
// PC registry; production uses the RMM control-plane key exchange.
func cmdProvisionKey(args []string) error {
	id, _, rest := take(args, "--clone-id")
	keyB64, _, rest := take(rest, "--key")
	staging, _, rest := take(rest, "--staging-root")
	if id == "" || keyB64 == "" || len(rest) > 0 {
		return usageErr("provision-key --clone-id <id> --key <base64>")
	}
	key, err := crypto.B64Decode(strings.TrimSpace(keyB64))
	if err != nil || len(key) == 0 {
		return usageErr("provision-key --key must be valid base64")
	}
	regDir := registry.DefaultDir()
	if staging != "" {
		regDir = filepath.Join(staging, "..", "registry")
	}
	reg, err := registry.New(regDir)
	if err != nil {
		return err
	}
	entry, err := reg.Load(id)
	if err != nil {
		entry = &types.CloneRegistryEntry{CloneId: id, Status: types.StatusTransferring, CreatedAt: types.NowIso()}
	}
	entry.TransportKey = key
	if err := reg.Save(entry); err != nil {
		return err
	}
	fmt.Println("transport key provisioned for clone:", id)
	return nil
}

// cmdShowKey prints the (plaintext, base64) transport key from the local
// registry. This is the operator side of the out-of-band key exchange on the
// work PC: the printed key is copied to the hosted PC via provision-key (dev/
// test) or the control-plane (production).
func cmdShowKey(args []string) error {
	id, _, rest := take(args, "--clone-id")
	staging, _, rest := take(rest, "--staging-root")
	if id == "" || len(rest) > 0 {
		return usageErr("show-key --clone-id <id>")
	}
	regDir := registry.DefaultDir()
	if staging != "" {
		regDir = filepath.Join(staging, "..", "registry")
	}
	reg, err := registry.New(regDir)
	if err != nil {
		return err
	}
	entry, err := reg.Load(id)
	if err != nil {
		return err
	}
	if len(entry.TransportKey) == 0 {
		return fmt.Errorf("%s: clone %s has no transport key", types.ErrKeyNotFound, id)
	}
	fmt.Println(crypto.B64Encode(entry.TransportKey))
	return nil
}

// preflightResult is the JSON outcome of an install-folder quarantine.
type preflightResult struct {
	Dir      string `json:"dir"`
	Created  bool   `json:"created"`
	Method   string `json:"method"` // "defender-exclusion" | "fs-isolation"
	Verified bool   `json:"verified"`
	Ok       bool   `json:"ok"`
	Details  string `json:"details,omitempty"`
}

// componentExeNames lists every Spaceworker binary that endpoint protection
// must leave alone (observed incidents: Defender behaviourally quarantined a
// deployed binary mid-rollout and stripped its scheduled task; later killed
// the relay the same way). The exclusion set covers the whole family so a
// component can never be "the one we forgot": the console CLI, the
// GUI-subsystem service twin (scheduled tasks), the native messaging host,
// and the egress relay. preflight --exe appends an extra name for tests.
var componentExeNames = []string{
	"hack-browser-clone.exe",
	"hack-browser-clone-svc.exe",
	"clone-native-host.exe",
	"hack-relay.exe",
}

// runPreflight enforces the deployment rule: the install folder is
// quarantined BEFORE the binary is installed into it. Endpoint protection
// behaviourally quarantined a deployed binary mid-rollout and stripped its
// scheduled task, so Windows pre-registers Defender path + process
// exclusions (verified) before the exe lands. POSIX hosted servers isolate
// by ownership and mode instead (root-owned, 0700, no group/world access).
// The install scripts abort when this fails.
func runPreflight(dir, exeName string) preflightResult {
	res := preflightResult{Dir: dir}
	if _, err := os.Stat(dir); os.IsNotExist(err) {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			res.Details = "mkdir: " + err.Error()
			return res
		}
		res.Created = true
	} else if err != nil {
		res.Details = "stat: " + err.Error()
		return res
	}
	if runtime.GOOS == "windows" {
		res.Method = "defender-exclusion"
		exes := append([]string{}, componentExeNames...)
		if exeName != "" {
			exes = append(exes, exeName)
		}
		parts := make([]string, 0, len(exes)+1)
		parts = append(parts, fmt.Sprintf("Add-MpPreference -ExclusionPath '%s'", dir))
		for _, e := range exes {
			parts = append(parts, fmt.Sprintf("Add-MpPreference -ExclusionProcess '%s'", e))
		}
		addCmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", strings.Join(parts, "; "))
		procattr.Quiet(addCmd) // must not flash a console on the user's desktop
		if out, err := addCmd.CombinedOutput(); err != nil {
			res.Details = "Add-MpPreference: " + err.Error() + ": " + strings.TrimSpace(string(out))
			return res
		}
		cond := fmt.Sprintf("(Get-MpPreference).ExclusionPath -contains '%s'", dir)
		for _, e := range exes {
			cond += fmt.Sprintf(" -and ((Get-MpPreference).ExclusionProcess -contains '%s')", e)
		}
		checkCmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", cond)
		procattr.Quiet(checkCmd)
		out, err := checkCmd.CombinedOutput()
		if err != nil || !strings.Contains(strings.ToLower(string(out)), "true") {
			res.Details = "exclusion not verified (admin required?): " + strings.TrimSpace(string(out))
			return res
		}
		res.Verified = true
		res.Ok = true
		return res
	}
	res.Method = "fs-isolation"
	if err := os.Chmod(dir, 0o700); err != nil {
		res.Details = "chmod: " + err.Error()
		return res
	}
	st, err := os.Stat(dir)
	if err != nil {
		res.Details = "stat: " + err.Error()
		return res
	}
	res.Verified = st.Mode().Perm() == 0o700
	res.Ok = res.Verified
	if !res.Ok {
		res.Details = fmt.Sprintf("mode %o, want 700", st.Mode().Perm())
	}
	return res
}

// cmdPreflight quarantines an install folder ahead of the binary (see
// runPreflight). Called by the platform install scripts; they abort on a
// non-zero exit.
func cmdPreflight(args []string) error {
	dir, _, rest := take(args, "--dir")
	exe, _, rest := take(rest, "--exe")
	// exe is an ADDITIONAL process-exclusion name (e.g. a test binary);
	// the whole component family is always covered (componentExeNames).
	if dir == "" || len(rest) > 0 {
		return usageErr("preflight --dir <install-dir> [--exe EXTRA-BINARY-NAME]")
	}
	res := runPreflight(dir, exe)
	jsonOut(res)
	if !res.Ok {
		return fmt.Errorf("%s: install-folder quarantine failed (%s)", types.ErrOutputFailed, res.Details)
	}
	return nil
}

// parcelFromBundleDir assembles a transfer Parcel from the bundle dir written
// by `clone` and the in-memory transport key from the registry.
func parcelFromBundleDir(dir string, key []byte) (*transport.Parcel, error) {
	p := &transport.Parcel{TransportKeyB64: crypto.B64Encode(key)}
	read := func(name string) ([]byte, error) {
		b, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			return nil, err
		}
		return b, nil
	}
	var err error
	if p.ManifestJSON, err = read("manifest.json"); err != nil {
		return nil, err
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
		return nil, err
	}
	p.CloneId = m.CloneId
	return p, nil
}

// cmdReceive validates + stages an incoming parcel (hosted PC, directive §7).
func cmdReceive(args []string) error {
	parcelDir, _, rest := take(args, "--parcel")
	staging, _, rest := take(rest, "--staging-root")
	hostBrowser, _, rest := take(rest, "--host-browser")
	hostVersion, _, rest := take(rest, "--host-browser-version")
	if parcelDir == "" {
		return usageErr("receive --parcel <dir> [--staging-root DIR] [--host-browser TYPE]")
	}
	if staging == "" {
		staging = injection.DefaultStagingRoot()
	}
	parcel, err := transport.ReadParcel(parcelDir)
	if err != nil {
		return err
	}
	// Offline/test path: sidecar key. Production uses the server control-plane
	// key exchange instead.
	var key []byte
	if key, err = parcel.DecodeTransportKey(); err != nil {
		return fmt.Errorf("invalid transport key sidecar: %w", err)
	}
	reg, err := registry.New(filepath.Join(staging, "..", "registry"))
	if err != nil {
		return err
	}
	al, err := audit.New(auditDir())
	if err != nil {
		return err
	}
	entry, err := injection.Receive(parcel, injection.ReceiveOptions{
		StagingRoot:        staging,
		TransportKey:       key,
		Registry:           reg,
		Audit:              al,
		HostBrowserType:    hostBrowser,
		HostBrowserVersion: hostVersion,
	})
	if err != nil {
		return err
	}
	fmt.Println("clone received + staged:")
	jsonOut(map[string]any{
		"clone_id":    entry.CloneId,
		"browser":     entry.BrowserType,
		"status":      entry.Status,
		"staging_dir": entry.StagingDir,
		"expires_at":  entry.ExpiresAt,
	})
	return nil
}

// cmdInject mounts a staged clone into the destination profile (hosted PC,
// directive §8) and runs all validation.
func cmdInject(args []string) error {
	id, _, rest := take(args, "--clone-id")
	staging, _, rest := take(rest, "--staging-root")
	profile, _, rest := take(rest, "--profile")
	sid, _, rest := take(rest, "--host-sid")
	user, _, rest := take(rest, "--host-user")
	owner, _, rest := take(rest, "--owner")
	force := hasFlag(rest, "--force")
	dryRun := hasFlag(rest, "--dry-run")
	if id == "" {
		return usageErr("inject --clone-id <id> [--force] [--dry-run] [--staging-root DIR] [--profile PATH] [--owner UID:GID]")
	}
	if staging == "" {
		staging = injection.DefaultStagingRoot()
	}
	reg, err := registry.New(filepath.Join(staging, "..", "registry"))
	if err != nil {
		return err
	}
	al, err := audit.New(auditDir())
	if err != nil {
		return err
	}
	res, err := injection.Inject(injection.InjectOptions{
		CloneId:      id,
		StagingRoot:  staging,
		Registry:     reg,
		Audit:        al,
		Force:        force,
		DryRun:       dryRun,
		ProfilePath:  profile,
		HostUserSid:  sid,
		HostUserName: user,
		MountOwner:   owner,
	})
	if err != nil {
		return err
	}
	fmt.Println("injection result:")
	jsonOut(res)
	return nil
}

// cmdLaunch starts the host browser on an injected clone for the logged-in
// hosted-PC user (directive §7 activation). Intended to run in the user's
// interactive session (e.g. via a scheduled task with the interactive flag)
// so the browser window appears on the desktop.
func cmdLaunch(args []string) error {
	id, _, rest := take(args, "--clone-id")
	staging, _, rest := take(rest, "--staging-root")
	profile, _, rest := take(rest, "--profile")
	display, _, rest := take(rest, "--display")
	proxy, _, rest := take(rest, "--proxy")
	proxyOptional := hasFlag(rest, "--proxy-optional")
	if proxyOptional {
		rest = removeFlag(rest, "--proxy-optional")
	}
	if id == "" || len(rest) > 0 {
		return usageErr("launch --clone-id <id> [--staging-root DIR] [--profile PATH] [--display :0] [--proxy HOST:PORT] [--proxy-optional]")
	}
	if staging == "" {
		staging = injection.DefaultStagingRoot()
	}
	reg, err := registry.New(filepath.Join(staging, "..", "registry"))
	if err != nil {
		return err
	}
	al, err := audit.New(auditDir())
	if err != nil {
		return err
	}
	exe, prof, err := injection.Launch(injection.LaunchOptions{
		CloneId:       id,
		StagingRoot:   staging,
		Registry:      reg,
		Audit:         al,
		ProfilePath:   profile,
		Display:       display,
		Proxy:         proxy,
		ProxyOptional: proxyOptional,
	})
	if err != nil {
		return err
	}
	fmt.Println("launched", exe)
	fmt.Println("profile:", prof)
	return nil
}

// cmdStatus prints a single clone's registry entry. Work-PC entries live in
// the default registry dir; hosted-PC entries live next to the staging root,
// so pass --staging-root there (default DefaultStagingRoot's sibling).
func cmdStatus(args []string) error {
	id, _, rest := take(args, "--clone-id")
	staging, _, rest := take(rest, "--staging-root")
	if id == "" || len(rest) > 0 {
		return usageErr("status --clone-id <id> [--staging-root DIR]")
	}
	regDir := registry.DefaultDir()
	if staging != "" {
		regDir = filepath.Join(staging, "..", "registry")
	}
	reg, err := registry.New(regDir)
	if err != nil {
		return err
	}
	e, err := reg.Load(id)
	if err != nil {
		return err
	}
	jsonOut(publicEntry(e))
	return nil
}

// auditDir returns the audit log directory (directive §12; Windows mirrors
// ProgramData\TacticalRMM\audit).
func auditDir() string {
	switch runtime.GOOS {
	case "windows":
		base := os.Getenv("PROGRAMDATA")
		if base == "" && os.Getenv("SystemDrive") != "" {
			base = filepath.Join(os.Getenv("SystemDrive"), "ProgramData")
		}
		if base != "" {
			return filepath.Join(base, "TacticalRMM", "audit")
		}
	}
	if d, err := os.UserConfigDir(); err == nil {
		return filepath.Join(d, "spaceworker-browser-clone", "audit")
	}
	return filepath.Join(os.TempDir(), "spaceworker-browser-clone", "audit")
}

// publicEntry returns a registry entry with the transport key and other
// secrets stripped, safe for display/audit output.
func publicEntry(e *types.CloneRegistryEntry) *types.CloneRegistryEntry {
	if e == nil {
		return nil
	}
	c := *e
	c.TransportKey = nil
	c.TransportKeyB64 = ""
	return &c
}

// hostedRegistry opens the registry used by the hosted-PC commands
// (receive/inject/revoke/expire), located next to the clones staging root.
func hostedRegistry(stagingRoot string) (*registry.Store, error) {
	if stagingRoot == "" {
		stagingRoot = injection.DefaultStagingRoot()
	}
	return registry.New(filepath.Join(stagingRoot, "..", "registry"))
}

// cmdStatusAll lists all registry entries with secrets removed.
func cmdStatusAll(args []string) error {
	if len(args) > 0 {
		return usageErr("status-all")
	}
	reg, err := registry.New(registry.DefaultDir())
	if err != nil {
		return err
	}
	entries, err := reg.List()
	if err != nil {
		return err
	}
	if len(entries) == 0 {
		fmt.Println("[]")
		fmt.Println("no clones registered")
		return nil
	}
	out := make([]*types.CloneRegistryEntry, 0, len(entries))
	for _, e := range entries {
		out = append(out, publicEntry(e))
	}
	jsonOut(out)
	return nil
}

// cmdRevoke tears down a live clone on the hosted PC (directive §11).
func cmdRevoke(args []string) error {
	id, _, rest := take(args, "--clone-id")
	staging, _, rest := take(rest, "--staging-root")
	if id == "" || len(rest) > 0 {
		return usageErr("revoke --clone-id <id> [--staging-root DIR]")
	}
	reg, err := hostedRegistry(staging)
	if err != nil {
		return err
	}
	al, err := audit.New(auditDir())
	if err != nil {
		return err
	}
	if err := lifecycle.Revoke(id, reg, al); err != nil {
		return err
	}
	fmt.Println("clone revoked:", id)
	return nil
}

// cmdExpire sweeps clones past their expiry date (directive §11).
func cmdExpire(args []string) error {
	staging, _, rest := take(args, "--staging-root")
	if len(rest) > 0 {
		return usageErr("expire [--staging-root DIR]")
	}
	reg, err := hostedRegistry(staging)
	if err != nil {
		return err
	}
	al, err := audit.New(auditDir())
	if err != nil {
		return err
	}
	ids, errs := lifecycle.ExpireDue(reg, al)
	for i, id := range ids {
		if i < len(errs) && errs[i] != nil {
			fmt.Printf("expired %s (reported: %v)\n", id, errs[i])
			continue
		}
		fmt.Println("expired:", id)
	}
	if len(ids) == 0 {
		if len(errs) > 0 {
			return errs[0]
		}
		fmt.Println("no clones due for expiry")
	}
	return nil
}

// cmdAudit shows (or with --prune removes) audit log entries (directive §12).
func cmdAudit(args []string) error {
	days, hadDays, rest := take(args, "--days")
	maxAge := audit.RetentionDays
	if hadDays {
		if _, err := fmt.Sscanf(days, "%d", &maxAge); err != nil || maxAge < 1 {
			return usageErr("audit --days <positive int>")
		}
	}
	prune := hasFlag(rest, "--prune")
	if prune {
		rest = removeFlag(rest, "--prune")
	}
	if len(rest) > 0 {
		return usageErr("audit " + strings.Join(rest, " "))
	}
	dir := auditDir()
	if prune {
		n, err := audit.Prune(dir, maxAge)
		if err != nil {
			return err
		}
		fmt.Printf("pruned %d audit file(s) older than %d days\n", n, maxAge)
		return nil
	}
	cutoff := time.Now().Add(-time.Duration(maxAge) * 24 * time.Hour)
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			fmt.Println("[]")
			fmt.Println("no audit log")
			return nil
		}
		return err
	}
	var events []types.AuditEvent
	for _, ent := range entries {
		if ent.IsDir() || !strings.HasPrefix(ent.Name(), "clone-") {
			continue
		}
		st, err := ent.Info()
		if err != nil || st.ModTime().Before(cutoff) {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, ent.Name()))
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(data), "\n") {
			line = strings.TrimSpace(line)
			if line == "" {
				continue
			}
			var ev types.AuditEvent
			if err := json.Unmarshal([]byte(line), &ev); err != nil {
				continue
			}
			if t, terr := time.Parse(time.RFC3339, ev.Timestamp); terr == nil && t.Before(cutoff) {
				continue
			}
			events = append(events, ev)
		}
	}
	if len(events) == 0 {
		fmt.Println("[]")
		fmt.Println("no audit events in range")
		return nil
	}
	jsonOut(events)
	return nil
}
