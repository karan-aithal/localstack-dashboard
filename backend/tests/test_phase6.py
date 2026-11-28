"""
Chaos, IAM, state and replicator. The instance is replaced by a recorder, except in the live
tests, which only read. Tests that change the instance run when DASHBOARD_TEST_STATE is set.
"""

import io
import os
import zipfile

import pytest
from app import chaos, iam, replicator, state
from conftest import ORIGIN, live
from fastapi import HTTPException

BASE = "/api/instances/default"

changes = pytest.mark.skipif(
    not os.environ.get("DASHBOARD_TEST_STATE"),
    reason="injects faults and switches settings of the instance: set DASHBOARD_TEST_STATE=1",
)


class Reply:
    def __init__(self, data=None, text=""):
        self.data, self.text = data, text

    def json(self):
        return self.data


@pytest.fixture
def sent(monkeypatch):
    """Requests that would have reached the instance."""
    calls = []

    def fetch(instance, path, method="GET", body=None, **options):
        calls.append({"path": path, "method": method, "body": body, **options})
        return Reply([], "")

    for module in (chaos, iam, replicator, state):
        monkeypatch.setattr(module, "fetch", fetch)
    return calls


def test_permission_check_wants_full_arns(client, sent):
    permission = {"action": "s3:ListBucket", "resource": "*"}
    body = {"access_key_id": "a", "region_name": "b", "required_permissions": [permission]}
    assert client.post(f"{BASE}/iam/check", json=body, headers=ORIGIN).status_code == 422
    assert sent == []


def test_missing_state_routes_are_explained(client, monkeypatch):
    monkeypatch.setattr(state, "fetch", lambda *a, **k: None)
    response = client.post(f"{BASE}/state/save", headers=ORIGIN)
    assert response.status_code == 502
    assert "persistence" in response.json()["detail"]


RULE = {"service": "s3", "probability": 0.5, "error": {"statusCode": 503, "code": "Unavailable"}}


def test_fault_rules_are_forwarded(client, sent):
    url = f"{BASE}/chaos/faults"
    assert client.post(url, json=[RULE], headers=ORIGIN).status_code == 200
    assert client.post(f"{url}/remove", json=[RULE], headers=ORIGIN).status_code == 200
    assert client.delete(url, headers=ORIGIN).status_code == 200
    assert [(c["method"], c["body"]) for c in sent] == [
        ("PATCH", [RULE]),
        ("DELETE", [RULE]),
        ("POST", []),
    ]


CHECK = {"access_key_id": "a", "region_name": "b", "required_permissions": []}


@pytest.mark.parametrize(
    "method,path,body",
    [
        ("post", "/chaos/faults", []),
        ("post", "/chaos/faults", [{"probability": 2}]),
        ("post", "/chaos/faults", [{"service": "s3/../x"}]),
        ("post", "/chaos/faults", [{"unknown": 1}]),
        ("post", "/chaos/faults", [{"error": {"statusCode": 200}}]),
        ("put", "/chaos/latency", {"latency": -1}),
        ("put", "/iam/config", {"state": "OFF"}),
        ("post", "/iam/check", CHECK),
        ("post", "/state/reset", {"service": "../x"}),
        ("post", "/state/delete", None),
        ("post", "/pods", {"pod": "../x"}),
        ("post", "/pods", {"pod": "a", "services": ["s3&x=1"]}),
        ("post", "/remotes/r", {"url": "s3://user:secret@bucket", "protocols": ["s3"]}),
        ("post", "/pods/a/1/load?merge=x", None),
    ],
)
def test_bad_input_never_reaches_the_instance(client, sent, method, path, body):
    kwargs = {} if body is None else {"json": body}
    response = getattr(client, method)(BASE + path, headers=ORIGIN, **kwargs)
    assert response.status_code == 422
    assert sent == []


@pytest.mark.parametrize(
    "method,path",
    [
        ("delete", f"{BASE}/chaos/faults"),
        ("put", f"{BASE}/iam/config"),
        ("post", f"{BASE}/state/reset"),
        ("post", f"{BASE}/replicator/jobs"),
        ("post", "/api/pods/a"),
        ("delete", "/api/pods/a/1"),
    ],
)
def test_changes_need_same_origin(client, sent, method, path):
    assert getattr(client, method)(path).status_code == 403
    assert sent == []


