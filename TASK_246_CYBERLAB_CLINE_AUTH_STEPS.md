# TASK_246 — Cyber Lab Cline free-tier auth: "fetch failed" + never auto-connects

Status: IN PROGRESS · Owner: agent · Started 2026-10-27
Decision (owner): **P0 + P1 in one task** · token key: **derived from `SESSION_SECRET`**
(env override `CLINE_TOKEN_ENCRYPTION_KEY` supported if added later) · **no schema change, no migration, no `.env` edit**.

---

## 1. BEFORE — evidence captured on the live box (read-only)

### 1.1 The screenshot's "fetch failed" is the server's raw `TypeError`
`app/api/clin/auth/callback/route.ts` did:

```ts
const CLINE_API_BASE_URL = process.env.CLINE_API_BASE_URL ?? "https://api.cline.com";
...
const credentials = await completeClineDeviceAuth({ ..., apiBaseUrl: CLINE_API_BASE_URL });
...
return NextResponse.json({ error: msg }, { status: 500 });
```

`api.cline.com` is **not a real host**:

```
$ getent hosts api.cline.com            # (empty)
$ curl -sS https://api.cline.com         # curl: (6) Could not resolve host: api.cline.com
$ getent hosts api.cline.bot             # 35.186.247.105
```

The SDK's own production config is `apiBaseUrl: "https://api.cline.bot"`
(`@cline/core/dist/index.js`, `dw.production`). Its device flow polls WorkOS, then
`POST ${apiBaseUrl}/api/v1/auth/register`. The dead host throws undici
`TypeError: fetch failed`, which the catch block returned verbatim as a 500 JSON
`{error:"fetch failed"}` — exactly the screenshot.

Probe of the real endpoint with the SDK payload shape (camelCase) returned Cline's
own validation body (`"failed to refresh tokens ... invalid_grant"`), i.e. host +
payload shape are correct; only our constant was wrong.

### 1.2 Auto-connect is structurally impossible
The 2026-10-27 "auto-poll" (commit `ce7373f`) polls `GET /api/clin/auth/me`, which
only reads the DB. Tokens are written **only** by the manual `POST /callback`.
Nothing server-side ever polls Cline/WorkOS, so waiting can never connect.

Live DB at the time of diagnosis:

```
ClineDeviceAuth rows               = 8
  ... with expiresAt > now()       = 0
CyberLabAgentSettings with tokens  = 0
```

Eight abandoned attempts, zero completions.

### 1.3 A successful connect would still not power sessions
- `lib/lab/cline-agent.ts:317` and `:500` pass `settings.clineOAuthTokenEnc`
  (XOR ciphertext) as the SDK `apiKey`.
- The OAuth branch was gated on `input.providerId === "cline-free"`, and
  `app/api/cyberlab/agent/session/route.ts` never sends `providerId` → dead branch.
- `/me` did `JSON.parse(decryptToken(...))` on a bare access token → email always null.
- No expiry/refresh stored or used; `logout` used `update` → 500 when no settings row.
- Tokens stored with XOR + hardcoded default key, access/refresh only.

### 1.4 Build/deploy truth at diagnosis
- `BUILD_ID` = `naydyU-c0cCO2MR88h__b`, mtime 2026-10-27 15:38 (after HEAD 14:42).
- Deployed server chunk `[root-of-the-server]__10wwkbd._.js` (imported by
  `app/api/clin/auth/callback/route.js`) contains **both** the newest
  "Still pending" code **and** `api.cline.com` → latest fix is live and still broken.
- Service `spaceworker` on :3500, `/opt/spaceworker`, `User=trmm`; env has
  `SESSION_SECRET`, no `CLINE_*` vars.

### 1.5 SDK facts used by the fix
- `startClineDeviceAuth` / `completeClineDeviceAuth` / `refreshClineToken` /
  `getValidClineCredentials` exported by `@cline/sdk`.
- `getValidClineCredentials` contract: `null` only when the refresh token was
  rejected (re-auth); **throws** on transient failures → keep tokens, retry.
- `completeClineDeviceAuth({deviceCode, expiresInSeconds, pollIntervalSeconds, apiBaseUrl})`
  throws `ClineOAuthTokenError` (not exported) with `.status` / `.errorCode` and
  messages such as `WorkOS device authorization timed out`, `expired_token`, `access_denied`.
- Credentials shape: `{access, refresh, expires(ms), email?, accountId?, metadata?}`.

---

## 2. Design (no schema / migration)

