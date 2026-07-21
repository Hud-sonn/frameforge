from __future__ import annotations

import asyncio
import json
import logging
import shutil
import uuid
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path

from .config import JOBS_FILE

logger = logging.getLogger(__name__)


@dataclass
class Job:
    id: str
    source_filename: str
    source_path: str
    created_at: str
    status: str = "uploaded"
    fps: float = 24.0
    trim_start: float = 0.0
    trim_end: float = 0.0
    frame_count: int = 0
    format: str = "avif"
    quality: dict = field(default_factory=dict)
    output_path: str = ""
    manifest_path: str = ""
    tmp_dir: str = ""
    source_size_bytes: int = 0
    total_size_bytes: int = 0
    width: int = 0
    height: int = 0
    duration: float = 0.0
    codec: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


class JobsManager:
    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._jobs: dict[str, Job] = {}
        self._load()

    def _load(self) -> None:
        if JOBS_FILE.exists():
            try:
                data = json.loads(JOBS_FILE.read_text())
                for j in data:
                    self._jobs[j["id"]] = Job(**j)
            except Exception:
                logger.warning("Failed to load jobs index, starting fresh")

    async def _save(self) -> None:
        async with self._lock:
            await asyncio.to_thread(
                JOBS_FILE.write_text,
                json.dumps([j.to_dict() for j in self._jobs.values()], indent=2),
            )

    MAX_JOBS = 100

    # Callback invoked with (job_id,) when a job is trimmed — used by routes.py to clean _progress
    on_trim: list[callable] = []

    async def _trim(self) -> None:
        if len(self._jobs) > self.MAX_JOBS:
            sorted_jobs = sorted(self._jobs.values(), key=lambda j: j.created_at)
            for j in sorted_jobs[: len(sorted_jobs) - self.MAX_JOBS]:
                for d in [j.tmp_dir, j.output_path]:
                    if d and Path(d).exists():
                        shutil.rmtree(d, ignore_errors=True)
                for cb in self.on_trim:
                    cb(j.id)
                del self._jobs[j.id]
            await self._save()

    async def create(self, source_filename: str, source_path: str, source_size: int) -> Job:
        job_id = uuid.uuid4().hex[:12]
        now = datetime.now(timezone.utc).isoformat()
        tmp_dir = str(Path.home() / ".frameforge" / "tmp" / job_id)
        Path(tmp_dir).mkdir(parents=True, exist_ok=True)
        job = Job(
            id=job_id,
            source_filename=source_filename,
            source_path=source_path,
            created_at=now,
            tmp_dir=tmp_dir,
            source_size_bytes=source_size,
        )
        self._jobs[job_id] = job
        await self._save()
        await self._trim()
        return job

    def get(self, job_id: str) -> Job | None:
        return self._jobs.get(job_id)

    async def update(self, job_id: str, **kwargs) -> Job | None:
        job = self._jobs.get(job_id)
        if not job:
            return None
        for k, v in kwargs.items():
            if hasattr(job, k):
                setattr(job, k, v)
        await self._save()
        return job

    def list_all(self) -> list[Job]:
        return sorted(self._jobs.values(), key=lambda j: j.created_at, reverse=True)
