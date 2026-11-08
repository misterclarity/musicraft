"""Service configuration, read from environment variables (all prefixed MUSICRAFT_OMR_)."""

from __future__ import annotations

import os
import shlex
from dataclasses import dataclass, field
from pathlib import Path

ENV_PREFIX = "MUSICRAFT_OMR_"


def _env(name: str, default: str = "") -> str:
    return os.environ.get(ENV_PREFIX + name, default).strip()


def _env_int(name: str, default: int) -> int:
    raw = _env(name)
    return int(raw) if raw else default


@dataclass(frozen=True)
class Settings:
    host: str = "127.0.0.1"
    port: int = 8070
    # The internal key gateway.py adds when forwarding. Empty means no key check
    # (only acceptable when the port is reachable from localhost only).
    api_key: str = ""
    # Origins allowed by CORS; ["*"] allows any origin. The browser never sends
    # cookies to this service, so a wildcard is safe when the key is required.
    cors_origins: list[str] = field(default_factory=lambda: ["*"])
    max_upload_mb: int = 60
    max_pages: int = 40
    job_ttl_hours: int = 6
    workdir: Path = Path("/tmp/musicraft-omr")
    # "homr" runs the real engine; "fake" returns a fixed score (tests, demos).
    engine: str = "homr"
    homr_command: list[str] = field(default_factory=lambda: ["homr"])
    homr_timeout_seconds: int = 1800
    # Longest side of a page image handed to homr; larger photos are scaled down.
    max_image_side: int = 4000

    @classmethod
    def from_env(cls) -> Settings:
        api_key = _env("API_KEY")
        key_file = _env("API_KEY_FILE")
        if key_file:
            api_key = Path(key_file).read_text(encoding="utf-8").strip()
        origins = [o.strip() for o in _env("CORS_ORIGINS", "*").split(",") if o.strip()]
        return cls(
            host=_env("HOST", "127.0.0.1"),
            port=_env_int("PORT", 8070),
            api_key=api_key,
            cors_origins=origins,
            max_upload_mb=_env_int("MAX_UPLOAD_MB", 60),
            max_pages=_env_int("MAX_PAGES", 40),
            job_ttl_hours=_env_int("JOB_TTL_HOURS", 6),
            workdir=Path(_env("WORKDIR", "/tmp/musicraft-omr")),
            engine=_env("ENGINE", "homr"),
            homr_command=shlex.split(_env("HOMR_COMMAND", "homr")),
            homr_timeout_seconds=_env_int("HOMR_TIMEOUT_SECONDS", 1800),
            max_image_side=_env_int("MAX_IMAGE_SIDE", 4000),
        )
