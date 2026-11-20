# TASK_213 — V73 relay-on-device debug (STEPS, live log)

Owner goal: get the egress relay + browser clone working on **DESKTOP-V73JQPJ** (easier test box). WilkSF9 abandoned (offline since 10-15 18:44). V73 agent: `vaWaciiNFvgWPuYbpRZlfWNxxZkCjdDhYNVPYrLP`, Device row `cmv92r9u00athkph8zv4dif6f`. Ops-only task: no app code changed, nothing deployed, no commits.

Timebase warning: box DB audit timestamps are **UTC**; TRMM/schtasks on V73 show **UTC-5** local. (relay-install audit 00:38:45 UTC == task Last Run 7:38:41 PM local — same event, 4s apart.)

## Timeline (evidence)

| UTC | Event |
|---|---|
| 00:38:45 | `relay-install exit=0` (V73) — installer polled :8118 bound, task SpaceworkerRelay created + run |
| 00:39:20 | `relay-probe status=down` — 35s later, port already gone |
| 00:39→03:09 | sweep re-probes `down` every 5 min; Wilk rows = `vantra_503 offline`, CSFD = `vantra_404` (stale Device row, separate noise) |
| ~00:44 | box `clone-sweep` relays count 2→3 (unexplained yet — may be config count, not live conns) |
| 03:04 | battery1 on V73 (below) |
| 03:12 | battery2 manual relay run on V73 — **works perfectly** |

## Established facts (each with its evidence)

1. **Defender is innocent.** Battery1: exclusions present (paths `CloneTool`+`Relay`, processes incl. `hack-relay.exe`), `Get-MpThreatDetection` 14d = empty, Application event log 14d has **zero** hack-relay entries.
2. **Task SpaceworkerRelay exists, Enabled, SYSTEM, ONSTART, Last Result 0**, command line intact incl. `-tunnel 164.68.105.96:3402 -tunnel-key cmv92r9u00athkph8zv4dif6f` and full token.
3. **The process is gone now**: netstat no :8118, no hack-relay.exe. Relay dir has the binary (6512640b, matches staged size).
4. **Network + token + binary all fine**: battery2 manual run with identical args (only port 8119 instead of 8118) → `tunnel connected to 164.68.105.96:3402 as key "cmv92…"` + `egress relay listening on 127.0.0.1:8119`, alive after 14s (test-killed). `TCP3402=True` from the PC; box ingress `0.0.0.0:3402` listening (browser-server `startRelayIngress`, token `safeEqual` gate), ufw inactive.
5. **The relay exits cleanly (code 0) when spawned by the scheduled task**, but not when spawned manually under the TRMM agent. That delta is the whole bug.

## Hypotheses (discriminating test each)

- **H1 quoting/cwd of task spawn**: schtasks `/TR` mangled args or System32 cwd issue → EXACT args accepted fine manually, but verify task XML quoting anyway (S1).
- **H2 stale-instance race**: owner's FIRST attempt "said failed" but may have left an instance/task run; second installer killed :8118 holder then `/Run` while task still "running" → run no-op'd, old instance then died later. Explains bind-then-gone within 35s. Test: S2 watch live.
- **H3 tunnel-control lifetime**: instance connects then control conn drops and relay exits 0 on idle/keepalive mismatch. Test: S2 poll cadence + box `ss -tnp | grep 3402` while task instance runs.
- **H4 port 8118-specific**: my working manual test used 8119. Test in S2: manual run on 8118 with exact task args.

## Next steps

- **S1** `schtasks /Query /TN SpaceworkerRelay /XML` (via /root/trmm-cmd.py) — verify quoting/token intact.
- **S2** live watch: `schtasks /Run /TN SpaceworkerRelay`; poll every 3s × 45s (netstat :8118, tasklist hack-relay, box `ss -tnp|grep 3402`); after death capture LastTaskResult + fresh eventlog/WER/Defender deltas.
- **S3** if S2 confirms task-spawn death: pragmatic ship — keep a manually-started relay alive on :8118 (same args, survives proven), run `relay-probe` until `up`, then rerun the clone on V73. Fix the ONSTART durability (H2/H1) after.
- **S4** never re-run the full installer blindly (it kills the running relay at port preflight). Wilk stays offline; the `vantra_404` CSFD probe noise = stale Device row, note-only.

## Tooling on the box (ready)

`/root/trmm-cmd.py <agent_id> <ps1>` — posts `{cmd, shell:"powershell", custom_shell:null, timeout, run_as_user:false}` to `TRMM_API_BASE_URL` (`https://api.instaweb.top`) with `X-API-KEY` from `/opt/vantra/.env`. Battery files: `/root/v73-battery.ps1`, `/root/v73-battery2.ps1`. TRMM cmd calls take ~30–60s; run under `nohup … &` + poll the out-file.

Progress log lives at the bottom of this file; update after each step.

