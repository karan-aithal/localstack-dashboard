import time

import pytest
from app import extensions
from conftest import ORIGIN, live

BASE = "/api/instances/default"


@pytest.mark.parametrize(
    "package",
    [
        "git+https://example.com/x",
        "https://example.com/x.whl",
        "./local",
        "/etc/passwd",
        "--index-url=http://example.com",
        "name --pre",
        "name;rm",
        "name>=1",
        "",
    ],
)
def test_only_package_names_can_be_installed(client, monkeypatch, package):
    monkeypatch.setattr(extensions, "fetch", lambda *a, **kw: pytest.fail("must not be sent"))
    url = f"{BASE}/extensions/install"
    assert client.post(url, json={"package": package}, headers=ORIGIN).status_code == 422


def test_installing_needs_same_origin(client, monkeypatch):
    monkeypatch.setattr(extensions, "fetch", lambda *a, **kw: pytest.fail("must not be sent"))
    url = f"{BASE}/extensions/install"
    assert client.post(url, json={"package": "x"}).status_code == 403


@pytest.mark.parametrize("last,ok", [("status", True), ("exception", False)])
def test_install_outcome_comes_from_the_events(client, monkeypatch, last, ok):
    stream = (
        '{"event": "pip", "message": "token ls-abcdEFGH1234-ijkl"}\n\n'
        f'{{"event": "{last}", "message": "done", "extra": {{"traceback": "long"}}}}\n'
    )
    sent = {}

    def fetch(instance, path, **kwargs):
        sent.update(kwargs, path=path)
        return type("R", (), {"text": stream})()

    monkeypatch.setattr(extensions, "fetch", fetch)
    url = f"{BASE}/extensions/install"
    result = client.post(url, json={"package": "localstack-x==1.2"}, headers=ORIGIN).json()
    assert sent["body"] == {"URL": "localstack-x==1.2"}
    assert result == {
        "ok": ok,
        "events": [
            {"event": "pip", "message": "token <redacted>"},
            {"event": last, "message": "done"},
        ],
    }


@pytest.mark.parametrize(
    "text,ok",
    [("", True), ('Removed\n{"event": "status"}\n', True), ('{"event": "exception"}\n', False)],
)
def test_removal_fails_only_if_the_answer_says_so(client, monkeypatch, text, ok):
    monkeypatch.setattr(extensions, "fetch", lambda *a, **kw: type("R", (), {"text": text})())
    url = f"{BASE}/extensions/uninstall"
    assert client.post(url, json={"package": "x"}, headers=ORIGIN).json() == {"ok": ok}


def test_describe_extension():
    nested = {"distribution": {"name": "pkg", "version": "1"}, "name": "plugin"}
    assert extensions.describe(nested)["name"] == "pkg"
    assert extensions.describe(nested)["version"] == "1"
    assert extensions.describe({"distribution": "pkg"})["name"] == "pkg"
    assert extensions.describe({"name": "plugin", "version": "2"})["version"] == "2"


@pytest.mark.parametrize(
    "path",
    [
        "spans/zz/0000000000000000/iam",
        f"spans/{'a' * 32}/b/iam",
    ],
)
def test_unsafe_ids_rejected(client, path):
    assert client.get(f"{BASE}/appinspector/{path}").status_code == 422


@live
def test_live_extensions(client):
    assert isinstance(client.get(f"{BASE}/extensions").json(), list)
    body = {"package": "dashboard-test-not-installed"}
    response = client.post(f"{BASE}/extensions/uninstall", json=body, headers=ORIGIN)
    # the instance's reason is passed on
    assert response.status_code == 502
    assert "could not find" in response.json()["detail"]


@live
def test_live_app_inspector(client):
    url = f"{BASE}/appinspector"

    def switch(status):
        response = client.put(f"{url}/status", json={"status": status}, headers=ORIGIN)
        assert response.status_code == 200

    before = client.get(f"{url}/status").json()["status"]
    if before == "ENABLED":
        pytest.skip("App Inspector is in use: the test would delete its traces")
    switch("ENABLED")
    try:
        client.delete(f"{url}/traces", headers=ORIGIN)
        body = {"params": {"QueueNamePrefix": "dashboard-test"}}
        client.post(f"{BASE}/aws/sqs/ListQueues", json=body, headers=ORIGIN)
        for _ in range(50):
            spans = client.get(f"{url}/spans").json()["spans"]
            if spans:
                break
            time.sleep(0.1)
        span = spans[0]
        assert span["operation_name"] == "ListQueues"
        iam = client.get(f"{url}/spans/{span['trace_id']}/{span['span_id']}/iam")
        assert iam.status_code == 200 and "events" in iam.json()
        assert client.delete(f"{url}/traces", headers=ORIGIN).json()["deleted_count"] >= 1
    finally:
        switch(before)
