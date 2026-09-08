#!/usr/bin/env python3
"""SpaceWorker extraction worker — FastAPI job API (Task 2).

Pure API layer; all extraction logic lives in automation.py. Nothing here imports
from the Next.js app.

- Bearer-token auth on every route (via WORKER_AUTH_TOKEN; required; no default).
- Binds to 127.0.0.1 only — never reachable from outside the box.
- Two lane semaphores ("light"/"heavy"), one concurrent job per lane.
- Per-job state lives in a plain dict[jobId, JobState] — replaced the original
  module-level singleton that held exactly one job globally.
- Every job's temp directory is deleted unconditionally in a finally block.
- Completed jobs are pruned from JOBS after 1 hour to prevent unbounded growth.
"""

from __future__ import annotations

import asyncio
import datetime
import os
import re
import secrets
import shutil
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any, Optional

from dotenv import load_dotenv

load_dotenv()

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from pydantic import BaseModel, Field

from automation import run_automation

JOB_DIR_DEFAULT = "/tmp/spaceworker-jobs"
LANES = ("light", "heavy")
# A caller-supplied jobId is joined directly into a filesystem path (job_dir) below —
# restrict it to a safe charset so a caller can't path-traverse (e.g. jobId="../../etc").
_SAFE_JOB_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,200}$")
_JOB_TTL_SECONDS = 3600  # prune done/failed jobs after 1 hour
_JOB_CLEANUP_INTERVAL_SECONDS = 300  # background prune cadence, independent of request traffic


@dataclass
class JobState:
    status: str  # "running" | "done" | "failed" | "paused"
    leads: list[dict] = field(default_factory=list)
    error: Optional[str] = None
    task: Optional[asyncio.Task] = None
    job_dir: str = ""
    completed_at: Optional[datetime.datetime] = None
    # Task 13 resumable jobs: set by POST /jobs/{id}/pause and observed by
    # run_automation()'s outer loop at each query boundary; resume_state holds the
    # "start here" payload persisted by the dispatcher when the job pauses.
    pause_requested: bool = False
    resume_state: Optional[dict] = None
    # Task 14 live activity feed: the current crawler step as a short text string
    # ("Searching: …", "Visiting page N …", "Reading a PDF at …"). Overwritten by
    # the on_step callback as the job progresses, exactly like `status` is — no
    # history of past steps is kept. Always present (defaults to "") so the
    # extract page can render something even before the first tick reports a step.
    current_step: str = ""


# Per-job state only — keyed by jobId; never a single shared singleton.
JOBS: dict[str, JobState] = {}


async def _job_should_pause(state: JobState) -> bool:
    """True once POST /jobs/{id}/pause has been called for this job. Awaitable so
    run_automation()'s query-boundary check (`await should_stop()`) can await it."""
    return state.pause_requested


def _prune_old_jobs() -> None:
    now = datetime.datetime.utcnow()
    # "paused" included alongside "done"/"failed" (Task 13) — a paused job the
    # dispatcher never re-acks (see the explicit pop() in Phase B's paused
    # branch) or that's simply never resumed would otherwise sit in memory
    # forever, since only these three statuses ever stop being polled/touched.
    stale = [
        jid for jid, s in JOBS.items()
        if s.status in ("done", "failed", "paused")
        and s.completed_at is not None
        and (now - s.completed_at).total_seconds() > _JOB_TTL_SECONDS
    ]
    for jid in stale:
        JOBS.pop(jid, None)


class JobRequest(BaseModel):
    # This is a display/fallback field only — run_automation() uses
    # params["queries"] (the real multi-term list) whenever it's present, and
    # only falls back to this single string when it's not. The dispatcher
    # (app/api/internal/dispatch/route.ts) sends it as ALL of a job's search
    # terms joined with " | " for the job list's display label, so a tight
    # max_length here rejects legitimate multi-term jobs outright: confirmed
    # live, a 20-term job produced a >500-char joined string and got a 422
    # before the search even started, with no indication why. Generous cap
    # (not unbounded) just to keep a pathological payload from being stored
    # forever, not because this length is ever load-bearing for search logic.
    query: str = Field(..., min_length=1, max_length=20000)
    params: dict[str, Any] = Field(default_factory=dict)
    # Confirmed against the real dispatcher (app/api/internal/dispatch/route.ts on
    # the queue-and-lanes-dev branch — not on this branch, easy to miss if you only
    # check the current one): it POSTs {jobId: <SearchJob.id>, query, params, lane}
    # and reads back {jobId} from our response as the value it stores as
    # SearchJob.workerJobId — so echoing back the same id the caller sent (rather
    # than minting our own) is what keeps the two systems in one id space. `lane`
    # is top-level in the real request, not nested under params.
    jobId: Optional[str] = Field(default=None, max_length=200)
    lane: Optional[str] = None