## RESOLUTION (2026-10-16 ~02:00 UTC) — ROOT CAUSE + FIX, RELAY GREEN

**Root cause: Windows Task Scheduler battery/idle defaults killed the relay.** The installer's task XML carries `schtasks` defaults `DisallowStartIfOnBatteries=true`, `StopIfGoingOnBatteries=true`, `StopOnIdleEnd=true`. V73 runs on battery (`PowerOnline=False`, 61%): the task could not start on battery (start got **Queued**, matching battery5) and a running instance is **stopped by the OS ~40s in with exit code 0** — matching: install 19:38:38, port gone by 19:39:20, `LastTaskResult: 0`, no Defender/eventlog traces. Manual (non-task) instances survive indefinitely → the binary/token/tunnel/network were always fine. Same defaults explain WilkSF9's identical "installs fine, dies in <60s" signature.

**Fix applied on V73 (battery6):** `Set-ScheduledTask` → `DisallowStartIfOnBatteries=False`, `StopIfGoingOnBatteries=False`, `StopOnIdleEnd=False`, `StartWhenAvailable=True`; killed my 8119 test instance; `schtasks /Run` → canonical relay on :8118. Verified: port+process alive 45s watch, task `Running`, tunnel ESTAB from 105.112.205.233 (box journal: clean control down→up), **app probe row `status:"up"` at 01:53:59 UTC (first green ever)**, survives AC plug-in (`PowerOnline:True/Charging:True`, still Running at 02:00 UTC).

**Permanent fix (follow-up task for task agent, code change):** add these four settings flags to the task XML template in `engine-dist/install-relay.ps1` so every future install is durable. Until deployed, one-line manual remedy on any affected PC: `Set-ScheduledTask -TaskName SpaceworkerRelay -Settings $((Get-ScheduledTask SpaceworkerRelay).Settings | ForEach-Object { $_.DisallowStartIfOnBatteries=$false; $_.StopIfGoingOnBatteries=$false; $_.IdleSettings.StopOnIdleEnd=$false; $_ })`.

**Owner action:** rerun the browser clone from the UI — relay-probe now passes; expect `live-capture-capability — native host not detected` to remain until the browser extension is deployed (known TASK_119A phase, not a relay fault).

## EXTENSION + NATIVE HOST DEPLOYED (2026-10-16 ~03:20 UTC)

Built `clone-native-host.exe` (PE32+ GUI x86-64, 7,003,648b, `GOOS=windows go build -ldflags "-H windowsgui -s -w" ./cmd/native-host` from `michael/browser-clone/engine`, Go 1.27 local) + `clone-extension.zip` (4 files, 9,957b from `engine/extension/`). **Both added to LOCAL `engine-dist/` + manifest.json** (so the next `deploy-vps.sh` carries them) and scp'd to `/opt/spaceworker/engine-dist/`. Transport = the app's own HMAC-signed `/api/clone-engine/<file>` route; signed URL minted on-box (python HMAC, secret `SESSION_SECRET`, exp now+3600, device `cmv92r9u…`) and verified: both HTTP 200, sha256 match.

Deployed to V73 via TRMM (`/root/v73-ext-deploy2.ps1`): exe+native-host manifest+extension extracted to **`C:\ProgramData\TacticalRMM\CloneTool\`** (NOT `C:\Program Files\TacticalRMM` — that dir does not exist on V73; first attempt failed `curl 23` for exactly that reason; the native host's config search covers exe-dir + CloneTool + Program Files, so CloneTool is fine and the token `live-capture.json` already lives there). Registered `com.spaceworker.clone` under HKLM NativeMessagingHosts for Chrome/Edge/Brave. Verification battery: `STEP:dl-native-host OK`, `STEP:dl-extension OK`, `STEP:native-host-register OK`, **`STEP:native-host-check OK` (identical to `buildNativeHostPresenceScript` → `live-capture-capability` will now register on next setup run)**, exe 7003648b, ext files=4, TOKENCFG True.

**Manual owner step (cannot be automated without a hosted CRX):** on V73's browser → `chrome://extensions` → Developer mode → Load unpacked → `C:\ProgramData\TacticalRMM\CloneTool\clone-extension` → approve "Read and change all your data on all websites" (deliberate: `chrome.cookies` needs host permission — manifest.json `_comment`). Then re-run the one-click setup (capability registers) and start a live clone — the extension's 30s silent poll asks the native host, which authenticates with the on-disk token (no browser login needed).

**Fleet follow-ups for the task agent:** (1) `install-registry.ps1` default `$BinDir='C:\Program Files\TacticalRMM'` is wrong for machines without the TRMM agent in Program Files — make BinDir default to the CloneTool dir / detect; (2) add native-host+extension fetch/stage/register steps to `clone-setup.ts` one-click flow (artifacts are already in engine-dist+manifest, so only the steps are missing); (3) policy-based force-install (ExtensionInstallForcelist + hosted CRX/update-manifest) to kill the manual Load-unpacked step.
