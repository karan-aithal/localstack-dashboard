import subprocess
import time

import pytest
from app import insights
from conftest import ORIGIN, live

BASE = "/api/instances/default/insights/sessions"


def at(clock: str, text: str = "") -> str:
    return f"2026-01-01T{clock}.000000001Z {text}"


def logged(clock: str, logger: str, message: str) -> str:
    return at(clock, f"2026-01-01T{clock}.000  INFO --- [et.reactor-0] {logger:<26} : {message}")


def request(clock: str, outcome: str) -> str:
    return logged(clock, "localstack.request.aws", f"AWS {outcome}")


FIRST = [
    at("10:00:00"),
    at("10:00:00", "LocalStack version: 1.0"),
    request("10:00:05", "s3.CreateBucket => 200"),
    # trace logging appends the request itself, which must not be kept
    request("10:00:10", "s3.GetObject => 404 (NoSuchKey); 000000000000/us-east-1; secret"),
    logged("10:00:20", "localstack.request.http", "GET /_localstack/health => 200"),
    # printed by something else, so not a request
    at("10:00:21", "AWS s3.Forged => 200"),
    logged("10:00:30", "l.runtime.shutdown", "[shutdown] Stopping all services"),
]
SECOND = [
    at("12:00:00"),
    at("12:00:00", "LocalStack version: 1.1"),
    request("12:00:01", "sqs.SendMessage => 200"),
]


@pytest.fixture
def log(monkeypatch):
    """The container log that docker reports; its state is "running"."""
    lines: list[str] = []
    calls: list[tuple] = []

    def docker(*args):
        calls.append(args)
        out = "running\n" if args[0] == "inspect" else "\n".join(lines) + "\n"
        return subprocess.CompletedProcess(args, 0, out, "")

    monkeypatch.setattr(insights, "docker", docker)
    return type("Log", (), {"lines": lines, "calls": calls})


def test_runs_and_their_counts(client, log):
    log.lines += FIRST + SECOND
    newest, oldest = client.get(BASE).json()["sessions"]
    assert (newest["version"], newest["state"], newest["ok"]) == ("1.1", "running", 1)
    assert (oldest["version"], oldest["state"]) == ("1.0", "stopped")
    assert (oldest["ok"], oldest["failed"], oldest["services"]) == (1, 1, 1)
    # ends with its own last line, not with the blank line before the next run
    assert oldest["ended"] - oldest["id"] == 30


def test_reading_again_adds_nothing_and_new_lines_join_their_run(client, log):
    log.lines += FIRST + SECOND[:2]
    client.get(BASE)
    log.lines += SECOND[2:]
    client.get(BASE)
    found = client.get(BASE).json()["sessions"]
    assert [(s["ok"], s["failed"]) for s in found] == [(1, 0), (1, 1)]
    assert any("--since" in call for call in log.calls)


def test_log_without_a_version_line(client, log):
    log.lines.append(request("09:00:00", "sts.GetCallerIdentity => 200"))
    [only] = client.get(BASE).json()["sessions"]
    assert (only["version"], only["ok"]) == ("", 1)


def test_stored_runs_stay_when_the_log_is_gone(client, log, monkeypatch):
    log.lines += FIRST
    client.get(BASE)
    monkeypatch.setattr(
        insights,
        "docker",
        lambda *args: subprocess.CompletedProcess(args, 1, "", "No such container"),
    )
    body = client.get(BASE).json()
    assert body["error"] == "No such container"
    assert body["sessions"][0]["ok"] == 1


def test_detail_filters(client, log):
    log.lines += FIRST
    run = client.get(BASE).json()["sessions"][0]["id"]
    url = f"{BASE}/{run}"

    everything = client.get(url).json()
    assert sum(b["ok"] + b["failed"] for b in everything["timeline"]) == 2
    assert [e["operation"] for e in everything["events"]] == ["GetObject", "CreateBucket"]
    assert everything["events"][0]["error"] == "NoSuchKey"
    assert "secret" not in client.get(url).text

    failed = client.get(url, params={"failed": True}).json()
    assert failed["services"] == [{"service": "s3", "ok": 0, "failed": 1}]

    early = client.get(url, params={"start": run, "end": run + 5}).json()
    assert [e["operation"] for e in early["events"]] == ["CreateBucket"]

    other = client.get(url, params={"service": "sqs"}).json()
    assert other["events"] == [] and other["names"] == ["s3"]


@pytest.mark.parametrize(
    "path,expected",
    [("/1", 404), ("/x", 422), ("/1?service=a%27--", 422), ("/1?start=-1", 422)],
)
def test_unknown_or_unsafe_requests(client, log, path, expected):
    assert client.get(BASE + path).status_code == expected


@live
def test_live_requests_are_counted(client):
    def calls():
        newest = client.get(BASE).json()["sessions"][0]
        detail = client.get(f"{BASE}/{newest['id']}", params={"service": "sts"}).json()
        return sum(b["ok"] for b in detail["timeline"])

    before = calls()
    url = "/api/instances/default/aws/sts/GetCallerIdentity"
    assert client.post(url, json={}, headers=ORIGIN).status_code == 200
    for _ in range(50):
        if calls() > before:
            break
        time.sleep(0.1)
    assert calls() > before
