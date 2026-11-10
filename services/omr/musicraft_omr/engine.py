"""Recognition engines. ``HomrEngine`` runs the homr command line; ``FakeEngine`` is for tests and demos."""

from __future__ import annotations

import importlib.metadata
import json
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


def _device(providers: list[str]) -> str:
    if "ROCMExecutionProvider" in providers or "MIGraphXExecutionProvider" in providers:
        return "rocm"
    if "CUDAExecutionProvider" in providers:
        return "cuda"
    return "cpu"


def _onnx_device() -> str:
    try:
        import onnxruntime  # type: ignore[import-not-found]
    except ImportError:
        return "unknown"
    return _device(onnxruntime.get_available_providers())


# Asks the Python environment of another homr installation for its version and ONNX providers.
_PROBE = """
import importlib.metadata, json
try:
    import onnxruntime
    providers = onnxruntime.get_available_providers()
except Exception:
    providers = []
print(json.dumps({"version": importlib.metadata.version("homr"), "providers": providers}))
"""


def _probe_installation(executable: str) -> tuple[str | None, str]:
    """Version and device of the homr whose command is `executable` (in its own environment)."""
    python = Path(executable).parent / "python"
    if not python.exists():
        return None, "unknown"
    try:
        result = subprocess.run(
            [str(python), "-c", _PROBE], capture_output=True, text=True, timeout=60, check=True
        )
        found = json.loads(result.stdout.strip().splitlines()[-1])
        return found.get("version"), _device(list(found.get("providers") or []))
    except (OSError, subprocess.SubprocessError, ValueError, IndexError):
        return None, "unknown"


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

    def __init__(self, settings: Settings, command: list[str] | None = None) -> None:
        self.settings = settings
        self.command = command or settings.homr_command
        # The service's own homr is the one installed next to it; another one is asked once.
        self._own = self.command == settings.homr_command
        self._probed: tuple[str | None, str] | None = None

    def info(self) -> dict[str, object]:
        executable = shutil.which(self.command[0])
        if self._own:
            try:
                version: str | None = importlib.metadata.version("homr")
            except importlib.metadata.PackageNotFoundError:
                version = None
            device = _onnx_device()
        else:
            if self._probed is None and executable:
                self._probed = _probe_installation(executable)
            version, device = self._probed or (None, "unknown")
        return {"name": self.name, "version": version, "available": executable is not None, "device": device}

    def recognize(
        self,
        folder: Path,
        pages: list[Path],
        progress: Callable[[int], None],
        cancelled: Callable[[], bool],
    ) -> list[PageOutcome]:
        # homr processes every image in a folder in one run, loading its models only once.
        log_path = folder / "homr.log"
        command = [*self.command, "--write-staff-positions", str(folder)]
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

    def __init__(self, settings: Settings, musicxml: str = FAKE_MUSICXML, version: str = "0") -> None:
        self.settings = settings
        self.musicxml = musicxml
        self.version = version

    def info(self) -> dict[str, object]:
        return {"name": self.name, "version": self.version, "available": True, "device": "cpu"}

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
            outcomes.append(PageOutcome(self.musicxml, [staff]))
            progress(index + 1)
        return outcomes


def create_engine(settings: Settings) -> Engine:
    if settings.engine == "fake":
        return FakeEngine(settings)
    return HomrEngine(settings)


def create_second_engine(settings: Settings) -> Engine | None:
    """The second homr installation, if one is configured and installed."""
    if settings.engine == "fake" or not settings.second_homr_command:
        return None
    if shutil.which(settings.second_homr_command[0]) is None:
        return None
    return HomrEngine(settings, settings.second_homr_command)


def engine_label(engine: Engine) -> str:
    info = engine.info()
    return f"{info['name']} {info['version']}" if info.get("version") else str(info["name"])
