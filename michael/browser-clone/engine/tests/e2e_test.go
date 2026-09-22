// Package tests hosts the end-to-end pipeline test (directive "Code
// Structure": tests/e2e_test.go). It drives a synthetic Chrome-family profile
// through the complete work-PC → hosted-PC pipeline without a real browser,
// real DPAPI or any network:
//
//	extract → bundle + sign → parcel file → mesh envelope → receive (5 RECV
//	CHECKs) → inject (dry-run, cross-user reject, full mount) → expiration.
//
// The synthetic profile uses BrowserType "brave": on hosts without a brave
// binary the headless validation degrades to the tolerated "warning:*" path,
// so the full mount runs deterministically in CI (directive §8 tolerates
// "warning:*"; only "failed:*" aborts).
package tests

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"spaceworker.browser-clone/pkg/audit"
	"spaceworker.browser-clone/pkg/bundler"
	"spaceworker.browser-clone/pkg/crypto"
	"spaceworker.browser-clone/pkg/extractor"
	"spaceworker.browser-clone/pkg/injection"
	"spaceworker.browser-clone/pkg/lifecycle"
	"spaceworker.browser-clone/pkg/registry"
	"spaceworker.browser-clone/pkg/transport"
	"spaceworker.browser-clone/pkg/types"
)

const (
	testExtID = "abcdefghijklmnopabcdefghijklmnop"
	testSID   = "S-1-5-21-1000"
	hostSID   = testSID
)

// syntheticProfile writes a small Chrome-style profile tree and returns its
// (dataPath, profilePath). Every file lands in the bundle (none match the
// extractor's skip list) and the Extensions tree produces one side-loaded
// extension record.
func syntheticProfile(t *testing.T) (string, string) {
	t.Helper()
	root := t.TempDir()
	profile := filepath.Join(root, "Default")
	if err := os.MkdirAll(filepath.Join(profile, "Extensions", testExtID, "1.0.0"), 0o700); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		"Bookmarks":   `{"roots":{"bookmark_bar":{"children":[{"name":"docs","type":"url","url":"https://example.com/docs"}]}}}`,
		"Preferences": `{"profile":{"name":"tester"},"session":{"restore_on_startup":1}}`,
		filepath.Join("Extensions", testExtID, "1.0.0", "manifest.json"): `{"name":"Test Extension","version":"1.0.0","permissions":["storage"]}`,
	}
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(profile, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return root, profile
}

// extractBundle runs Extract + Build over the synthetic profile with a fresh
// transport key (passwords off by default — directive "Questions for Greene"
// #7: passwords ship opt-in only).
func extractBundle(t *testing.T) (*types.ProfileBundle, *bundler.Bundle, []byte) {
	t.Helper()
	dataPath, profilePath := syntheticProfile(t)
	key, err := crypto.NewKey()
	if err != nil {
		t.Fatal(err)
	}
	pb, err := extractor.Extract(extractor.ExtractOpts{
		IncludePasswords: false,
		SourcePc:         "WORKPC",
		SourceUser:       "tester",
		SourceUserSid:    testSID,
		ExpiresInDays:    lifecycle.DefaultLifetimeDays,
		Profile: types.BrowserProfile{
			Type:        types.BrowserBrave,
			Version:     "130.0.1.1",
			DataPath:    dataPath,
			ProfilePath: profilePath,
		},
		TransportKey: key,
	})
	if err != nil {
		t.Fatalf("extract: %v", err)
	}
	b, err := bundler.Build(pb, key)
	if err != nil {
		t.Fatalf("bundle: %v", err)
	}
	return pb, b, key
}

// stagedParcel takes the bundle through the parcel file round-trip
// (BuildParcel → Write → ReadParcel → VerifyParcel) and returns the reloaded
// parcel, as the hosted PC would receive it.
func stagedParcel(t *testing.T, b *bundler.Bundle, key []byte) *transport.Parcel {
	t.Helper()
	p, err := transport.BuildParcel(b, key)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if _, err := p.Write(dir); err != nil {
		t.Fatal(err)
	}
	p2, err := transport.ReadParcel(dir)
	if err != nil {
		t.Fatal(err)
	}
	if p2.CloneId != b.Manifest.CloneId {
		t.Fatalf("parcel clone id: got %q want %q", p2.CloneId, b.Manifest.CloneId)
	}
	if ok, what, err := transport.VerifyParcel(p2, key); err != nil || !ok {
		t.Fatalf("VerifyParcel: ok=%v what=%q err=%v", ok, what, err)
	}
	return p2
}

