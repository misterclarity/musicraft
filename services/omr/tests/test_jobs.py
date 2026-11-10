import io
import json
import os
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from musicraft_omr.app import create_app
from musicraft_omr.config import Settings


def png(width: int = 600, height: int = 800) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), "white").save(buffer, "PNG")
    return buffer.getvalue()


def pdf(pages: int) -> bytes:
    images = [Image.new("RGB", (595, 842), "white") for _ in range(pages)]
    buffer = io.BytesIO()
    images[0].save(buffer, "PDF", save_all=True, append_images=images[1:], resolution=72)
    return buffer.getvalue()


@pytest.fixture
def client(tmp_path: Path) -> TestClient:
    settings = Settings(engine="fake", workdir=tmp_path, api_key="secret", max_pages=5)
    return TestClient(create_app(settings), headers={"Authorization": "Bearer secret"})


def wait_for(client: TestClient, job_id: str) -> dict:
    for _ in range(200):
        body = client.get(f"/v1/omr/jobs/{job_id}").json()
        if body["status"] in ("done", "failed", "canceled"):
            return body
        time.sleep(0.05)
    raise AssertionError("job did not finish")


def test_recognises_images_and_pdf_pages(client: TestClient):
    response = client.post(
        "/omr/v1/omr/jobs",
        files=[
            ("files", ("photo.png", png(), "image/png")),
            ("files", ("score.pdf", pdf(2), "application/pdf")),
        ],
    )
    assert response.status_code == 202
    job = response.json()
    assert job["progress"]["total"] == 3
    done = wait_for(client, job["id"])
    assert done["status"] == "done"
    assert [p["status"] for p in done["pages"]] == ["done", "done", "done"]
    assert "<score-partwise" in done["pages"][0]["musicxml"]
    assert done["pages"][0]["staffs"][0]["width"] == 0.84
    assert (done["pages"][0]["width"], done["pages"][0]["height"]) == (600, 800)
    # PDF pages are rendered at 300 dpi.
    assert abs(done["pages"][1]["width"] - 2480) <= 2
    image = client.get(f"/v1/omr/jobs/{job['id']}/pages/1/image")
    assert image.status_code == 200 and image.headers["content-type"] == "image/png"
    assert client.delete(f"/v1/omr/jobs/{job['id']}").status_code == 204
    assert client.get(f"/v1/omr/jobs/{job['id']}").status_code == 404


def test_page_options_crop_and_rotate(client: TestClient):
    options = {
        "pages": [
            {"file": 0, "corners": [[0, 0], [0.5, 0], [0.5, 0.5], [0, 0.5]], "rotation": 0},
            {"file": 0, "rotation": 90},
        ]
    }
    response = client.post(
        "/v1/omr/jobs",
        files=[("files", ("p.png", png(), "image/png"))],
        data={"options": json.dumps(options)},
    )
    assert response.status_code == 202
    done = wait_for(client, response.json()["id"])
    sizes = [(p["width"], p["height"]) for p in done["pages"]]
    assert sizes[0][0] < 320 and sizes[0][1] < 420
    assert sizes[1] == (800, 600)


def test_rejects_bad_uploads(client: TestClient):
    response = client.post("/v1/omr/jobs", files=[("files", ("x.xml", b"<xml/>", "text/xml"))])
    assert response.status_code == 415
    too_many = client.post("/v1/omr/jobs", files=[("files", ("s.pdf", pdf(6), "application/pdf"))])
    assert too_many.status_code == 415
    assert "At most 5 pages" in too_many.json()["detail"]
    bad_options = client.post(
        "/v1/omr/jobs",
        files=[("files", ("p.png", png(), "image/png"))],
        data={"options": '{"pages":[{"file":0,"corners":[[2,2]]}]}'},
    )
    assert bad_options.status_code == 400


def test_requires_the_internal_key(tmp_path: Path):
    settings = Settings(engine="fake", workdir=tmp_path, api_key="secret")
    anonymous = TestClient(create_app(settings))
    assert anonymous.post("/v1/omr/jobs", files=[("files", ("p.png", png(), "image/png"))]).status_code == 401
    assert anonymous.get("/health").status_code == 200