def require_token(authorization: Optional[str] = Header(None)) -> None:
    token = os.getenv("WORKER_AUTH_TOKEN", "")
    expected = f"Bearer {token}"
    if not token or not authorization or not secrets.compare_digest(authorization, expected):
        raise HTTPException(status_code=401, detail="Unauthorized")


def get_lane(req: "JobRequest") -> str:
    # Real caller sends lane top-level; params.lane fallback kept only in case a
    # future caller nests it there instead.
    lane = req.lane or req.params.get("lane")
    if lane not in LANES:
        raise HTTPException(status_code=400, detail="lane (or params.lane) must be 'light' or 'heavy'")
    return lane


async def _periodic_cleanup() -> None:
    """Background prune loop — runs regardless of whether any client ever polls
    GET /jobs/{id}, so a fire-and-forget caller that never polls to completion
    still can't leak JOBS entries forever."""
    try:
        while True:
            await asyncio.sleep(_JOB_CLEANUP_INTERVAL_SECONDS)
            _prune_old_jobs()
    except asyncio.CancelledError:
        pass


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not os.getenv("WORKER_AUTH_TOKEN"):
        raise RuntimeError("WORKER_AUTH_TOKEN is not set - refusing to start")

    os.makedirs(os.getenv("WORKER_JOB_DIR", JOB_DIR_DEFAULT), exist_ok=True)

    app.state.lanes = {
        "light": asyncio.Semaphore(1),
        "heavy": asyncio.Semaphore(1),
    }
    cleanup_task = asyncio.create_task(_periodic_cleanup())
    try:
        yield
    finally:
        cleanup_task.cancel()
        try:
            await cleanup_task
        except asyncio.CancelledError:
            pass


app = FastAPI(dependencies=[Depends(require_token)], lifespan=lifespan)


@app.post("/jobs", status_code=200)
async def create_job(req: JobRequest, request: Request) -> dict:
    lane = get_lane(req)

    if req.jobId:
        if not _SAFE_JOB_ID_RE.match(req.jobId):
            raise HTTPException(
                status_code=400,
                detail="jobId must match ^[A-Za-z0-9_-]{1,200}$ (it's used as a filesystem directory name)",
            )
        if req.jobId in JOBS:
            raise HTTPException(status_code=409, detail="jobId already exists")
        job_id = req.jobId
    else:
        job_id = str(uuid.uuid4())

    job_dir = os.path.join(os.getenv("WORKER_JOB_DIR", JOB_DIR_DEFAULT), job_id)
    os.makedirs(job_dir, exist_ok=True)

    state = JobState(status="running", job_dir=job_dir)
    JOBS[job_id] = state

    async def on_progress(lead: dict) -> None:
        state.leads.append(lead)

    async def on_step(text: str) -> None:
        # Task 14 live activity feed — overwrite, don't append: current_step is a
        # single live status line (like state.status), not an activity log.
        state.current_step = text

    async def run_job() -> None:
        sem = app.state.lanes[lane]
        acquired = False
        try:
            await sem.acquire()
            acquired = True
            try:
                result = await run_automation(
                    req.query,
                    req.params,
                    job_dir,
                    on_progress=on_progress,
                    should_stop=lambda: _job_should_pause(state),
                    on_step=on_step,
                )
                if result.status == "paused":
                    # Paused (manual pause or max-duration cap): keep state.leads
                    # and record the resumeState so the dispatcher can persist both
                    # and a later resume continues from this point. Distinct from a
                    # hard cancel (below), which discards the job.
                    state.status = "paused"
                    state.resume_state = result.resume_state
                elif state.status != "failed":
                    state.status = "done"
            except asyncio.CancelledError:
                state.status = "failed"
                state.error = "cancelled"
                raise
            except Exception as e:
                state.status = "failed"
                state.error = str(e)
        except asyncio.CancelledError:
            state.status = "failed"
            state.error = "cancelled"
            raise
        except Exception as e:
            state.status = "failed"
            state.error = str(e)
        finally:
            state.completed_at = datetime.datetime.utcnow()
            # NOTE (Task 13): shutil.rmtree only removes this job's throwaway
            # browser profile dir, never state.leads — leads live in memory
            # (state.leads) and are read by the dispatcher via GET /jobs/{id}, so
            # a paused job's leads are safe here and are never lost to cleanup.
            shutil.rmtree(job_dir, ignore_errors=True)
            if acquired:
                sem.release()

    state.task = asyncio.create_task(run_job())
    return {"jobId": job_id}


