# Task 22 — Process query variations in concurrent batches, not one at a time

**Status: ready to implement. Real, confirmed bottleneck — read the evidence below before touching the pause/resume logic, which this task must handle carefully.** Written 2026-09-11.

## The confirmed problem

Live-tested: a job with `minResults: 5000` ran for its full time budget, tried "a large set of related-term variations" (per the job's own completion message), and still only found 15 leads. This is not a search-quality problem — a separate live test (same session) confirmed the query-biasing fix (`intext:@`) genuinely surfaces rich, email-containing PDF results even for generic queries. The actual bottleneck is architectural, confirmed directly in `run_automation`:

```python
for qi in range(start_index, len(ordered_queries)):
    term = ordered_queries[qi]
    ...
    leads = await _search_and_extract([term], params, job_dir, on_progress, seen_urls, domain_rules, on_step)
    all_leads.extend(leads)
```

This is a plain, strictly sequential loop — one query variation is fully searched and all of its results fully extracted before the next query variation even starts. `_search_and_extract` already processes every result *within* one query concurrently (`asyncio.gather`), but query variations themselves never run alongside each other. With a large `minResults` target, `_build_ordered_queries` can generate up to `MAX_TOTAL_QUERIES` (300) variations — but if each one takes real wall-clock time (a search round-trip plus extracting every one of its results, one full query at a time), the time budget runs out after a small number of queries regardless of how many good variations exist to try. This is very likely why "zero server load" was observed earlier in this project's testing too — not evidence against concurrency existing, but a real sign that query-level throughput specifically was the limiting factor.

## The fix: batch query variations, process each batch concurrently

Reuse the exact concurrency pattern `_search_and_extract` already has for its "multi-query path" (`asyncio.gather(*(_search_one(q) for q in query_list), return_exceptions=True)`) — apply that same idea to the OUTER query loop in `run_automation`, not just within one query's results.

```python
QUERY_BATCH_SIZE = 5  # tune based on real timing data once this ships -- see Verification

qi = start_index
while qi < len(ordered_queries):
    if min_results is not None and min_results > 0 and prior_found + len(all_leads) >= min_results:
        break  # minimum reached — normal completion
    if should_stop is not None and await should_stop():
        paused = True
        pause_reason = "manual"
        stopped_at = qi
        break
    if time.monotonic() >= deadline:
        paused = True
        pause_reason = "duration_cap"
        stopped_at = qi
        break

    batch = ordered_queries[qi : qi + QUERY_BATCH_SIZE]

    async def _run_one_query(term: str) -> list[dict] | Exception:
        try:
            return await _search_and_extract(
                [term], params, job_dir, on_progress, seen_urls, domain_rules, on_step
            )
        except Exception as e:
            return e

    batch_results = await asyncio.gather(*(_run_one_query(t) for t in batch))

    batch_failures = 0
    for r in batch_results:
        if isinstance(r, Exception):
            batch_failures += 1
        else:
            all_leads.extend(r)

    if batch_failures == len(batch):
        # Every query in this batch failed -- same "looks like an outage"
        # reasoning as the existing consecutive-failure check, just at batch
        # granularity now. Pause AT the start of this batch so resume retries
        # all of it, rather than treating a full-batch wipeout as isolated
        # per-query noise.
        consecutive_failures += 1
        if consecutive_failures >= CONSECUTIVE_FAILURE_PAUSE_THRESHOLD:
            paused = True
            pause_reason = "outage"
            stopped_at = qi
            if on_step is not None:
                await on_step(
                    f"{consecutive_failures} batch(es) in a row failed entirely — pausing, will retry automatically"
                )
            break
    else:
        consecutive_failures = 0

    qi += len(batch)
```

## Why this specific design, and what it deliberately changes about existing behavior

- **`seen_urls` is a shared, mutated set already passed into every `_search_and_extract` call** — confirmed this stays correct under concurrent batch execution: each query in a batch still dedupes against the SAME shared set, so two queries in the same batch that happen to surface the same URL still only process it once between them (whichever task's `if r.url not in seen_urls` check runs first "wins" — a benign race, not a correctness bug, since the outcome either way is "processed once, not duplicated").
- **Pause/deadline checks move from per-query to per-batch granularity.** This is a real, deliberate change to existing behavior: today, a manual pause or the duration cap is observed after *every single query*; with batching, up to `QUERY_BATCH_SIZE` queries may complete before the next check. This is an acceptable tradeoff for the throughput gain, but say so explicitly if asked — this task is not a no-op change to pause timing precision, it trades some of that precision for meaningfully faster overall progress.
- **The consecutive-failure/outage-pause logic is reinterpreted at batch granularity** (a whole batch failing outright, not one query failing in isolation) — a single query failing within an otherwise-successful batch is no longer specially isolated/counted the way the old per-query loop did (via `continue`), since a batch's individual query failures are now captured via `return_exceptions`-style handling and just don't contribute leads, without needing per-query retry bookkeeping. Only a **fully-failed batch** (every query in it errored) is treated as an outage signal.
- **`resume_state["nextQueryIndex"]` becomes "the start of the next unprocessed batch,"** not "the exact next query" — since `qi` now advances by `len(batch)` at a time. A resumed job re-starts from the beginning of whichever batch was in flight (or about to start) when the job paused, which may very rarely re-process a query that was already mid-flight in an interrupted batch — acceptable given `seen_urls` (also persisted in `resume_state`) prevents that from producing duplicate leads even if a URL gets fetched twice.

## Explicitly out of scope

- Not changing `_search_and_extract`'s own internal concurrency (per-result `asyncio.gather`) — that part is already correct and unaffected by this task.
- Not making `QUERY_BATCH_SIZE` user-configurable in this pass — a fixed, tunable-by-a-future-task constant is enough for now.
- Not touching `CONSECUTIVE_FAILURE_PAUSE_THRESHOLD`'s numeric value here — a separate task (Task 19, Piece 1) already raises it 3→5; this task only changes what "one failure" means (a whole failed batch, not a single failed query).

## Verification

1. `python -m py_compile worker/automation.py`.
2. Run a real job with a large `minResults` target (matching the 5000 case that surfaced this) and time how many query variations actually get attempted within the same overall duration cap compared to before this change — this is the concrete number that proves (or disproves) the throughput improvement; expect roughly `QUERY_BATCH_SIZE`x more queries attempted in the same wall-clock time, though real gains will be lower than a naive multiple given shared network/CPU contention.
3. Confirm a manual pause and the duration cap both still work — a job paused mid-batch should resume correctly from the right point next time, with no duplicate leads (check `seen_urls` carries over correctly).
4. Confirm the outage-pause behavior: force several consecutive batches to fail entirely (e.g., point at an unreachable search endpoint temporarily in a test environment) and confirm the job pauses with `pauseReason: "outage"` rather than running to a false "done" with near-zero leads.
5. Tune `QUERY_BATCH_SIZE` based on real timing data from step 2 — start at 5, adjust up if the VPS clearly has headroom (low CPU/memory pressure even under this load) or down if batches start visibly contending with each other (e.g., more results hitting `PER_RESULT_HARD_TIMEOUT_SECONDS` than before, suggesting the batch size itself is causing resource contention rather than curing the throughput problem).
