"""FastAPI application: health check, auth, CORS and the recognition API."""

from __future__ import annotations

import hmac

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from . import __version__
from .config import Settings
from .engine import create_engine

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


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    engine = create_engine(settings)

    app = FastAPI(title="Musicraft OMR", version=__version__, docs_url=None, redoc_url=None)
    app.state.settings = settings
    app.state.engine = engine

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
        info = engine.info()
        return {
            "status": "ok",
            "version": __version__,
            "engine": info,
            "limits": {"maxUploadMb": settings.max_upload_mb, "maxPages": settings.max_pages},
        }

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