// receive stages the parcel on a fresh hosted-PC staging root and returns the
// resulting registry entry, stores and the staging root (err from Receive).
func receive(t *testing.T, p *transport.Parcel, key []byte, hostType, hostVersion string) (*types.CloneRegistryEntry, *registry.Store, *audit.Logger, string, error) {
	t.Helper()
	staging := t.TempDir()
	reg, err := registry.New(filepath.Join(staging, "registry"))
	if err != nil {
		t.Fatal(err)
	}
	al, err := audit.New(filepath.Join(staging, "audit"))
	if err != nil {
		t.Fatal(err)
	}
	entry, err := injection.Receive(p, injection.ReceiveOptions{
		StagingRoot:        staging,
		TransportKey:       key,
		Registry:           reg,
		Audit:              al,
		HostBrowserType:    hostType,
		HostBrowserVersion: hostVersion,
	})
	return entry, reg, al, staging, err
}

func TestExtractBundleSignParcel(t *testing.T) {
	pb, b, key := extractBundle(t)

	if pb.Metadata.BrowserType != types.BrowserBrave || pb.Metadata.SourcePc != "WORKPC" || pb.Metadata.SourceUserSid != testSID {
		t.Fatalf("metadata: %+v", pb.Metadata)
	}
	if pb.Metadata.IncludePasswords {
		t.Fatal("passwords must be off by default (directive policy: opt-in only)")
	}
	if len(pb.Passwords) != 0 || len(pb.EncryptedPasswords) != 0 {
		t.Fatal("no password records expected with IncludePasswords=false")
	}
	if got := string(pb.ProfileFiles["Bookmarks"]); !strings.Contains(got, "example.com/docs") {
		t.Fatalf("Bookmarks not captured: %q", got)
	}
	if _, ok := pb.ProfileFiles["Preferences"]; !ok {
		t.Fatal("Preferences not captured")
	}
	if len(pb.Extensions) != 1 || pb.Extensions[0].ID != testExtID {
		t.Fatalf("extensions: %+v", pb.Extensions)
	}

	m := b.Manifest
	if m.CloneId != pb.Metadata.CloneId || m.BrowserType != types.BrowserBrave {
		t.Fatalf("manifest identity: %+v", m)
	}
	if m.SignatureMethod != "HMAC-SHA256" {
		t.Fatalf("signature method %q", m.SignatureMethod)
	}
	if m.TransportKeyHash != crypto.Sha256Hex(key) {
		t.Fatal("transport key hash mismatch")
	}
	if m.FileCount < 3 { // Bookmarks, Preferences, Extensions/<id>/1.0.0/manifest.json
		t.Fatalf("file count %d", m.FileCount)
	}
	if m.TotalSizeBytes <= 0 || m.ExpiresAt == "" || m.CreatedAt == "" {
		t.Fatal("manifest missing sizes/expiry")
	}
	if m.SideLoadedCount != 1 || m.WebStoreCount != 0 {
		t.Fatalf("extension counts: side=%d web=%d", m.SideLoadedCount, m.WebStoreCount)
	}
	if len(m.Extensions) != 1 || m.Extensions[0].ID != testExtID {
		t.Fatalf("manifest extensions: %+v", m.Extensions)
	}
	if len(b.ProfileZip) == 0 || len(b.ExtensionsZip) == 0 || b.PasswordsJSON != nil {
		t.Fatal("artifact set mismatch (passwords.json must be absent)")
	}
	if !bundler.VerifySignature(m, key) {
		t.Fatal("signature does not verify under the transport key")
	}
	tampered := m
	tampered.Signature = strings.Repeat("0", len(m.Signature))
	if bundler.VerifySignature(tampered, key) {
		t.Fatal("tampered signature accepted")
	}
	if _, err := b.Write(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	p := stagedParcel(t, b, key)
	if p.CloneId != m.CloneId {
		t.Fatalf("parcel id %q", p.CloneId)
	}
}

func TestMeshEnvelopeRoundTrip(t *testing.T) {
	_, b, key := extractBundle(t)
	p := stagedParcel(t, b, key)

	env, err := transport.EncodeMesh(p, key, "WORKPC", "HOSTEDPC")
	if err != nil {
		t.Fatal(err)
	}
	if env.Version != transport.MeshProtocolVersion || env.CloneId != p.CloneId ||
		env.SourcePc != "WORKPC" || env.TargetPc != "HOSTEDPC" || env.SentAt == "" {
		t.Fatalf("envelope: %+v", env)
	}
	raw, err := transport.DecodeMesh(env, key)
	if err != nil {
		t.Fatal(err)
	}
	p2, err := transport.UnmarshalParcel(raw)
	if err != nil {
		t.Fatal(err)
	}
	if ok, what, err := transport.VerifyParcel(p2, key); err != nil || !ok {
		t.Fatalf("mesh round-trip verify: ok=%v what=%q err=%v", ok, what, err)
	}

	// A wrong key must fail envelope authentication.
	if _, err := transport.DecodeMesh(env, []byte("wrong-key-bytes-not-accepted......")); err == nil {
		t.Fatal("envelope accepted under the wrong key")
	}
	// A tampered body must fail envelope authentication (§10 MITM check).
	bad := *env
	bad.Body = "B" + bad.Body[1:]
	if _, err := transport.DecodeMesh(&bad, key); err == nil {
		t.Fatal("tampered envelope accepted")
	}
}

func TestReceiveStageAndRejects(t *testing.T) {
	_, b, key := extractBundle(t)
	p := stagedParcel(t, b, key)

	entry, reg, _, staging, err := receive(t, p, key, types.BrowserBrave, "130")
	if err != nil {
		t.Fatalf("receive: %v", err)
	}
	if entry.Status != types.StatusReadyForInjection {
		t.Fatalf("status %q", entry.Status)
	}
	if len(entry.TransportKey) == 0 {
		t.Fatal("receive did not resolve the transport key")
	}
	if _, err := os.Stat(filepath.Join(staging, entry.CloneId, "manifest.json")); err != nil {
		t.Fatalf("staged manifest: %v", err)
	}
	status, err := os.ReadFile(filepath.Join(staging, entry.CloneId, ".status"))
	if err != nil || strings.TrimSpace(string(status)) != types.StatusReadyForInjection {
		t.Fatalf(".status=%q err=%v", status, err)
	}
	if _, err := os.Stat(filepath.Join(staging, entry.CloneId, "profile", "Bookmarks")); err != nil {
		t.Fatalf("profile not decompressed: %v", err)
	}
	if e2, err := reg.Load(entry.CloneId); err != nil || e2.Status != types.StatusReadyForInjection {
		t.Fatalf("registry reload: %v %+v", err, e2)
	}

	// RECV CHECK 2: browser type mismatch is rejected.
	_, b2, k2 := extractBundle(t)
	p2 := stagedParcel(t, b2, k2)
	if _, _, _, _, err := receive(t, p2, k2, types.BrowserFirefox, "130"); err == nil ||
		!strings.Contains(err.Error(), types.ErrBrowserTypeMismatch) {
		t.Fatalf("expected ErrBrowserTypeMismatch, got %v", err)
	}

	// MOUNT CHECK 2: cross-user injection is rejected before anything mounts.
	dest := t.TempDir()
	_, err = injection.Inject(injection.InjectOptions{
		CloneId:      entry.CloneId,
		StagingRoot:  staging,
		Registry:     reg,
		DryRun:       true,
		ProfilePath:  dest,
		HostUserSid:  "S-1-5-21-9999",
		HostUserName: "intruder",
	})
	if err == nil || !strings.Contains(err.Error(), types.ErrUserMismatch) {
		t.Fatalf("expected ErrUserMismatch, got %v", err)
	}

	// Dry-run performs every check without mounting or activating.
	res, err := injection.Inject(injection.InjectOptions{
		CloneId:      entry.CloneId,
		StagingRoot:  staging,
		Registry:     reg,
		DryRun:       true,
		ProfilePath:  dest,
		HostUserSid:  hostSID,
		HostUserName: "tester",
	})
	if err != nil {
		t.Fatalf("dry-run inject: %v", err)
	}
	if !res.DryRun || res.FilesMounted != 0 || res.ValidationResult != "skipped" {
		t.Fatalf("dry run result: %+v", res)
	}
	if e, _ := reg.Load(entry.CloneId); e.Status != types.StatusReadyForInjection {
		t.Fatalf("dry run must not activate the clone: %q", e.Status)
	}
}

func TestFullInjectAndExpiration(t *testing.T) {
	_, b, key := extractBundle(t)
	p := stagedParcel(t, b, key)
	entry, reg, al, staging, err := receive(t, p, key, types.BrowserBrave, "130")
	if err != nil {
		t.Fatalf("receive: %v", err)
	}

	dest := t.TempDir()
	res, err := injection.Inject(injection.InjectOptions{
		CloneId:      entry.CloneId,
		StagingRoot:  staging,
		Registry:     reg,
		Audit:        al,
		ProfilePath:  dest,
		HostUserSid:  hostSID,
		HostUserName: "tester",
		RunningFn:    func(string) bool { return false },
	})
	if err != nil {
		t.Fatalf("inject: %v", err)
	}
	if res.FilesMounted == 0 {
		t.Fatalf("no files mounted: %+v", res)
	}
	// Brave is absent on CI hosts: validation degrades to a tolerated warning.
	if res.ValidationResult != "passed" && !strings.HasPrefix(res.ValidationResult, "warning:") {
		t.Fatalf("validation %q", res.ValidationResult)
	}
	if got, err := os.ReadFile(filepath.Join(dest, "Bookmarks")); err != nil ||
		!strings.Contains(string(got), "example.com/docs") {
		t.Fatalf("mounted bookmarks: %q %v", got, err)
	}
	if _, err := os.Stat(filepath.Join(dest, entry.CloneId+".manifest.json")); err != nil {
		t.Fatalf("host manifest: %v", err)
	}
	e, err := reg.Load(entry.CloneId)
	if err != nil || e.Status != types.StatusActive || e.InjectedAt == "" {
		t.Fatalf("registry after inject: %v %+v", err, e)
	}

	// The audit trail captured transfer + injection (§12 JSONL).
	data, err := os.ReadFile(audit.LogPath(filepath.Join(staging, "audit"), time.Now()))
	if err != nil {
		t.Fatal(err)
	}
	alog := string(data)
	for _, want := range []string{"clone_transferred", "clone_injected"} {
		if !strings.Contains(alog, want) {
			t.Fatalf("audit missing %q:\n%s", want, alog)
		}
	}

	// Expiration sweep tears the clone down (entry + staging tree).
	e.ExpiresAt = types.NowIso()
	if err := reg.Save(e); err != nil {
		t.Fatal(err)
	}
	expired, failures := lifecycle.ExpireDue(reg, al)
	if len(failures) != 0 {
		t.Fatalf("expire failures: %v", failures)
	}
	found := false
	for _, id := range expired {
		if id == entry.CloneId {
			found = true
		}
	}
	if !found {
		t.Fatalf("clone not expired: %v", expired)
	}
	if _, err := reg.Load(entry.CloneId); err == nil {
		t.Fatal("registry entry survived expiration")
	}
	if _, err := os.Stat(filepath.Join(staging, entry.CloneId)); !os.IsNotExist(err) {
		t.Fatal("staging tree survived expiration")
	}
	data2, err := os.ReadFile(audit.LogPath(filepath.Join(staging, "audit"), time.Now()))
	if err != nil || !strings.Contains(string(data2), "clone_expired") {
		t.Fatalf("audit missing clone_expired: %v", err)
	}
}