def test_state_requests(client, sent):
    for body in ({}, {"service": "s3"}):
        assert client.post(f"{BASE}/state/reset", json=body, headers=ORIGIN).status_code == 200
    assert client.post(f"{BASE}/state/save", headers=ORIGIN).json() == []
    assert [c["path"] for c in sent] == [
        "/_localstack/state/reset",
        "/_localstack/state/s3/reset",
        "/_localstack/state/save",
    ]


def archive() -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as made:
        made.writestr("state", "x")
    return buffer.getvalue()


def test_local_pods(client, sent):
    content = archive()
    for _ in range(2):
        response = client.post("/api/pods/demo", content=content, headers=ORIGIN)
        assert response.status_code == 200, response.json()
    listed = client.get("/api/pods").json()
    assert [(p["pod"], p["version"]) for p in listed["pods"]] == [("demo", 2), ("demo", 1)]
    assert listed["size"] == 2 * len(content)

    download = client.get("/api/pods/demo/2/download")
    assert download.content == content
    assert download.headers["content-disposition"].startswith("attachment;")
    cross = {"sec-fetch-site": "cross-site"}
    assert client.get("/api/pods/demo/2/download", headers=cross).status_code == 403

    load = f"{BASE}/pods/demo/2/load?merge=overwrite"
    assert client.post(load, headers=ORIGIN).status_code == 200
    assert sent[-1]["content"] == content and sent[-1]["params"] == {"merge": "overwrite"}

    assert client.delete("/api/pods/demo/1", headers=ORIGIN).status_code == 204
    assert client.delete("/api/pods/demo/1", headers=ORIGIN).status_code == 404
    assert client.delete("/api/pods/demo/2", headers=ORIGIN).status_code == 204
    assert not (state.folder() / "demo").exists()


def test_only_zip_archives_become_pods(client):
    response = client.post("/api/pods/demo", content=b"not a zip", headers=ORIGIN)
    assert response.status_code == 422
    assert client.get("/api/pods").json()["pods"] == []
    assert list(state.folder().rglob("*.part")) == []


def test_pod_import_has_a_limit(client, monkeypatch):
    monkeypatch.setattr(state, "IMPORT_LIMIT", 10)
    response = client.post("/api/pods/demo", content=archive(), headers=ORIGIN)
    assert response.status_code == 413
    assert [p for p in state.folder().rglob("*") if p.is_file()] == []


SOURCE = {
    "aws_access_key_id": "AKIDEXAMPLE",
    "aws_secret_access_key": "dummy-secret-value",
    "aws_session_token": "dummy-session-value",
    "region_name": "us-east-1",
}


def job(**more):
    return {"replication_type": "MOCK", "source_aws_config": SOURCE, **more}


def test_replication_job_is_sent_and_secrets_stay_out_of_the_answer(client, monkeypatch):
    seen = {}

    def fetch(instance, path, method="GET", body=None, **options):
        seen.update(body)
        echo = f"queued with {SOURCE['aws_secret_access_key']}"
        return Reply({"job_id": "1", "state": echo, "source_aws_config": SOURCE})

    monkeypatch.setattr(replicator, "fetch", fetch)
    response = client.post(f"{BASE}/replicator/jobs", json=job(), headers=ORIGIN)
    assert response.json() == [{"job_id": "1", "state": "queued with <redacted>"}]
    assert seen["source_aws_config"] == SOURCE


def test_replication_errors_hide_the_credentials(client, monkeypatch):
    def fetch(*args, **kwargs):
        raise HTTPException(502, f"bad token {SOURCE['aws_session_token']}")

    monkeypatch.setattr(replicator, "fetch", fetch)
    response = client.post(f"{BASE}/replicator/jobs", json=job(), headers=ORIGIN)
    assert response.json()["detail"] == "bad token <redacted>"


