# Task 16 — Route search requests through SpaceWorker's own exit nodes when blocked

**Status: ready to implement.** Written 2026-09-08 after the user asked for DuckDuckGo/Google's anti-bot blocking on this VPS's own IP to be worked around by reusing infrastructure that already exists for a different feature. Research below is already done — implement against it rather than re-deriving it.

## Context

`worker/automation.py`'s own comments already document, from real live testing, that this VPS's IP gets blocked by both DuckDuckGo (`duckduckgo_search_http`'s docstring: roughly half of requests get served DDG's `anomaly-modal` anti-bot challenge instead of real results) and Google (`_resilient_page_content`'s docstring: "confirmed live 2026-09-06 that this VPS's IP gets captcha'd on the very first fresh-profile Google request"). Today, when that happens, the worker falls back to a real headless-browser request from the **same IP**, which doesn't actually dodge an IP-reputation-based block, and eventually just gives up on that query.

The user's ask: route a blocked request through a different IP as a fallback, and pointed out this doesn't need new infrastructure — SpaceWorker already has two working exit nodes for a different feature (Private Browser sessions).

## What already exists — reuse this, don't rebuild it

`lib/exit-nodes.ts` (Next.js side) defines SpaceWorker's own self-hosted SOCKS5 exit nodes:

```ts
export interface ExitNode {
  id: string; city: string; country: string; countryCode: string; flag: string;
  scheme: Exclude<ProxyScheme, "https">; host: string; port: number;
}
```

Read from env vars `EXIT_NODE_US` / `EXIT_NODE_CA` / `EXIT_NODE_UK`, format `scheme://host:port`, skipping any that aren't set (`listExitNodes()` filters to only configured ones). **Confirmed live on the VPS**, in `/opt/spaceworker/.env` (the main Next.js app's env — NOT currently in `worker/.env`):

```
EXIT_NODE_US=socks5://172.17.0.1:1090
EXIT_NODE_CA=socks5://172.17.0.1:1091
```

