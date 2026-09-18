# Task 48 Part B — Investigate `worker/api.py` idle memory growth

**Status: ready to build, QUEUED BEHIND Task 48 Parts A/C.** Written 2026-09-18, grounded in live measurements taken directly on the production VPS during this session, not assumed.

## The real gap, confirmed live (not assumed)

`worker/api.py`'s idle RSS grew from **~2.9GB to ~3.78GB over the course of a single day**, with **zero active jobs running** at the time of the second measurement — confirmed two ways: `ps aux --sort=-%mem` showed the process alone at 46.4% of total system memory, and a direct query against Postgres (`SELECT id,status,lane,"createdAt" FROM "SearchJob" WHERE status='running'`) returned zero rows at that exact moment. There were no leftover Chrome/Playwright processes either — `ps aux | grep -i chrome` returned zero.

Restarting `extraction-worker.service` with nothing running reclaimed the memory immediately — total system usage dropped from 6.1GB to 2.3GB in that same session. This rules out a measurement artifact: the process genuinely was NOT releasing memory back, and a clean restart proves there was nothing legitimately needing that memory at the time.

## What's suspected (not confirmed)

`worker/api.py` likely retains per-job state after a job completes instead of releasing it — candidates: search results, extracted HTML/PDF text, in-memory lead lists, or a cache keyed by job id that's never evicted. This is a guess based on the pattern (growth roughly correlated with job volume across the day), not a diagnosed root cause — that's the actual ask here.

## What to do

1. **Confirm the pattern is real and roughly job-count-correlated**, not something else (a slow leak unrelated to job volume, GC behavior, buffer pooling that looks like growth but isn't a real leak). Compare idle RSS after 1 job processed since last restart vs. after ~10-20 jobs. If it's flat regardless of job count, this isn't what it looks like — say so plainly rather than forcing a fix onto the wrong cause.
2. **If confirmed**, find what's actually being retained — check for module-level caches, a `JOBS` dict (referenced in existing comments elsewhere in this codebase around job-cleanup, e.g. the dispatcher's own "tell the worker to forget this job" DELETE call) that isn't actually being cleared, or large per-request objects (page HTML, PDF text buffers) held by closures/callbacks that outlive the request.
3. **Fix the retention** if found — release/clear whatever's being held once a job reaches a terminal state (done/failed/stopped), not just when the whole process restarts.
4. **If it turns out to be something else** (not a real leak — e.g. Python's allocator not returning freed memory to the OS, which can look identical to a leak from `ps` alone), document that clearly so this isn't re-investigated blind next time, and note whether a periodic restart is actually the right long-term mitigation in that case rather than a code fix.

## Priority context

Lower urgency than when first found — the VPS RAM upgrade (23GB, up from 7.8GB) gives roughly 10x more headroom, so this isn't actively threatening stability the way it was mid-session. Still a real, measured bug worth understanding and fixing properly. Queue behind Task 48 Parts A and C.

## Verification expected

- Live measurement on the actual production VPS (`ps aux --sort=-%mem`), not a local/dev-only repro — this bug only showed up under real job volume over real time.
- If a fix is made: restart the worker, run a realistic number of jobs (not just one), and confirm idle RSS afterward stays close to the pre-job baseline rather than climbing.