1. `lib/clin/config.ts` — `getClineApiBaseUrl()` = `CLINE_API_BASE_URL?.trim() || "https://api.cline.bot"`.
2. `lib/clin/token-crypto.ts` — AES-256-GCM envelope `v1:<iv>.<tag>.<ct>` (base64),
   key `scryptSync(CLINE_TOKEN_ENCRYPTION_KEY || SESSION_SECRET, "spaceworker/cline/v1", 32)`;
   legacy XOR rows still decode (`:` is not in base64, so no ambiguity).
3. `lib/clin/token-store.ts` — full credentials JSON in `clineOAuthTokenEnc`
   (`{access, refresh, expires, email, accountId, metadata}`), refresh via SDK
   `getValidClineCredentials`; `null` → clear stored tokens; transient throw → keep.
4. `lib/clin/device-auth.ts` — single `pollClineDeviceAuth()` returning
   `connected | pending | expired | denied | unreachable`; single-flight per device
   code; row deleted only on success/terminal expiry; never echoes raw transport text.
5. `POST /api/clin/auth/poll` — what the browser polls. `callback` becomes an alias
   (immediate 15s check) so old clients keep working.
6. `login` — correct host, prune expired rows, return `expiresAt`.
7. `me` — decrypt real creds (email/accountId/expiresAt), `needsReconnect` on unreadable.
8. `logout` — `updateMany` + delete device rows (no 500 when disconnected).
9. `components/cline-settings-card.tsx` — sequential poll of `/poll`; 202 = pending
   (panel stays); 410 → "Code expired — get a new code"; countdown; models reload on connect.
10. `lib/lab/cline-agent.ts` — resolve key: explicit request key > OAuth (decrypted,
    refreshed) > stored manual key; wire into start **and** resume.
11. `PLAN_CYBERLAB_AGENT_RUNTIME.md` — record P4.7 root cause.

---

## 3. Edit ledger (updated BEFORE and AFTER each batch)

| # | Batch | Status | Evidence |
|---|-------|--------|----------|
| B0 | Plan + BEFORE evidence | DONE | §1 above |
| B1 | `lib/clin/config.ts`, `lib/clin/token-crypto.ts` | DONE | 2 new files: `.bot` default + AES-GCM `v1:` seal/unseal with legacy XOR fallback |
| B2 | `lib/clin/token-store.ts`, `me`, `login`, `logout` | DONE | Full creds JSON in `clineOAuthTokenEnc`; `getValidClineCredentials` refresh (null→clear, throw→keep); `me` returns email/expires/needsReconnect; `login` prunes rows + `expiresAt`; `logout` uses `updateMany` + deletes device rows |
| B3 | `lib/clin/device-auth.ts`, `/poll`, `callback` alias | DONE | Single poller; duck-typed `errorCode`; `fetch failed`→502 "Could not reach Cline's API"; 202/410/403/502 mapping shared |
| B4 | `components/cline-settings-card.tsx` | DONE | Sequential `setTimeout` POST `/poll`; 202 keeps panel; countdown + auto-expire; "Check now" button; models reload on connect; `.bot` placeholder |
| B5 | `lib/lab/cline-agent.ts` OAuth wiring | DONE | `request > decrypted OAuth > manual`; start+resume; resume now sends SDK `providerId:"cline"` (was our `cline-free` label) |
| B6 | Tests | DONE | 3 new files + TASK_246 cases in the spike test; 48/48 targeted pass |
| B7 | Gates (tsc / targeted / full / eslint) | DONE | tsc clean · targeted 48/48 · full 1846 pass / 17 fail / 1 skip — **all 17 fail on HEAD too** (proved in a clean worktree: 11 in 5 files + 6 in `task-236-safe-move`) · eslint: new/changed files clean; `cline-agent.ts` has 2 pre-existing `require()` errors (8→6 problems vs HEAD) |
| B8 | Docs + commit + deploy + live verify | IN PROGRESS | |

---

## 4. AFTER (fill after each batch; final post-deploy proof at the end)

- [ ] Local gates: `npx tsc --noEmit` → (record)
- [ ] Targeted tests → (record)
- [ ] Full `npm test` → (record vs floor 1682 pass / 0 fail / 1 skip)
- [ ] eslint touched files → (record)
- [ ] BUILD_ID old `naydyU-c0cCO2MR88h__b` → new (record)
- [ ] `grep -rl "api.cline.com" .next/server` → 0
- [ ] Deployed chunk sourcesContent has `https://api.cline.bot`
- [ ] Anon `/api/clin/auth/poll` + `/login` → 401
- [ ] Session-minted `POST /login` → device code; immediate `POST /poll` → 202 pending
- [ ] Owner approves → panel flips to Connected **without Confirm**; `/me` email set;
      `ClineDeviceAuth` row gone; token row starts `v1:`
- [ ] Real free-model Cyber Lab session starts and replies
- [ ] Regression: manual API key path, logout while disconnected