@pytest.mark.parametrize(
    "body",
    [
        job(replication_type="BATCH"),
        job(replication_type="SINGLE_RESOURCE"),
        job(replication_job_config={"resource_type": "AWS::IAM::Role"}),
        job(replication_job_config={}),
        job(source_aws_config={**SOURCE, "endpoint_url": "http://example.com"}),
        job(target_aws_config=SOURCE),
    ],
)
def test_bad_replication_jobs_are_not_sent(client, sent, body):
    response = client.post(f"{BASE}/replicator/jobs", json=body, headers=ORIGIN)
    assert response.status_code == 422
    assert sent == []


def covered(response):
    if response.status_code == 502 and "404" in response.json()["detail"]:
        pytest.skip("the license does not include this")
    assert response.status_code == 200, response.json()
    return response.json()


@live
@pytest.mark.parametrize(
    "path",
    [
        "/chaos",
        "/iam/config",
        "/iam/summary",
        "/remotes",
        "/replicator/jobs",
        "/replicator/resources",
    ],
)
def test_live_reads(client, path):
    covered(client.get(BASE + path))


@live
def test_live_permission_check(client):
    body = {
        "access_key_id": "000000000000",
        "region_name": "us-east-1",
        "required_permissions": [{"action": "s3:ListBucket", "resource": "arn:aws:s3:::x"}],
    }
    assert "allowed" in covered(client.post(f"{BASE}/iam/check", json=body, headers=ORIGIN))


@changes
@live
def test_live_chaos(client):
    before = covered(client.get(f"{BASE}/chaos"))
    if before["faults"] or before["latency"]:
        pytest.skip("faults are already set: leaving them alone")
    # a service nothing else here uses, so that only this test is hurt
    rule = {"service": "swf", "error": {"statusCode": 503, "code": "DashboardTest"}}

    def put(path, body):
        return client.put(f"{BASE}/chaos{path}", json=body, headers=ORIGIN)

    def post(path, body):
        return client.post(f"{BASE}{path}", json=body, headers=ORIGIN)

    try:
        assert post("/chaos/faults", [rule]).status_code == 200
        failed = post("/aws/swf/ListDomains", {"params": {"registrationStatus": "REGISTERED"}})
        assert "DashboardTest" in failed.json()["detail"]
        assert post("/chaos/faults/remove", [rule]).status_code == 200
        assert client.get(f"{BASE}/chaos").json()["faults"] == []
        assert put("/latency", {"latency": 5}).status_code == 200
        assert client.get(f"{BASE}/chaos").json()["latency"] == 5
    finally:
        client.delete(f"{BASE}/chaos/faults", headers=ORIGIN)
        put("/latency", {"latency": 0})


@changes
@live
def test_live_enforcement_switch(client):
    url = f"{BASE}/iam/config"
    before = covered(client.get(url))["state"]
    try:
        assert client.put(url, json={"state": "SOFT_MODE"}, headers=ORIGIN).status_code == 200
        assert client.get(url).json()["state"] == "SOFT_MODE"
    finally:
        client.put(url, json={"state": before}, headers=ORIGIN)


@changes
@live
def test_live_pod_roundtrip(client):
    """Export a queue, reset SQS, load the export and find the queue again."""

    def aws(operation, **params):
        url = f"{BASE}/aws/sqs/{operation}"
        response = client.post(url, json={"params": params}, headers=ORIGIN)
        assert response.status_code == 200, response.json()
        return response.json()["result"]

    # the reset reaches every account and region, so look in all of them
    if client.get(f"{BASE}/resources").json().get("AWS::SQS::Queue"):
        pytest.skip("SQS holds queues: the test would delete them")

    def reset():
        return client.post(f"{BASE}/state/reset", json={"service": "sqs"}, headers=ORIGIN)

    aws("CreateQueue", QueueName="dashboard-test-pod")
    try:
        body = {"pod": "dashboard-test", "services": ["sqs"]}
        covered(client.post(f"{BASE}/pods", json=body, headers=ORIGIN))
        assert reset().status_code == 200
        assert not aws("ListQueues").get("QueueUrls")
        covered(client.post(f"{BASE}/pods/dashboard-test/1/load", headers=ORIGIN))
        assert "dashboard-test-pod" in aws("ListQueues")["QueueUrls"][0]
    finally:
        reset()
