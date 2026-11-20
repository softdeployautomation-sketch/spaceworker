# SpaceWorker — Merge Handoff

Two PRs are code-complete, build-verified, and ready for review + merge into `main`.

---

## PR #4 — Python Extraction Worker

**Branch:** `extraction-worker-dev`
**Link:** https://github.com/Mikeolab/spaceworker/pull/4

FastAPI worker at `worker/api.py`. Key details:

- Two `asyncio.Semaphore(1)` lanes — `light` and `heavy` — so a slow Google job never blocks a fast DDG job
- DuckDuckGo path: plain `requests` + BeautifulSoup, no browser (drops memory cost from ~400 MB to single-digit MB per job)
- Google path: Playwright `launch_persistent_context()` with a per-job throwaway profile under `/tmp/spaceworker-jobs/{jobId}/`, cleaned up unconditionally in `finally`
- Bearer token auth (`WORKER_AUTH_TOKEN`) on every route, listener bound to `127.0.0.1` only — never reachable from the public internet
- Per-job state in `dict[str, JobState]`, no module-level singleton — multiple jobs in different lanes run concurrently without interfering

---

## PR #5 — Job Queue, Lanes + Extraction UI

**Branch:** `queue-and-lanes-dev`
**Link:** https://github.com/Mikeolab/spaceworker/pull/5

**Depends on PR #4 being deployed first.**

### Schema additions (`prisma/schema.prisma`)

Three new models: `SearchJob`, `JobQueueEntry`, `Lead`. `JobQueueEntry.priorityTier` is a snapshot of `user.tier` at enqueue time and never updated — so mid-queue tier changes don't retroactively reorder already-waiting jobs.

### API routes

| Route | Description |
|---|---|
| `GET /api/jobs` | List current user's jobs |
| `POST /api/jobs` | Create job + queue entry in one `$transaction` |
| `GET /api/jobs/[id]` | Job detail + all leads |
| `POST /api/jobs/[id]/stop` | Cancel queued or running job |
| `POST /api/internal/dispatch` | Bearer-gated dispatcher (systemd → Next.js) |

### Dispatcher logic

- **Phase A**: for each lane, if no job is running, pop the highest-`priorityTier` queued entry (FIFO within tier) and dispatch it to the Python worker
- **Phase B**: poll all running jobs against the worker; on completion, write leads to `Lead` table and mark job done/failed

### Two separate bearer tokens

- `INTERNAL_BEARER_TOKEN` — gates `POST /api/internal/dispatch` (systemd → Next.js)
- `WORKER_AUTH_TOKEN` — gates Next.js → Python worker calls; never in client code

### UI

Extract dashboard at `/dashboard/extract` — search form with engine selector (DuckDuckGo / Google), job list with 4-second live polling, leads table.

### Deploy files

`deploy/dispatcher.service` + `deploy/dispatcher.timer` — runs every 10 seconds via systemd.

---

## After merging — three server-side steps to go live

### 1. Run the database migration

```bash
cd /path/to/spaceworker
npx prisma migrate deploy
```

### 2. Start the Python worker

```bash
cd /path/to/spaceworker/worker
pip install -r requirements.txt
uvicorn api:app --host 127.0.0.1 --port 8001
```

Wrap in a systemd service for persistence. Set `WORKER_AUTH_TOKEN` in the environment.

### 3. Install the dispatcher timer

Before installing, replace `%INTERNAL_BEARER_TOKEN%` in `deploy/dispatcher.service` with the actual value from `.env`:

```bash
sudo cp deploy/dispatcher.service deploy/dispatcher.timer /etc/systemd/system/
sudo systemctl enable --now dispatcher.timer
```

---

## Environment variables required (add to `.env` on the server)

```
WORKER_BASE_URL="http://127.0.0.1:8001"
WORKER_AUTH_TOKEN="<random secret>"
```

`WORKER_AUTH_TOKEN` must match what the Python worker is started with.
