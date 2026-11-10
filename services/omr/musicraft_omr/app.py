"""FastAPI application: health check, auth, CORS and the recognition API."""

from __future__ import annotations

import hmac
import json
import threading
from typing import Annotated

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from starlette.types import ASGIApp, Receive, Scope, Send

from . import __version__
from .config import Settings
from .engine import create_engine, create_second_engine
from .imaging import UnsupportedFile, detect_page, open_image, sniff
from .jobs import JobLimitError, JobManager, PageSpec

# Paths that answer without the internal key, like llama-server's /health.
PUBLIC_PATHS = {"/health"}
# gateway.py may forward /omr/... with or without stripping the prefix.
STRIPPED_PREFIX = "/omr"


class StripPrefixMiddleware:
    """Serve the API both at / and at /omr/ so the gateway may or may not strip the prefix."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            path: str = scope["path"]
            if path == STRIPPED_PREFIX or path.startswith(STRIPPED_PREFIX + "/"):
                scope = dict(scope)
                scope["path"] = path[len(STRIPPED_PREFIX) :] or "/"
                scope["raw_path"] = scope["path"].encode()
        await self.app(scope, receive, send)


def _read_limited(upload: UploadFile, limit: int) -> bytes:
    data = upload.file.read(limit + 1)
    if len(data) > limit:
        raise HTTPException(status_code=413, detail=f"The upload is larger than {limit // (1024 * 1024)} MB.")
    return data


def _wants_second_reading(options: str | None) -> bool:
    if not options:
        return False
    try:
        return json.loads(options).get("second") is True
    except (ValueError, AttributeError):
        return False


def _parse_specs(options: str | None) -> list[PageSpec] | None:
    if not options:
        return None
    try:
        parsed = json.loads(options)
        pages = parsed.get("pages")
        if pages is None:
            return None
        specs = []
        for item in pages:
            corners = item.get("corners")
            if corners is not None:
                if len(corners) != 4 or not all(
                    len(c) == 2 and 0 <= c[0] <= 1 and 0 <= c[1] <= 1 for c in corners
                ):
                    raise ValueError("corners must be four [x, y] pairs between 0 and 1")
                corners = [(float(c[0]), float(c[1])) for c in corners]
            specs.append(
                PageSpec(
                    file=int(item["file"]),
                    page=int(item.get("page", 0)),
                    corners=corners,
                    rotation=int(item.get("rotation", 0)) % 360,
                )
            )
        return specs
    except (ValueError, KeyError, TypeError, AttributeError) as error:
        raise HTTPException(status_code=400, detail=f"Invalid options: {error}") from error


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    engine = create_engine(settings)
    second = create_second_engine(settings)
    if second is not None:
        # Asking the second installation for its version takes a moment: do it now, not in /health.
        threading.Thread(target=second.info, name="second-engine-info", daemon=True).start()
    manager = JobManager(settings, engine, second)
    limit = settings.max_upload_mb * 1024 * 1024

    app = FastAPI(title="Musicraft OMR", version=__version__, docs_url=None, redoc_url=None)
    app.state.settings = settings
    app.state.engine = engine
    app.state.jobs = manager

    @app.middleware("http")
    async def require_key(request: Request, call_next):  # type: ignore[no-untyped-def]
        if settings.api_key and request.method != "OPTIONS" and request.url.path not in PUBLIC_PATHS:
            header = request.headers.get("authorization", "")
            token = header[7:].strip() if header.lower().startswith("bearer ") else ""
            if not hmac.compare_digest(token.encode(), settings.api_key.encode()):
                return JSONResponse({"detail": "Missing or wrong API key."}, status_code=401)
        return await call_next(request)

    @app.get("/health")
    def health() -> dict[str, object]:
        return {
            "status": "ok",
            "version": __version__,
            "engine": engine.info(),
            "secondEngine": second.info() if second else None,
            "limits": {"maxUploadMb": settings.max_upload_mb, "maxPages": settings.max_pages},
        }

    @app.post("/v1/pages/detect")
    def detect(file: Annotated[UploadFile, File()]) -> dict[str, object]:
        data = _read_limited(file, limit)
        try:
            kind = sniff(data)
            if kind == "pdf":
                return {"kind": "pdf", "corners": None, "confidence": 0}
            image = open_image(data)
        except UnsupportedFile as error:
            raise HTTPException(status_code=415, detail=str(error)) from error
        found = detect_page(image)
        return {
            "kind": "image",
            "width": image.width,
            "height": image.height,
            "corners": [list(c) for c in found.corners] if found else None,
            "confidence": found.confidence if found else 0,
        }

    @app.post("/v1/omr/jobs", status_code=202)
    def create_job(
        files: Annotated[list[UploadFile], File()],
        options: Annotated[str | None, Form()] = None,
    ) -> dict[str, object]:
        specs = _parse_specs(options)
        payload: list[tuple[str, bytes]] = []
        remaining = limit
        for upload in files:
            data = _read_limited(upload, remaining)
            remaining -= len(data)
            payload.append((upload.filename or "upload", data))
        try:
            job = manager.submit(payload, specs, second=_wants_second_reading(options))
        except UnsupportedFile as error:
            raise HTTPException(status_code=415, detail=str(error)) from error
        except JobLimitError as error:
            raise HTTPException(status_code=429, detail=str(error)) from error
        return job.to_json(include_music=False)

    @app.get("/v1/omr/jobs/{job_id}")
    def get_job(job_id: str) -> dict[str, object]:
        job = manager.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Unknown or expired job.")
        return job.to_json(include_music=job.status == "done")

    @app.get("/v1/omr/jobs/{job_id}/pages/{index}/image")
    def page_image(job_id: str, index: int) -> FileResponse:
        path = manager.page_image(job_id, index)
        if not path:
            raise HTTPException(status_code=404, detail="No such page image.")
        return FileResponse(path, media_type="image/png")

    @app.delete("/v1/omr/jobs/{job_id}", status_code=204)
    def delete_job(job_id: str) -> Response:
        if not manager.delete(job_id):
            raise HTTPException(status_code=404, detail="Unknown or expired job.")
        return Response(status_code=204)

    # CORS wraps everything (including 401 answers) so the browser can read errors.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
        max_age=600,
    )
    app.add_middleware(StripPrefixMiddleware)
    return app