@app.get("/jobs/{job_id}")
async def get_job(job_id: str) -> dict:
    _prune_old_jobs()
    state = JOBS.get(job_id)
    if state is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return {
        "status": state.status,
        "leads": state.leads,
        "error": state.error,
        # Task 14 live activity feed — always present (unlike resumeState), so a
        # frontend can always render a "currently doing X" line for a live job.
        "currentStep": state.current_step,
        # Task 13 resumable jobs — present only once a job has paused, so the
        # dispatcher can persist it as SearchJob.resumeState.
        **({"resumeState": state.resume_state} if state.resume_state is not None else {}),
    }


def _stop_job(job_id: str) -> dict:
    """Cancel (if actually running) and always forget this job's in-memory
    state — used both as the real "stop a live job" verb and (Task 13) as the
    dispatcher's post-persist cleanup call for a job it just read as "paused",
    so a resumed job can be re-dispatched under the SAME id (Phase A always
    dispatches with jobId == SearchJob.id, first run or resumed) without
    hitting create_job()'s "jobId already exists" 409 against a stale entry
    still sitting in JOBS. Previously this raised 400 for anything not
    actively running, which is exactly the state a paused/done/failed job is
    in — nothing here depends on that distinction (the two Next.js callers,
    stop/route.ts and jobs/[id]/route.ts's DELETE, both fire-and-forget this
    and don't branch on the response), so always succeeding is safe.
    """
    state = JOBS.get(job_id)
    if state is None:
        raise HTTPException(status_code=404, detail="Job not found")
    if state.status == "running" and state.task and not state.task.done():
        state.task.cancel()
        state.completed_at = datetime.datetime.utcnow()
    JOBS.pop(job_id, None)
    return {"ok": True}


@app.delete("/jobs/{job_id}")
async def delete_job(job_id: str) -> dict:
    """The real cancellation verb: app/api/jobs/[id]/stop/route.ts (on
    queue-and-lanes-dev) calls DELETE /jobs/{workerJobId}, not POST .../stop."""
    return _stop_job(job_id)


@app.post("/jobs/{job_id}/stop")
async def stop_job(job_id: str) -> dict:
    """Kept as an alias to DELETE above — not what the real dispatcher calls
    today, but harmless to keep for any future caller that prefers this verb."""
    return _stop_job(job_id)


@app.post("/jobs/{job_id}/pause")
async def pause_job(job_id: str) -> dict:
    """Request a graceful pause (Task 13). Sets a flag the running
    run_automation() task observes at its next query boundary (not mid-query);
    the job then finishes context -> sets status "paused" and returns a
    resumeState, so nothing found-so-far is lost. The dispatcher's next poll
    picks up that paused status and persists the leads."""
    state = JOBS.get(job_id)
    if state is None:
        raise HTTPException(status_code=404, detail="Job not found")
    if state.status != "running" or not state.task or state.task.done():
        raise HTTPException(status_code=400, detail="Job is not running")
    state.pause_requested = True
    return {"ok": True}


if __name__ == "__main__":
    import uvicorn

    if not os.getenv("WORKER_AUTH_TOKEN"):
        raise SystemExit("WORKER_AUTH_TOKEN is not set — refusing to start")

    host = os.getenv("WORKER_HOST", "127.0.0.1")
    if host != "127.0.0.1":
        raise SystemExit("WORKER_HOST must be 127.0.0.1 — the worker must never bind 0.0.0.0")
    uvicorn.run(
        app,
        host=host,
        port=int(os.getenv("WORKER_PORT", "8001")),
    )
