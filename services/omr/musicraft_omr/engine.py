"""Recognition engines. ``HomrEngine`` runs the homr command line; ``FakeEngine`` is for tests and demos."""

from __future__ import annotations

import importlib.metadata
import os
import shutil
import subprocess
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

from .config import Settings


class Cancelled(Exception):
    """The job was cancelled while recognition was running."""


@dataclass
class PageOutcome:
    musicxml: str | None
    staffs: list[dict[str, float | bool]] = field(default_factory=list)
    error: str | None = None


class Engine(Protocol):
    name: str

    def info(self) -> dict[str, object]: ...

    def recognize(
        self,
        folder: Path,
        pages: list[Path],
        progress: Callable[[int], None],
        cancelled: Callable[[], bool],
    ) -> list[PageOutcome]: ...


def _onnx_device() -> str:
    try:
        import onnxruntime  # type: ignore[import-not-found]
    except ImportError:
        return "unknown"
    providers = onnxruntime.get_available_providers()
    if "ROCMExecutionProvider" in providers or "MIGraphXExecutionProvider" in providers:
        return "rocm"
    if "CUDAExecutionProvider" in providers:
        return "cuda"
    return "cpu"


def parse_staff_positions(path: Path) -> list[dict[str, float | bool]]:
    """homr's --write-staff-positions file: one line per staff, `class cx cy w h`, normalised 0–1."""
    if not path.exists():
        return []
    staffs: list[dict[str, float | bool]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        fields = line.split()
        if len(fields) != 5:
            continue
        kind, cx, cy, w, h = fields[0], *map(float, fields[1:])
        staffs.append(
            {
                "x": round(cx - w / 2, 5),
                "y": round(cy - h / 2, 5),
                "width": round(w, 5),
                "height": round(h, 5),
                "grand": kind == "1",
            }
        )
    staffs.sort(key=lambda s: (float(s["y"]), float(s["x"])))
    return staffs


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

    def recognize(
        self,
        folder: Path,
        pages: list[Path],
        progress: Callable[[int], None],
        cancelled: Callable[[], bool],
    ) -> list[PageOutcome]:
        # homr processes every image in a folder in one run, loading its models only once.
        log_path = folder / "homr.log"
        command = [*self.settings.homr_command, "--write-staff-positions", str(folder)]
        env = {**os.environ, "PYTHONWARNINGS": "ignore"}
        started = time.monotonic()
        with open(log_path, "w", encoding="utf-8") as log:
            process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, cwd=folder, env=env)
            try:
                while process.poll() is None:
                    if cancelled():
                        process.kill()
                        raise Cancelled()
                    if time.monotonic() - started > self.settings.homr_timeout_seconds:
                        process.kill()
                        raise TimeoutError("Recognition took too long and was stopped.")
                    progress(sum(1 for p in pages if p.with_suffix(".musicxml").exists()))
                    time.sleep(0.5)
            finally:
                if process.poll() is None:
                    process.kill()
        log_tail = log_path.read_text(encoding="utf-8", errors="replace").strip().splitlines()[-3:]
        outcomes: list[PageOutcome] = []
        for page in pages:
            xml_path = page.with_suffix(".musicxml")
            if xml_path.exists():
                outcomes.append(
                    PageOutcome(
                        xml_path.read_text(encoding="utf-8"), parse_staff_positions(page.with_suffix(".txt"))
                    )
                )
            else:
                detail = " ".join(line.strip() for line in log_tail)[-300:]
                outcomes.append(
                    PageOutcome(None, [], f"No music was recognised on this page. {detail}".strip())
                )
        progress(len(pages))
        return outcomes


FAKE_MUSICXML = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0"><work><work-title>Recognised page</work-title></work>
<part-list><score-part id="P1"><part-name>Voice</part-name></score-part></part-list>
<part id="P1"><measure number="1"><attributes><divisions>1</divisions><key><fifths>0</fifths></key>
<time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
<note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type></note>
<note><pitch><step>D</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type></note>
<note><pitch><step>E</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type></note>
<note><pitch><step>F</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type></note>
</measure><measure number="2">
<note><pitch><step>G</step><octave>5</octave></pitch><duration>4</duration><type>whole</type></note>
</measure></part></score-partwise>
"""


class FakeEngine:
    """Returns the same two-bar melody for every page: for tests and for trying the app without homr."""

    name = "fake"

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def info(self) -> dict[str, object]:
        return {"name": self.name, "version": "0", "available": True, "device": "cpu"}

    def recognize(
        self,
        folder: Path,
        pages: list[Path],
        progress: Callable[[int], None],
        cancelled: Callable[[], bool],
    ) -> list[PageOutcome]:
        outcomes = []
        for index, _page in enumerate(pages):
            if cancelled():
                raise Cancelled()
            time.sleep(0.02)
            staff = {"x": 0.08, "y": 0.1, "width": 0.84, "height": 0.04, "grand": False}
            outcomes.append(PageOutcome(FAKE_MUSICXML, [staff]))
            progress(index + 1)
        return outcomes


def create_engine(settings: Settings) -> Engine:
    if settings.engine == "fake":
        return FakeEngine(settings)
    return HomrEngine(settings)
