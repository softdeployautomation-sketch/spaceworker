# Engine — spaceworker-browser-clone (Go)

The PowerShell layer (`../*.ps1`) is the MT-1 contract skin. This directory holds the
complete production clone engine it can delegate to via `-PreferEngine`.

- `cmd/hack-browser-clone/` — CLI: detect/clone/send/receive/inject/launch/status/revoke/audit/preflight/serve/provision-key
- `cmd/relay/` — work-PC egress relay (CONNECT + plain HTTP, bearer-token, IPv4-first dial); launch fails closed when the relay is down (§13, [IP CHECK 2])
- `cmd/native-host/` — Chrome/Edge native messaging host (`clone_browser`, `get_clone_status`)
- `pkg/` — types, detector, extractor, bundler+signing, crypto (DPAPI/v10 → AES-256-GCM), transport (chunked HTTP + mesh envelope), receiver (RECV CHECKs), injector (MOUNT/INJECT CHECKs + watchdog), lifecycle (revoke/expire), audit (JSONL), registry, sqlite reader, procattr (silent windows)
- `extension/` — toolbar UI + background worker
- `scripts/` — quarantine-first installers (Windows/Linux), relay install, native-host registration
- `tests/` — synthetic full-pipeline e2e
- `docs/IMPLEMENTATION.md` — architecture + §6/§7/§8/§13 walkthrough

Build: `go build ./...` · Test: `go test ./...` · Windows cross: `GOOS=windows GOARCH=amd64 go build ./...`

Engine exit codes: 0 = ok, non-zero = fail (partial capability reported inside its JSON).
