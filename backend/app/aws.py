"""Generic AWS access: any operation of any service, always against the selected instance."""

import base64
import binascii
import html
import os
import re
import time
from datetime import date
from functools import lru_cache
from urllib.parse import urlsplit

import boto3
import httpx
import jmespath
from botocore import xform_name
from botocore.config import Config
from botocore.eventstream import EventStream
from botocore.exceptions import BotoCoreError, ClientError, DataNotFoundError, ParamValidationError
from botocore.response import StreamingBody
from botocore.session import get_session
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .instance import Selected, call
from .security import redact_strings, redact_text

# Nothing from the user's own AWS setup may reach these clients: no credentials, profile,
# region or endpoint override from the environment or from ~/.aws.
for _key in [k for k in os.environ if k.startswith("AWS_")]:
    del os.environ[_key]
os.environ["AWS_CONFIG_FILE"] = os.environ["AWS_SHARED_CREDENTIALS_FILE"] = os.devnull

BODY_LIMIT = 5 * 1024 * 1024
EVENT_LIMIT = 100
EVENT_SECONDS = 30

CLIENT_CONFIG = Config(
    proxies={},
    retries={"total_max_attempts": 1},
    connect_timeout=5,
    read_timeout=120,
    # parameters must never become part of the hostname
    inject_host_prefix=False,
    endpoint_discovery_enabled=False,
    ignore_configured_endpoint_urls=True,
    s3={"addressing_style": "path"},
)

router = APIRouter(prefix="/api")


@lru_cache
def _session():
    return get_session()


@lru_cache(maxsize=None)
def service_model(service: str):
    if service not in _session().get_available_services():
        raise HTTPException(404, f"Unknown service: {service}")
    return _session().get_service_model(service)


def operation_model(service: str, operation: str):
    model = service_model(service)
    if operation not in model.operation_names:
        raise HTTPException(404, f"Unknown operation: {service}.{operation}")
    return model.operation_model(operation)


def host_guard(host: str):
    """Last line of defence: refuse to send a request anywhere but the configured instance."""

    def check(request, **_):
        target = urlsplit(request.url).hostname or ""
        if target != host and not target.endswith("." + host):
            raise HTTPException(400, f"Refused to send a request to {target}")

    return check


@lru_cache(maxsize=64)
def client(endpoint: str, service: str, region: str, account: str):
    result = boto3.session.Session().client(
        service,
        endpoint_url=endpoint,
        region_name=region,
        # LocalStack takes the account ID from a 12 digit access key ID
        aws_access_key_id=account,
        aws_secret_access_key="test",
        config=CLIENT_CONFIG,
    )
    result.meta.events.register("before-send", host_guard(urlsplit(endpoint).hostname))
    return result


def template(shape, seen=()):
    """Example value for a shape, to show what a nested field expects. Stops at recursion."""
    kind = shape.type_name
    if kind in ("structure", "list", "map") and (shape.name in seen or len(seen) > 4):
        return [] if kind == "list" else {}
    seen = (*seen, shape.name)
    if kind == "structure":
        members = list(shape.members.items())
        if shape.is_tagged_union:
            members = members[:1]
        return {name: template(member, seen) for name, member in members}
    if kind == "list":
        return [template(shape.member, seen)]
    if kind == "map":
        return {"key": template(shape.value, seen)}
    if kind == "string":
        return shape.enum[0] if shape.enum else "string"
    return {
        "boolean": False,
        "integer": 0,
        "long": 0,
        "float": 0,
        "double": 0,
        "timestamp": "2026-01-01T00:00:00Z",
        "blob": "base64",
    }.get(kind, {})


def summary(documentation: str, limit=400) -> str:
    text = " ".join(html.unescape(re.sub(r"<[^>]+>", " ", documentation or "")).split())
    text = re.sub(r" ([.,;:)])", r"\1", text)
    return text if len(text) <= limit else text[:limit].rsplit(" ", 1)[0] + "…"


def decode(value, shape):
    """JSON has no bytes: turn base64 strings into bytes wherever the input shape wants a blob."""
    if shape is None:
        return value
    kind = shape.type_name
    if kind == "blob" and isinstance(value, str):
        try:
            return base64.b64decode(value, validate=True)
        except binascii.Error as e:
            raise HTTPException(422, f"{shape.name}: expected a base64 string") from e
    if kind == "structure" and isinstance(value, dict) and not shape.is_document_type:
        return {k: decode(v, shape.members.get(k)) for k, v in value.items()}
    if kind == "list" and isinstance(value, list):
        return [decode(v, shape.member) for v in value]
    if kind == "map" and isinstance(value, dict):
        return {k: decode(v, shape.value) for k, v in value.items()}
    return value


def _read_body(body: StreamingBody) -> dict:
    try:
        data = body.read(BODY_LIMIT + 1)
    finally:
        body.close()
    truncated = len(data) > BODY_LIMIT
    data = data[:BODY_LIMIT]
    try:
        return {"text": redact_text(data.decode()), "truncated": truncated}
    except UnicodeDecodeError:
        return {"base64": base64.b64encode(data).decode(), "truncated": truncated}


def _read_events(stream: EventStream) -> dict:
    # ponytail: collects a bounded batch; stream to the browser if a page needs live events
    events, deadline = [], time.monotonic() + EVENT_SECONDS
    try:
        for event in stream:
            events.append(jsonable(event))
            if len(events) >= EVENT_LIMIT or time.monotonic() > deadline:
                return {"events": events, "truncated": True}
    finally:
        stream.close()
    return {"events": events, "truncated": False}


