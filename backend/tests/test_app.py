import asyncio

import pytest
from app import instance, logs
from app.security import redact
from conftest import GOOD, ORIGIN, live


def test_foreign_host_rejected(client):
    assert client.get("/api/instances", headers={"host": "evil.example"}).status_code == 400


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"origin": "http://localhost:5180"},
        {"x-dashboard": "1"},
        {"origin": "http://localhost:5173", "x-dashboard": "1"},
        {"origin": "https://evil.example", "x-dashboard": "1"},
    ],
)
def test_cross_site_write_rejected(client, headers):
    assert client.put("/api/instances/x", json=GOOD, headers=headers).status_code == 403


@pytest.mark.parametrize(
    "bad",
    [
        {"container": "--privileged"},
        {"container": "a;rm"},
        {"endpoint": "file:///etc/passwd"},
        {"endpoint": "http://user:pw@host"},
        {"endpoint": "http://localhost:4566/path"},
    ],
)
def test_unsafe_instance_rejected(client, bad):
    response = client.put("/api/instances/x", json=GOOD | bad, headers=ORIGIN)
    assert response.status_code == 422


def test_instance_crud(client):
    assert client.delete("/api/instances/default", headers=ORIGIN).status_code == 400
    assert client.put("/api/instances/two", json=GOOD, headers=ORIGIN).status_code == 200
    assert set(client.get("/api/instances").json()) == {"default", "two"}
    assert client.delete("/api/instances/two", headers=ORIGIN).status_code == 204
    assert client.get("/api/instances/two/status").status_code == 404


def test_unreachable_instance(client):
    down = GOOD | {"endpoint": "http://127.0.0.1:1"}
    client.put("/api/instances/down", json=down, headers=ORIGIN)
    assert client.get("/api/instances/down/status").status_code == 502


def test_redact():
    token = "ls-abcdEFGH1234-ijkl-5678"
    data = {"api_key": "x", "AUTH_TOKEN": "y", "secretsmanager": "available", "log": [f"t={token}"]}
    assert redact(data) == {
        "api_key": "<redacted>",
        "AUTH_TOKEN": "<redacted>",
        "secretsmanager": "available",
        "log": ["t=<redacted>"],
    }


# actions are mocked: restarting or stopping a real instance would wipe its state
def test_actions(client, monkeypatch):
    calls = []
    monkeypatch.setattr(instance, "call", lambda *a, **kw: calls.append(kw["body"]))
    monkeypatch.setattr(
        instance,
        "docker",
        lambda *args: calls.append(args) or type("R", (), {"returncode": 0, "stderr": ""})(),
    )
    for action in ("restart", "stop", "start"):
        url = f"/api/instances/default/actions/{action}"
        assert client.post(url, headers=ORIGIN).status_code == 200
    assert calls == [
        {"action": "restart"},
        ("stop", "localstack-main"),
        ("start", "localstack-main"),
    ]
    assert client.post("/api/instances/default/actions/kill", headers=ORIGIN).status_code == 422


@live
def test_live_reads(client):
    overview = client.get("/api/instances/default/overview").json()
    assert overview["info"]["version"]
    assert overview["plugins"]
    assert "license" not in overview
    assert client.get("/api/instances/default/status").json()["health"]["services"]
    assert client.get("/api/instances/default/config").status_code == 200
    assert client.get("/api/instances/default/container").json() == {"state": "running"}


@live
def test_live_logs():
    async def first_event():
        stream = logs.follow(GOOD["container"], 5)
        try:
            return await anext(stream)
        finally:
            await stream.aclose()

    assert asyncio.run(first_event()).startswith("data: ")
