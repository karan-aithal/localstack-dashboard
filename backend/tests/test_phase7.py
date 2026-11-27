import pytest
from app.main import mount_ui
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture
def ui(tmp_path):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("the page")
    (dist / "assets" / "app.js").write_text("code")
    (tmp_path / "secret.txt").write_text("secret")
    site = FastAPI()
    mount_ui(site, dist)
    return TestClient(site)


@pytest.mark.parametrize(
    "path", ["/", "/insights/1", "/resources/s3/my.bucket", f"/resources/sqs/{'a' * 400}"]
)
def test_page_addresses_get_the_page(ui, path):
    response = ui.get(path)
    assert response.text == "the page"
    assert "frame-ancestors 'none'" in response.headers["content-security-policy"]


def test_files_are_served(ui):
    assert ui.get("/assets/app.js").text == "code"


@pytest.mark.parametrize("path", ["/api/unknown", "/assets/missing.js"])
def test_missing_api_and_files_stay_missing(ui, path):
    assert ui.get(path).status_code == 404


@pytest.mark.parametrize(
    "path", ["/%2e%2e/secret.txt", "/..%2fsecret.txt", "/assets/..%2f..%2fsecret.txt"]
)
def test_nothing_outside_the_build_is_served(ui, path):
    assert "secret" not in ui.get(path).text


def test_without_a_build_there_is_no_page(tmp_path):
    site = FastAPI()
    mount_ui(site, tmp_path / "missing")
    assert TestClient(site).get("/").status_code == 404
