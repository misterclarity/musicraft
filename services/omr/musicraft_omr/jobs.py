"""Background recognition jobs: uploads are stored, then prepared and recognised one job at a time."""

from __future__ import annotations

import json
import queue
import secrets
import shutil
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

from .config import Settings
from .engine import Cancelled, Engine
from .imaging import UnsupportedFile, open_image, pdf_page_count, prepare_page, render_pdf_page, sniff


@dataclass
class PageSpec:
    """Which page of which uploaded file to recognise, and how to straighten it."""

    file: int
    page: int = 0
    corners: list[tuple[float, float]] | None = None
    rotation: int = 0


@dataclass
class PageState:
    index: int
    width: int = 0
    height: int = 0
    status: str = "pending"  # pending | done | failed
    musicxml: str | None = None
    staffs: list[dict[str, float | bool]] = field(default_factory=list)
    error: str | None = None


@dataclass
class Job:
    id: str
    folder: Path
    created: float
    status: str = "queued"  # queued | preparing | running | done | failed | canceled
    stage: str = "Waiting to start"
    done: int = 0
    total: int = 0
    error: str | None = None
    finished: float | None = None
    pages: list[PageState] = field(default_factory=list)
    cancel: threading.Event = field(default_factory=threading.Event)

    def to_json(self, include_music: bool = True) -> dict[str, object]:
        return {
            "id": self.id,
            "status": self.status,
            "progress": {"done": self.done, "total": self.total, "stage": self.stage},
            "error": self.error,
            "createdAt": self.created,
            "finishedAt": self.finished,
            "pages": [
                {
                    "index": p.index,
                    "status": p.status,
                    "width": p.width,
                    "height": p.height,
                    "staffs": p.staffs,
                    "error": p.error,
                    **({"musicxml": p.musicxml} if include_music else {}),
                }
                for p in self.pages
            ],
        }


class JobLimitError(Exception):
    pass


