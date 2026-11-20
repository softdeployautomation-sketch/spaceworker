# Cyber Lab Agent — Real Attacker Mode + Terminal Access

## Status: COMPLETE — Deployed & Verified on VPS

## Changes Made

### 1. `lib/lab/cline-agent.ts` — `buildCyberLabSystemPrompt` rewritten
- **Removed** teacher-default framing ("TEACHING MODE", "bug-hunting teacher", 5-step lesson map)
- **Added** offensive-security assessment agent tone: acts like a real security tester against attested targets
- **Removed** "avoid destructive payloads" language — replaced with "prove each issue with the smallest real test that confirms exploitability"
- **Added** takeover path: chain findings into a realistic compromise demonstration (step-by-step, each approved)
- **Added** `TERMINAL` prefix: user messages starting with `[TERMINAL]` run direct shell commands — no refusal
- **Added**: if user names a website/IP, treat as attested target goal and start attack loop immediately
- **Updated**: all security scanners confirmed installed on host (nmap, masscan, ffuf, dirb, hydra, nuclei, sqlmap, dnsrecon)

### 2. `components/cyberlab-agent-console.tsx` — Terminal Access button + panel
- **Added** "Terminal Access" / "Hide Terminal" toggle button in Session Controls
- **Added** terminal panel: command input, output display, runs via `[TERMINAL] run: <cmd>` prefix
- **Added** `sendTerminalCommand` function that sends commands through the agent session
- **Updated** `NORMAL_KICKOFF` to direct the agent to treat named website/IP as an attested target and start the attack loop

### 3. VPS System Tools Installed (on `207.244.224.57`)
All security scanners installed and working:
| Tool | Path |
|------|------|
| nmap | /usr/bin/nmap |
| ffuf | /usr/local/bin/ffuf |
| dirb | /usr/bin/dirb |
| hydra | /usr/bin/hydra |
| nuclei | /usr/local/bin/nuclei (v3.11.1) + templates |
| sqlmap | /usr/bin/sqlmap |
| masscan | /usr/bin/masscan |
| dnsrecon | /usr/bin/dnsrecon |
| curl/dig/whois/nc/jq/python3/node | /usr/bin/ |

### 4. Deployment to VPS `207.244.224.57`
- All changes synced via `scripts/deploy-vps.sh`
- BUILD_ID: `-mWCxptk4BT847C4o5drL` (new build live)
- Service: active, HTTP 200
- Runtime integrity verified (.env, .next, node_modules, static/maintenance.html)
- Maintenance OFF

## Verification
- `npx tsc --noEmit` → clean (exit 0)
- `npm run test:lab` → 97/97 pass, 0 fail
- VPS live: service active, cyberlab status responds, terminal button present, attacker prompt present, all tools installed

## What Changed for Users
- Agent no longer refuses takeover attempts on attested targets — it proposes real attack steps (scan, enumerate, validate, prove impact, takeover path) each for human approval
- All security tools (nmap, ffuf, dirb, hydra, nuclei, sqlmap, masscan, dnsrecon) are installed and working on the VPS
- Passcode/login form/WAF is documented as a control, then bypass/validation attempted (with approval)
- Users can hit "Terminal Access" and run shell commands directly when the agent says no
- Normal chat mode still available for casual conversation