def test_detects_page_corners(client: TestClient):
    response = client.post("/v1/pages/detect", files={"file": ("p.png", png(), "image/png")})
    assert response.status_code == 200
    body = response.json()
    assert body["kind"] == "image" and body["width"] == 600
    pdf_response = client.post("/v1/pages/detect", files={"file": ("s.pdf", pdf(1), "application/pdf")})
    assert pdf_response.json()["kind"] == "pdf"


@pytest.mark.skipif(
    not os.environ.get("MUSICRAFT_OMR_TEST_HOMR"), reason="set MUSICRAFT_OMR_TEST_HOMR to a homr command"
)
def test_real_homr(tmp_path: Path):
    """Runs the real engine on MUSICRAFT_OMR_TEST_IMAGE (a page of sheet music)."""
    settings = Settings(engine="homr", workdir=tmp_path, homr_command=[os.environ["MUSICRAFT_OMR_TEST_HOMR"]])
    client = TestClient(create_app(settings))
    image = Path(os.environ["MUSICRAFT_OMR_TEST_IMAGE"]).read_bytes()
    job = client.post("/v1/omr/jobs", files=[("files", ("page.png", image, "image/png"))]).json()
    for _ in range(600):
        body = client.get(f"/v1/omr/jobs/{job['id']}").json()
        if body["status"] in ("done", "failed"):
            break
        time.sleep(0.5)
    assert body["status"] == "done", body
    page = body["pages"][0]
    assert "<score-partwise" in page["musicxml"]
    assert len(page["staffs"]) >= 2


