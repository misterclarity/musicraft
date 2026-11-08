"""Recognition engines. ``HomrEngine`` runs the homr command line; ``FakeEngine`` is for tests."""

from __future__ import annotations

import importlib.metadata
import shutil
from typing import Protocol

from .config import Settings


class Engine(Protocol):
    name: str

    def info(self) -> dict[str, object]: ...


def _onnx_device() -> str:
    try:
        import onnxruntime  # type: ignore[import-not-found]
    except ImportError:
        return "unknown"
    providers = onnxruntime.get_available_providers()
    if "ROCMExecutionProvider" in providers:
        return "rocm"
    if "CUDAExecutionProvider" in providers:
        return "cuda"
    return "cpu"


class HomrEngine:
    name = "homr"

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def info(self) -> dict[str, object]:
        try:
            version = importlib.metadata.version("homr")
        except importlib.metadata.PackageNotFoundError:
            version = None
        available = shutil.which(self.settings.homr_command[0]) is not None
        return {"name": self.name, "version": version, "available": available, "device": _onnx_device()}


class FakeEngine:
    name = "fake"

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def info(self) -> dict[str, object]:
        return {"name": self.name, "version": "0", "available": True, "device": "cpu"}


def create_engine(settings: Settings) -> Engine:
    if settings.engine == "fake":
        return FakeEngine(settings)
    return HomrEngine(settings)
