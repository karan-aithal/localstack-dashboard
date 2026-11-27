import httpx
import pytest
from app import instance
from app.main import app
from fastapi.testclient import TestClient

ORIGIN = {"origin": "http://localhost:5180", "x-dashboard": "1"}
GOOD = {"endpoint": "http://localhost:4566", "container": "localstack-main"}


def _is_up() -> bool:
    try:
        return httpx.get(GOOD["endpoint"] + "/_localstack/health", timeout=2).is_success
    except httpx.HTTPError:
        return False


live = pytest.mark.skipif(not _is_up(), reason="LocalStack is not running")


@pytest.fixture(autouse=True)
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(instance, "STORE", tmp_path / "instances.json")


@pytest.fixture
def client():
    return TestClient(app, base_url="http://localhost:8080")
