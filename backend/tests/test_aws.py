import base64
import io
import os
import uuid
from datetime import datetime, timezone

import httpx
import pytest
from app import aws, instance
from botocore.response import StreamingBody
from conftest import ORIGIN, live
from fastapi import HTTPException

BASE = "/api/instances/default/aws"


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def test_own_aws_setup_is_ignored():
    assert {k for k in os.environ if k.startswith("AWS_")} == {
        "AWS_CONFIG_FILE",
        "AWS_SHARED_CREDENTIALS_FILE",
    }
    assert os.environ["AWS_CONFIG_FILE"] == os.devnull


def test_describe(client):
    assert "PutObject" in client.get("/api/aws/s3").json()["operations"]
    fields = client.get("/api/aws/s3/PutObject").json()["fields"]
    assert [f["name"] for f in fields if f["required"]] == ["Bucket", "Key"]
    assert fields[0]["required"]
    assert {f["name"]: f["type"] for f in fields}["Body"] == "blob"
    # AttributeValue contains itself: the example value must still terminate
    item = client.get("/api/aws/dynamodb/PutItem").json()["fields"]
    assert any(f["name"] == "Item" and f["template"] for f in item)
    assert client.get("/api/aws/sts/GetCallerIdentity").json()["fields"] == []


@pytest.mark.parametrize("path", ["/api/aws/nope", "/api/aws/s3/Nope", "/api/aws/..%2Fs3"])
def test_unknown_names(client, path):
    assert client.get(path).status_code == 404


def test_graphql_goes_to_the_instance_only(client, monkeypatch):
    url = "/api/instances/default/appsync/abc/query"
    assert client.post(url, json={"query": "{ a }"}).status_code == 403
    for bad in ({"query": ""}, {"query": "{ a }", "api_key": "a\r\nx: y"}):
        assert client.post(url, json=bad, headers=ORIGIN).status_code == 422

    sent = []
    address = {"uris": {"GRAPHQL": "http://abc.evil.example/graphql/abc"}}
    monkeypatch.setattr(aws, "invoke", lambda *_: {"result": {"graphqlApi": address}})

    def post(target, **options):
        sent.append((target, options))
        return httpx.Response(401, json={"errors": [{"message": "ls-abcdefgh1234 denied"}]})

    monkeypatch.setattr(aws.httpx, "post", post)
    response = client.post(url, json={"query": "{ a }", "api_key": "key"}, headers=ORIGIN)
    assert response.json() == {"status": 401, "result": {"errors": [{"message": "<redacted> denied"}]}}
    target, options = sent[0]
    assert target == "http://localhost:4566/graphql/abc"
    assert options["headers"] == {"host": "abc.evil.example", "x-api-key": "key"}

    address["uris"] = {}
    assert client.post(url, json={"query": "{ a }"}, headers=ORIGIN).status_code == 502
    assert len(sent) == 1


def test_invoke_is_guarded(client):
    url = f"{BASE}/s3/ListBuckets"
    assert client.post(url, json={}).status_code == 403
    for bad in ({"account": "123"}, {"region": "us-east-1.evil.example/"}):
        assert client.post(url, json=bad, headers=ORIGIN).status_code == 422


def test_bad_input(client):
    body = {"params": {"Bucket": "b", "Key": "k", "Body": "not base64!"}}
    response = client.post(f"{BASE}/s3/PutObject", json=body, headers=ORIGIN)
    assert response.status_code == 422
    assert "base64" in response.json()["detail"]
    response = client.post(f"{BASE}/s3/GetObject", json={}, headers=ORIGIN)
    assert response.status_code == 422
    assert "Bucket" in response.json()["detail"]


def test_requests_cannot_leave_the_instance():
    class Request:
        def __init__(self, url):
            self.url = url

    check = aws.host_guard("localhost")
    check(request=Request("http://localhost:4566/"))
    check(request=Request("http://bucket.localhost:4566/"))
    for url in ("https://s3.amazonaws.com/", "http://evillocalhost/", "http://localhost.evil/"):
        with pytest.raises(HTTPException):
            check(request=Request(url))


def test_guard_is_wired_into_clients():
    aws.client.cache_clear()
    sts = aws.client("http://127.0.0.1:1", "sts", "us-east-1", "000000000000")
    sts.meta.events.register_first(
        "before-send", lambda request, **_: setattr(request, "url", "http://evil.example/")
    )
    try:
        with pytest.raises(HTTPException, match="evil.example"):
            sts.get_caller_identity()
    finally:
        aws.client.cache_clear()


