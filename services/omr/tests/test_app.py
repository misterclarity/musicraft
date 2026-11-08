from fastapi.testclient import TestClient

from musicraft_omr.app import create_app
from musicraft_omr.config import Settings


def make_client(**overrides) -> TestClient:
    settings = Settings(engine="fake", **overrides)
    return TestClient(create_app(settings))


def test_health_is_public_and_reports_engine():
    client = make_client(api_key="secret")
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["engine"]["name"] == "fake"
    assert body["limits"]["maxPages"] == 40


def test_omr_prefix_is_accepted():
    client = make_client()
    assert client.get("/omr/health").status_code == 200


def test_key_required_when_configured():
    client = make_client(api_key="secret")
    assert client.get("/v1/omr/jobs/unknown").status_code == 401
    wrong = client.get("/v1/omr/jobs/unknown", headers={"Authorization": "Bearer nope"})
    assert wrong.status_code == 401
    right = client.get("/v1/omr/jobs/unknown", headers={"Authorization": "Bearer secret"})
    assert right.status_code != 401


def test_cors_preflight_needs_no_key_and_errors_carry_cors_headers():
    client = make_client(api_key="secret", cors_origins=["https://app.example"])
    preflight = client.options(
        "/v1/omr/jobs",
        headers={
            "Origin": "https://app.example",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization",
        },
    )
    assert preflight.status_code == 200
    assert preflight.headers["access-control-allow-origin"] == "https://app.example"
    denied = client.get("/v1/omr/jobs/x", headers={"Origin": "https://app.example"})
    assert denied.status_code == 401
    assert denied.headers["access-control-allow-origin"] == "https://app.example"