def jsonable(value):
    if isinstance(value, dict):
        return {k: jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [jsonable(v) for v in value]
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, bytes):
        return base64.b64encode(value).decode()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, StreamingBody):
        return _read_body(value)
    if isinstance(value, EventStream):
        return _read_events(value)
    return value


def next_page(service: str, operation: str, result: dict) -> dict | None:
    """Parameters to add to the same call to fetch the following page, if there is one."""
    try:
        config = _session().get_paginator_model(service).get_paginator(operation)
    except (DataNotFoundError, ValueError):
        return None
    more = config.get("more_results")
    if more and not jmespath.search(more, result):
        return None
    inputs, outputs = config["input_token"], config["output_token"]
    if isinstance(inputs, str):
        inputs, outputs = [inputs], [outputs]
    tokens = {name: jmespath.search(path, result) for name, path in zip(inputs, outputs)}
    return {name: token for name, token in tokens.items() if token} or None


@router.get("/instances/{name}/services")
def services(instance: Selected):
    health = call(instance, "/_localstack/health")["services"]
    known = set(_session().get_available_services())
    return [
        {
            "id": service,
            "title": service_model(service).metadata.get("serviceFullName", service),
            "state": state,
        }
        for service, state in sorted(health.items())
        if service in known
    ]


@router.get("/aws/{service}")
def operations(service: str):
    return {"operations": sorted(service_model(service).operation_names)}


@router.get("/aws/{service}/{operation}")
def describe(service: str, operation: str):
    model = operation_model(service, operation)
    shape = model.input_shape
    members = shape.members if shape else {}
    required = shape.required_members if shape else []
    fields = [
        {
            "name": name,
            "type": member.type_name,
            "required": name in required,
            "enum": getattr(member, "enum", []),
            "documentation": summary(member.documentation),
            "template": template(member),
        }
        for name, member in members.items()
    ]
    # required fields first, otherwise keep the order of the API definition
    fields.sort(key=lambda field: not field["required"])
    return {"documentation": summary(model.documentation), "fields": fields}


class Invocation(BaseModel):
    params: dict = Field(default_factory=dict)
    region: str = Field("us-east-1", pattern=r"^[a-z0-9-]{1,30}$")
    account: str = Field("000000000000", pattern=r"^\d{12}$")


@router.post("/instances/{name}/aws/{service}/{operation}")
def invoke(instance: Selected, service: str, operation: str, invocation: Invocation):
    shape = operation_model(service, operation).input_shape
    params = decode(invocation.params, shape)
    try:
        aws = client(instance.endpoint, service, invocation.region, invocation.account)
        response = getattr(aws, xform_name(operation))(**params)
        metadata = response.pop("ResponseMetadata", {})
        result = jsonable(response)
    except ClientError as e:
        error = e.response.get("Error", {})
        status = e.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
        detail = f"{error.get('Code')}: {error.get('Message')} (HTTP {status})"
        raise HTTPException(400, redact_text(detail)) from e
    except ParamValidationError as e:
        raise HTTPException(422, str(e)) from e
    except BotoCoreError as e:
        raise HTTPException(502, redact_text(f"{type(e).__name__}: {e}")) from e
    except (TypeError, ValueError, KeyError, AttributeError) as e:
        # botocore customizations run before validation and can trip over wrong types
        raise HTTPException(422, redact_text(f"Invalid parameters: {e}")) from e
    return {
        "status": metadata.get("HTTPStatusCode"),
        "result": result,
        "next": next_page(service, operation, result),
    }


class GraphQL(BaseModel):
    query: str = Field(min_length=1, max_length=100_000)
    variables: dict = Field(default_factory=dict)
    # printable characters only: both become header values
    api_key: str | None = Field(None, pattern=r"^[ -~]{1,200}$")
    authorization: str | None = Field(None, max_length=8192, pattern=r"^[ -~]+$")
    region: str = Field("us-east-1", pattern=r"^[a-z0-9-]{1,30}$")
    account: str = Field("000000000000", pattern=r"^\d{12}$")


@router.post("/instances/{name}/appsync/{api_id}/query")
def graphql(instance: Selected, api_id: str, request: GraphQL):
    """Run a GraphQL request against an AppSync API of the instance."""
    where = Invocation(params={"apiId": api_id}, region=request.region, account=request.account)
    found = invoke(instance, "appsync", "GetGraphqlApi", where)["result"]
    address = urlsplit(found.get("graphqlApi", {}).get("uris", {}).get("GRAPHQL", ""))
    if not address.path.startswith("/"):
        raise HTTPException(502, "The instance gave no GraphQL address for this API")
    # only the path and the host name of that address are used: the request goes to the instance
    headers = {"host": address.netloc} if address.netloc else {}
    if request.api_key:
        headers["x-api-key"] = request.api_key
    if request.authorization:
        headers["authorization"] = request.authorization
    try:
        response = httpx.post(
            instance.endpoint + address.path,
            json={"query": request.query, "variables": request.variables},
            headers=headers,
            timeout=60,
            trust_env=False,
        )
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Instance unreachable: {type(e).__name__}") from e
    # a refused request explains itself in the body, so every status is passed on
    try:
        result = redact_strings(response.json())
    except ValueError:
        result = redact_text(response.text[:BODY_LIMIT])
    return {"status": response.status_code, "result": result}
