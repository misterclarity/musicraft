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