def test_jsonable():
    value = {
        "blob": b"\x00\x01",
        "when": datetime(2026, 1, 2, tzinfo=timezone.utc),
        "token": ["ls-abcdEFGH1234-ijkl"],
        "text": StreamingBody(io.BytesIO(b"hello"), 5),
        "binary": StreamingBody(io.BytesIO(b"\xff\xfe"), 2),
    }
    assert aws.jsonable(value) == {
        "blob": "AAE=",
        "when": "2026-01-02T00:00:00+00:00",
        "token": ["<redacted>"],
        "text": {"text": "hello", "truncated": False},
        "binary": {"base64": "//4=", "truncated": False},
    }


def test_next_page():
    result = {"IsTruncated": True, "NextContinuationToken": "abc"}
    assert aws.next_page("s3", "ListObjectsV2", result) == {"ContinuationToken": "abc"}
    assert aws.next_page("s3", "ListObjectsV2", result | {"IsTruncated": False}) is None
    assert aws.next_page("dynamodb", "Scan", {"Items": []}) is None
    assert aws.next_page("sqs", "CreateQueue", {}) is None


def test_resources_grouping(client, monkeypatch):
    secret = '{"AWS::SecretsManager::Secret": [{"id": "a"}]}'
    text = f'{secret}\n{{"AWS::S3::Bucket": [{{"id": "b"}}]}}\n{secret}\n'
    monkeypatch.setattr(instance, "fetch", lambda *a: type("R", (), {"text": text})())
    assert client.get("/api/instances/default/resources").json() == {
        "AWS::SecretsManager::Secret": [{"id": "a"}, {"id": "a"}],
        "AWS::S3::Bucket": [{"id": "b"}],
    }


@live
def test_live_explorer(client):
    def run(operation, params=None, service="s3", **scope):
        body = {"params": params or {}, **scope}
        return client.post(f"{BASE}/{service}/{operation}", json=body, headers=ORIGIN)

    services = client.get("/api/instances/default/services").json()
    assert any(s["id"] == "s3" and s["title"] for s in services)

    bucket = f"dashboard-test-{uuid.uuid4().hex[:12]}"
    keys = ["a.txt", "b.bin"]
    assert run("CreateBucket", {"Bucket": bucket}).status_code == 200
    try:
        for key, data in zip(keys, [b"hello", b"\xff\x00"]):
            params = {"Bucket": bucket, "Key": key, "Body": b64(data)}
            assert run("PutObject", params).status_code == 200

        params = {"Bucket": bucket, "MaxKeys": 1}
        first = run("ListObjectsV2", params).json()
        second = run("ListObjectsV2", params | first["next"]).json()
        assert [p["result"]["Contents"][0]["Key"] for p in (first, second)] == keys
        assert second["next"] is None

        text = run("GetObject", {"Bucket": bucket, "Key": "a.txt"}).json()["result"]["Body"]
        assert text == {"text": "hello", "truncated": False}
        binary = run("GetObject", {"Bucket": bucket, "Key": "b.bin"}).json()["result"]["Body"]
        assert binary["base64"] == b64(b"\xff\x00")

        missing = run("GetObject", {"Bucket": bucket, "Key": "nope"})
        assert missing.status_code == 400
        assert missing.json()["detail"].startswith("NoSuchKey")

        resources = client.get("/api/instances/default/resources").json()
        assert bucket in [r["id"] for r in resources["AWS::S3::Bucket"]]
    finally:
        for key in keys:
            run("DeleteObject", {"Bucket": bucket, "Key": key})
        assert run("DeleteBucket", {"Bucket": bucket}).status_code == 200


@live
def test_live_account_switch(client):
    def run(operation, params, account):
        body = {"params": params, "account": account}
        return client.post(f"{BASE}/sqs/{operation}", json=body, headers=ORIGIN).json()

    queue = f"dashboard-test-{uuid.uuid4().hex[:12]}"
    url = run("CreateQueue", {"QueueName": queue}, "111111111111")["result"]["QueueUrl"]
    try:
        assert "111111111111" in url
        other = run("ListQueues", {"QueueNamePrefix": queue}, "000000000000")["result"]
        assert not other.get("QueueUrls")
    finally:
        run("DeleteQueue", {"QueueUrl": url}, "111111111111")