class JobManager:
    def __init__(self, settings: Settings, engine: Engine) -> None:
        self.settings = settings
        self.engine = engine
        self.jobs: dict[str, Job] = {}
        self.lock = threading.Lock()
        self.queue: queue.Queue[str] = queue.Queue()
        self.worker: threading.Thread | None = None
        # Endpoints run in a thread pool, so two uploads can arrive at once: only one may start the worker.
        self.worker_lock = threading.Lock()
        settings.workdir.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------ public

    def submit(self, files: list[tuple[str, bytes]], specs: list[PageSpec] | None) -> Job:
        """Store the uploads and queue the job. Validation of contents happens here, decoding later."""
        self.cleanup()
        kinds = [sniff(data) for _name, data in files]
        if specs is None:
            specs = []
            for index, ((_name, data), kind) in enumerate(zip(files, kinds, strict=True)):
                count = pdf_page_count(data) if kind == "pdf" else 1
                specs.extend(PageSpec(file=index, page=p) for p in range(count))
        for spec in specs:
            if not 0 <= spec.file < len(files):
                raise UnsupportedFile(
                    f"Page refers to file {spec.file + 1}, but only {len(files)} were uploaded."
                )
        if not specs:
            raise UnsupportedFile("No pages to recognise.")
        if len(specs) > self.settings.max_pages:
            raise UnsupportedFile(f"At most {self.settings.max_pages} pages can be recognised at once.")
        with self.lock:
            waiting = sum(1 for j in self.jobs.values() if j.status in ("queued", "preparing", "running"))
            if waiting >= 20:
                raise JobLimitError("Too many recognitions are waiting; try again in a few minutes.")
            job_id = secrets.token_hex(8)
            folder = self.settings.workdir / job_id
            (folder / "uploads").mkdir(parents=True)
            for index, (_name, data) in enumerate(files):
                (folder / "uploads" / f"{index:03d}.{kinds[index]}").write_bytes(data)
            (folder / "pages.json").write_text(
                json.dumps([spec.__dict__ for spec in specs]), encoding="utf-8"
            )
            job = Job(id=job_id, folder=folder, created=time.time(), total=len(specs))
            job.pages = [PageState(index=i) for i in range(len(specs))]
            self.jobs[job_id] = job
        self.queue.put(job_id)
        self._ensure_worker()
        return job

    def get(self, job_id: str) -> Job | None:
        with self.lock:
            return self.jobs.get(job_id)

    def delete(self, job_id: str) -> bool:
        with self.lock:
            job = self.jobs.pop(job_id, None)
        if not job:
            return False
        job.cancel.set()
        if job.status not in ("preparing", "running"):
            shutil.rmtree(job.folder, ignore_errors=True)
        return True

    def page_image(self, job_id: str, index: int) -> Path | None:
        job = self.get(job_id)
        if not job or not 0 <= index < len(job.pages):
            return None
        path = job.folder / "pages" / f"page-{index + 1:03d}.png"
        return path if path.exists() else None

    def cleanup(self) -> None:
        """Forget finished jobs older than the configured lifetime."""
        cutoff = time.time() - self.settings.job_ttl_hours * 3600
        with self.lock:
            expired = [j for j in self.jobs.values() if j.finished and j.finished < cutoff]
            for job in expired:
                del self.jobs[job.id]
        for job in expired:
            shutil.rmtree(job.folder, ignore_errors=True)

    # ------------------------------------------------------------------ worker

    def _ensure_worker(self) -> None:
        with self.worker_lock:
            if self.worker and self.worker.is_alive():
                return
            self.worker = threading.Thread(target=self._work, name="omr-worker", daemon=True)
            self.worker.start()

    def _work(self) -> None:
        while True:
            job_id = self.queue.get()
            job = self.get(job_id)
            if job is None or job.cancel.is_set():
                continue
            try:
                self._run(job)
            except Cancelled:
                job.status, job.stage = "canceled", "Cancelled"
            except Exception as error:  # noqa: BLE001 - report any failure to the client
                job.status, job.error, job.stage = "failed", str(error), "Failed"
            finally:
                job.finished = time.time()
                if job.cancel.is_set():
                    shutil.rmtree(job.folder, ignore_errors=True)

    def _run(self, job: Job) -> None:
        job.status = "preparing"
        specs = [PageSpec(**s) for s in json.loads((job.folder / "pages.json").read_text(encoding="utf-8"))]
        uploads = sorted((job.folder / "uploads").iterdir())
        pages_dir = job.folder / "pages"
        pages_dir.mkdir()
        paths = []
        for i, spec in enumerate(specs):
            if job.cancel.is_set():
                raise Cancelled()
            job.stage = f"Preparing page {i + 1} of {len(specs)}"
            source = uploads[spec.file]
            data = source.read_bytes()
            image = render_pdf_page(data, spec.page) if source.suffix == ".pdf" else open_image(data)
            corners = [tuple(c) for c in spec.corners] if spec.corners else None
            image = prepare_page(
                image, corners=corners, rotation=spec.rotation, max_side=self.settings.max_image_side
            )
            path = pages_dir / f"page-{i + 1:03d}.png"
            image.save(path, optimize=False)
            job.pages[i].width, job.pages[i].height = image.size
            paths.append(path)

        job.status = "running"
        job.stage = "Recognising"

        def progress(done: int) -> None:
            job.done = done
            job.stage = (
                f"Recognising page {min(done + 1, len(paths))} of {len(paths)}"
                if done < len(paths)
                else "Finishing"
            )

        outcomes = self.engine.recognize(pages_dir, paths, progress, job.cancel.is_set)
        for state, outcome in zip(job.pages, outcomes, strict=True):
            state.musicxml = outcome.musicxml
            state.staffs = outcome.staffs
            state.error = outcome.error
            state.status = "done" if outcome.musicxml else "failed"
        job.done = len(paths)
        if all(p.status == "failed" for p in job.pages):
            job.status, job.stage = "failed", "Failed"
            job.error = job.pages[0].error or "No music was recognised."
        else:
            job.status, job.stage = "done", "Done"
