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
    status: str  # "running" | "done" | "failed"
    leads: list[dict] = field(default_factory=list)
    error: Optional[str] = None
    task: Optional[asyncio.Task] = None
    job_dir: str = ""
    completed_at: Optional[datetime.datetime] = None


# Per-job state only — keyed by jobId; never a single shared singleton.
JOBS: dict[str, JobState] = {}


def _prune_old_jobs() -> None:
    now = datetime.datetime.utcnow()
    stale = [
        jid for jid, s in JOBS.items()
        if s.status in ("done", "failed")
        and s.completed_at is not None
        and (now - s.completed_at).total_seconds() > _JOB_TTL_SECONDS
    ]
    for jid in stale:
        JOBS.pop(jid, None)


class JobRequest(BaseModel):
    query: str = Field(..., min_length=1, max_length=500)
    params: dict[str, Any] = Field(default_factory=dict)
    # Both optional, for compatibility with two possible caller shapes:
    #   {query, params: {lane, ...}}                (documented in TASK_02_EXTRACTION_WORKER.md;
    #                                                 worker mints its own jobId)
    #   {jobId, query, params, lane}                (caller mints and sends its own jobId, lane
    #                                                 top-level)
    # There is no Next.js dispatcher code committed anywhere in this repo yet (checked every
    # branch: main, extraction-worker-dev, queue-and-lanes-dev, michael-dev, pr-5-review — only
    # markdown task specs exist for Task 3's dispatcher), so which shape the real caller will use
    # cannot be verified from this codebase. Accepting both is a deliberate hedge; flagged in the
    # handoff report for a reviewer with visibility into the actual dispatcher to confirm.
    jobId: Optional[str] = Field(default=None, max_length=200)
    lane: Optional[str] = None


def require_token(authorization: Optional[str] = Header(None)) -> None:
    token = os.getenv("WORKER_AUTH_TOKEN", "")
    expected = f"Bearer {token}"
    if not token or not authorization or not secrets.compare_digest(authorization, expected):
        raise HTTPException(status_code=401, detail="Unauthorized")


def get_lane(req: "JobRequest") -> str:
    # Top-level `lane` (the caller-mints-jobId contract) takes precedence; fall back to
    # `params.lane` (the documented TASK_02 contract) for compatibility with either shape.
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

    async def run_job() -> None:
        sem = app.state.lanes[lane]
        acquired = False
        try:
            await sem.acquire()
            acquired = True
            try:
                await run_automation(
                    req.query,
                    req.params,
                    job_dir,
                    on_progress=on_progress,
                )
                if state.status != "failed":
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
    }


def _stop_job(job_id: str) -> dict:
    state = JOBS.get(job_id)
    if state is None:
        raise HTTPException(status_code=404, detail="Job not found")
    if state.status != "running" or not state.task or state.task.done():
        raise HTTPException(status_code=400, detail="Job is not running")
    state.task.cancel()
    state.completed_at = datetime.datetime.utcnow()
    return {"ok": True}


@app.post("/jobs/{job_id}/stop")
async def stop_job(job_id: str) -> dict:
    """Documented in TASK_02_EXTRACTION_WORKER.md as the stop verb."""
    return _stop_job(job_id)


@app.delete("/jobs/{job_id}")
async def delete_job(job_id: str) -> dict:
    """Same cancellation as POST /jobs/{job_id}/stop, under the verb a caller that
    treats a job as a REST resource (DELETE to cancel/remove it) would use instead.
    Kept as an alias rather than a replacement since no dispatcher code exists yet
    in this repo to confirm which verb the real Next.js caller sends — see the
    JobRequest.jobId/lane comment above for the same caveat."""
    return _stop_job(job_id)


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