def test_simultaneous_uploads_start_one_worker(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import threading

    from musicraft_omr import jobs as jobs_module
    from musicraft_omr.engine import create_engine

    settings = Settings(engine="fake", workdir=tmp_path)
    manager = jobs_module.JobManager(settings, create_engine(settings))
    started: list[str] = []
    real_thread = threading.Thread

    class SlowThread(real_thread):  # type: ignore[valid-type, misc]
        """Widens the gap between checking for a worker and starting one, like a busy server."""

        def __init__(self, *args: object, **kwargs: object) -> None:
            time.sleep(0.05)
            super().__init__(*args, **kwargs)  # type: ignore[arg-type]

        def start(self) -> None:
            started.append(self.name)
            super().start()

    monkeypatch.setattr(jobs_module.threading, "Thread", SlowThread)
    barrier = threading.Barrier(8)
    callers = [real_thread(target=lambda: (barrier.wait(), manager._ensure_worker())) for _ in range(8)]
    for caller in callers:
        caller.start()
    for caller in callers:
        caller.join()
    assert started == ["omr-worker"]


def _finish(manager, job):  # type: ignore[no-untyped-def]
    for _ in range(200):
        if job.status in ("done", "failed", "canceled"):
            return job
        time.sleep(0.05)
    raise AssertionError("job did not finish")


class _FailingEngine:
    """Reads nothing, or breaks down altogether."""

    name = "broken"

    def __init__(self, crash: bool = False) -> None:
        self.crash = crash

    def info(self) -> dict[str, object]:
        return {"name": self.name, "version": "1", "available": True, "device": "cpu"}

    def recognize(self, folder, pages, progress, cancelled):  # type: ignore[no-untyped-def]
        from musicraft_omr.engine import PageOutcome

        if self.crash:
            raise RuntimeError("out of memory")
        return [PageOutcome(None, [], "No music was recognised on this page.") for _ in pages]


def test_second_reading_of_every_page(tmp_path: Path) -> None:
    from musicraft_omr.engine import FAKE_MUSICXML, FakeEngine
    from musicraft_omr.jobs import JobManager

    settings = Settings(engine="fake", workdir=tmp_path)
    other = FAKE_MUSICXML.replace("Recognised page", "Second reading")
    manager = JobManager(settings, FakeEngine(settings), FakeEngine(settings, other, version="2"))
    job = _finish(manager, manager.submit([("p.png", png()), ("q.png", png())], None, second=True))
    body = job.to_json()
    assert body["status"] == "done" and body["second"] is True and body["secondError"] is None
    assert body["progress"]["done"] == body["progress"]["total"] == 4
    page = body["pages"][0]
    assert page["readBy"] == "fake 0" and "Recognised page" in page["musicxml"]
    assert page["alternative"]["readBy"] == "fake 2"
    assert "Second reading" in page["alternative"]["musicxml"]
    assert page["alternative"]["staffs"][0]["width"] == 0.84
    # Without asking, a page is read once.
    once = _finish(manager, manager.submit([("p.png", png())], None)).to_json()
    assert (
        once["second"] is False and once["progress"]["total"] == 1 and once["pages"][0]["alternative"] is None
    )


def test_second_reading_fills_in_or_fails_quietly(tmp_path: Path) -> None:
    from musicraft_omr.engine import FakeEngine
    from musicraft_omr.jobs import JobManager

    settings = Settings(engine="fake", workdir=tmp_path)
    # The first engine reads nothing: the second engine's reading is used.
    rescued = JobManager(settings, _FailingEngine(), FakeEngine(settings, version="2"))
    job = _finish(rescued, rescued.submit([("p.png", png())], None, second=True)).to_json()
    assert job["status"] == "done"
    assert job["pages"][0]["status"] == "done" and job["pages"][0]["readBy"] == "fake 2"
    assert job["pages"][0]["error"] is None and job["pages"][0]["alternative"] is None
    # The first engine breaks down altogether: the second engine still reads the pages.
    crashed = JobManager(settings, _FailingEngine(crash=True), FakeEngine(settings, version="2"))
    job = _finish(crashed, crashed.submit([("p.png", png())], None, second=True)).to_json()
    assert job["status"] == "done" and job["pages"][0]["readBy"] == "fake 2"
    # The second engine breaks down: the first reading stands, with a note.
    broken = JobManager(settings, FakeEngine(settings), _FailingEngine(crash=True))
    job = _finish(broken, broken.submit([("p.png", png())], None, second=True)).to_json()
    assert job["status"] == "done" and job["pages"][0]["readBy"] == "fake 0"
    assert job["secondError"] == "The second reading failed: out of memory"


def test_second_reading_through_the_api(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from musicraft_omr import app as app_module
    from musicraft_omr.engine import FakeEngine

    settings = Settings(engine="fake", workdir=tmp_path)
    plain = TestClient(create_app(settings))
    assert plain.get("/health").json()["secondEngine"] is None
    # Asking for a second reading without a second engine reads once.
    job = plain.post(
        "/v1/omr/jobs", files=[("files", ("p.png", png(), "image/png"))], data={"options": '{"second": true}'}
    )
    assert job.json()["second"] is False

    monkeypatch.setattr(app_module, "create_second_engine", lambda s: FakeEngine(s, version="2"))
    client = TestClient(create_app(settings))
    assert client.get("/health").json()["secondEngine"]["version"] == "2"
    job = client.post(
        "/v1/omr/jobs", files=[("files", ("p.png", png(), "image/png"))], data={"options": '{"second": true}'}
    )
    assert job.json()["second"] is True and job.json()["progress"]["total"] == 2
    done = wait_for(client, job.json()["id"])
    assert done["pages"][0]["alternative"]["readBy"] == "fake 2"


def test_second_engine_reports_its_own_version(tmp_path: Path) -> None:
    from musicraft_omr.engine import HomrEngine, create_second_engine

    bin_dir = tmp_path / "venv" / "bin"
    bin_dir.mkdir(parents=True)
    homr = bin_dir / "homr"
    homr.write_text("#!/bin/sh\nexit 0\n")
    # Stands in for the Python of the other installation.
    python = bin_dir / "python"
    python.write_text('#!/bin/sh\necho \'{"version": "0.7.0", "providers": ["CPUExecutionProvider"]}\'\n')
    for script in (homr, python):
        script.chmod(0o755)
    settings = Settings(engine="homr", workdir=tmp_path, second_homr_command=[str(homr)])
    second = create_second_engine(settings)
    assert isinstance(second, HomrEngine)
    assert second.info() == {"name": "homr", "version": "0.7.0", "available": True, "device": "cpu"}
    assert create_second_engine(Settings(engine="homr", workdir=tmp_path)) is None
    missing = Settings(engine="homr", workdir=tmp_path, second_homr_command=[str(tmp_path / "nowhere")])
    assert create_second_engine(missing) is None
