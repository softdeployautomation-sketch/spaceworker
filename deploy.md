# SpaceWorker Deploy

## Production VPS (live since 2026-11-04 rebuild)

- **Host:** `root@207.244.224.57` (old `164.68.105.96` is dead)
- **SSH key:** `~/.ssh/tacticalrmm_vps` (already on this machine — reference by path only, never print/copy contents)
- **App dir:** `/opt/spaceworker` (plain rsync copy, NOT a git repo)
- **Service:** `spaceworker.service` (Next.js, `next start -p 3500`, `User=trmm`)

## Deploy command

```bash
VPS_HOST=root@207.244.224.57 SSH_KEY=~/.ssh/tacticalrmm_vps \
  scripts/deploy-vps.sh <files-from>
```

where `<files-from>` is a newline-separated list of repo-relative paths (one per line), e.g.:

```
lib/exe-runtime.ts
app/api/auth/signup/route.ts
```

## Preflight (run before every deploy)

1. Confirm the box is reachable: `ssh -i ~/.ssh/tacticalrmm_vps root@207.244.224.57 echo ok`
2. Host key in `known_hosts`: `ssh-keyscan -H 207.244.224.57 >> ~/.ssh/known_hosts`
3. `static/maintenance.html` exists on the VPS (restore from `deploy/maintenance.html` if missing)
4. Typecheck passes locally: `npx tsc --noEmit`

## After deploy — verify

```bash
ssh -i ~/.ssh/tacticalrmm_vps root@207.244.224.57 \
  "systemctl is-active spaceworker && curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3500/"
```

Expect: `active` and `200`.

## Notes

- `scripts/deploy-vps.sh` still defaults to the dead host `164.68.105.96` — **always override with `VPS_HOST=root@207.244.224.57`**.
- `--files-from` is mandatory. No bare directory syncs, no `..` in remote paths.
- Server-only runtime files (`.env`, `.next`, `node_modules`, `static/`, `engine-dist/`) are **protected** — never include them in a files-from list.
- Full build + restart runs automatically. If the build fails, maintenance stays ON and the previous build is rolled back.

## EXE builds (separate from web deploy)

The desktop EXE is built via GitHub Actions (`.github/workflows/build-exe.yml`), **not** by `deploy-vps.sh`. That workflow:

- Runs on `windows-latest` — builds Windows EXEs only
- Variants: `extractor`, `devices` (triggered manually via `workflow_dispatch`)
- Outputs: `.exe`, `.vbs` (devices variant), uploadable as a GitHub Release

There is **no macOS EXE build target** configured today. To get a Mac EXE, `build-exe.yml` would need a `macos-latest` job and a macOS tauri config — neither exists yet. Currently the only way to get an EXE on a Mac is to run `tauri build` locally on macOS with the Rust toolchain installed.