These are dedicated Fly.io Machines relayed onto the VPS host via `microsocks`/`socat` on `172.17.0.1` (the Docker bridge gateway — reachable from any process on the host, not just containers, so the extraction worker can reach them exactly the same way `browser-server/server.ts` does). UK has no value configured currently — code should still check for it (matching `lib/exit-nodes.ts`'s own 3-node metadata list) in case it's added later, but only US+CA will actually resolve today.

**Required manual step, not code** — flagging explicitly since it's easy to miss: `worker/.env` is a separate file from the main app's `.env` (the worker is a distinct systemd service/process with its own environment — see `PLAN.md`'s notes on `worker/.env` being VPS-provisioned, not part of this repo). The two `EXIT_NODE_*` lines above need to be added there too before this feature can work in production. **This is being handled by Claude as part of deploy oversight, not part of the Cline PR** — don't add secrets/env files to the repo.

## What to build

### 1. `_get_exit_nodes()` in `worker/automation.py`

Python-side equivalent of `lib/exit-nodes.ts`'s `listExitNodes()` — same env var names, same `scheme://host:port` format, so both sides of the app are configured from one set of values on the box:

```python
def _get_exit_nodes() -> list[dict]:
    nodes: list[dict] = []
    for env_key, label in (("EXIT_NODE_US", "US"), ("EXIT_NODE_CA", "CA"), ("EXIT_NODE_UK", "UK")):
        raw = os.environ.get(env_key, "").strip()
        if not raw:
            continue
        m = re.match(r"^([a-z0-9]+)://([^:/]+):(\d+)$", raw, re.I)
        if not m:
            continue
        nodes.append({"label": label, "scheme": m.group(1), "host": m.group(2), "port": int(m.group(3))})
    return nodes
```

Needs `import re` added to the file's imports (not currently imported).

### 2. Thread an optional `proxy: Optional[dict] = None` parameter through the Playwright call chain

Playwright has **native** SOCKS5 proxy support (`proxy={"server": "socks5://host:port"}` passed to `launch_persistent_context`) — no new pip dependency needed. Thread `proxy` through:

- `_launch_persistent_context(playwright, profile_dir, proxy=None)` — add `launch_kwargs["proxy"] = {"server": f"{node['scheme']}://{node['host']}:{node['port']}"}` when `proxy is not None`. The existing ENOENT/system-Chrome fallback branch already reuses `**launch_kwargs`, so it picks this up for free.
- `_resilient_page_content(profile_dir, url, captcha_markers, proxy=None)` — pass through to both `_launch_persistent_context` calls (the initial one and the "recreate context once" retry).
- `duckduckgo_search_playwright(query, max_results, job_dir, proxy=None)` — pass through to `_resilient_page_content`. **Use a separate profile directory per identity** (e.g. `ddg-profile` when `proxy is None`, `ddg-profile-us` / `ddg-profile-ca` otherwise) — don't reuse the direct-IP profile for a proxied request, to avoid mixing cookies/session state across what DuckDuckGo would otherwise see as two different visitors.
- `google_search(query, max_results, job_dir, start=0, proxy=None)` — same treatment, `chrome-profile` / `chrome-profile-us` / `chrome-profile-ca`.
- `google_search_paginated(query, max_results, pages_per_query, job_dir, on_step=None, proxy=None)` — pass `proxy` through to each `google_search(...)` call in its loop.

(`duckduckgo_search_paginated`, the multi-page DDG crawler added in the same session as the max_results/clamp fixes, is a nice-to-have extension of this same pattern but not required for this task — its own page-1 retry/backoff can stay direct-IP-only for now. Extend it later if the plain single-page path's fallback proves insufficient.)

### 3. Wire the actual fallback chain into `search_phase()`

Add a small helper right before `search_phase`:

```python
async def _duckduckgo_with_exit_nodes(pdf_query: str, max_results: int, job_dir: str) -> list[SearchResult]:
    """Last resort after a direct-IP DDG attempt (HTTP + Playwright) is confirmed
    blocked: cycle through SpaceWorker's own US/CA exit nodes until one gets
    through. Raises DDGBlockedError only once every configured node has failed."""
    for node in _get_exit_nodes():
        try:
            return await duckduckgo_search_playwright(pdf_query, max_results, job_dir, proxy=node)
        except _BlockedByCaptchaError:
            continue
    raise DDGBlockedError(
        "DuckDuckGo blocked this request on every available path (direct + all configured exit nodes)"
    )
```

Then in `search_phase`'s **DDG default (single-page) branch**, extend the existing fallback:

```python
loop = asyncio.get_event_loop()
try:
    return await loop.run_in_executor(None, duckduckgo_search_http, pdf_query, max_results)
except DDGBlockedError:
    try:
        return await duckduckgo_search_playwright(pdf_query, max_results, job_dir)
    except _BlockedByCaptchaError:
        return await _duckduckgo_with_exit_nodes(pdf_query, max_results, job_dir)
```

And in the **Google branch**, retry Google itself through the exit nodes before falling back to DuckDuckGo entirely (staying on the originally-requested engine is more aligned with intent than silently switching engines the moment a block is hit):

```python
if engine == "google":
    pdf_query = _bias_query_toward_pdfs(query)
    try:
        return await google_search_paginated(pdf_query, max_results, pages_per_query, job_dir, on_step)
    except _BlockedByCaptchaError:
        for node in _get_exit_nodes():
            try:
                return await google_search_paginated(pdf_query, max_results, pages_per_query, job_dir, on_step, proxy=node)
            except _BlockedByCaptchaError:
                continue
        # Every exit node also blocked — existing behavior: fall back to DDG
        # rather than failing the query outright.
        if on_step is not None:
            await on_step(f"Google blocked — falling back to DuckDuckGo for: {query}")
        loop = asyncio.get_event_loop()
        try:
            return await loop.run_in_executor(None, duckduckgo_search_http, pdf_query, max_results)
        except DDGBlockedError:
            try:
                return await duckduckgo_search_playwright(pdf_query, max_results, job_dir)
            except _BlockedByCaptchaError:
                return await _duckduckgo_with_exit_nodes(pdf_query, max_results, job_dir)
```

## Explicit design constraints (don't deviate without flagging why)

- **Exit nodes are a last resort, never the default.** Direct-IP requests already succeed most of the time and cost nothing — proxying every request would be slower for zero benefit on the requests that would have worked anyway. Only reach for a node after the existing direct attempts are confirmed blocked (a real `_BlockedByCaptchaError`/`DDGBlockedError`, not proactively).
- **Cycle through all configured nodes before giving up** (today: US then CA, in the order `_get_exit_nodes()` returns them) — matches the user's own framing ("we can switch between that").
- **No new Python dependency.** Playwright's proxy support is built in; don't add `PySocks`/`requests[socks]` — the raw-HTTP path (`duckduckgo_search_http`) is intentionally left un-proxied in this task (routing that through a SOCKS proxy would need an extra dependency for comparatively little benefit versus just falling to the already-existing Playwright fallback).
- **Separate browser profile per identity**, not a shared one — see point 2 above.

## Verification

1. `python3 -c "import ast; ast.parse(open('worker/automation.py').read())"` and a full `npx tsc --noEmit` / `npm run build` regression pass (this file has no direct TS callers, but the repo-wide build should stay green).
2. Confirm `_get_exit_nodes()` returns `[]` when neither env var is set (must not crash — this is the current state of `worker/.env` until the manual step above is done) and that every function's `proxy=None` default path is completely unchanged from today's behavior (no proxy config, no new profile-directory suffix) — this task must not alter behavior for the common, un-blocked case.
3. Once `EXIT_NODE_US`/`EXIT_NODE_CA` are added to `worker/.env` and the extraction-worker service is restarted (Claude will handle this VPS-side step), run a real job and confirm via `on_step`/job logs that a deliberately-forced block (or a real one, if DDG happens to block during testing) actually falls through to an exit node rather than just failing the query — don't just trust that the code compiles.
