"""Instance bookmarks and everything read from or done to a LocalStack instance."""

import json
import os
import subprocess
from pathlib import Path as FilePath
from typing import Annotated, Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import BaseModel, Field

from .security import redact, redact_text

router = APIRouter(prefix="/api/instances")

HOME = os.environ.get("DASHBOARD_HOME", "~/.config/localstack-dashboard")
STORE = FilePath(HOME).expanduser() / "instances.json"
DEFAULT = {"default": {"endpoint": "http://localhost:4566", "container": "localstack-main"}}

Name = Annotated[str, Path(pattern=r"^[A-Za-z0-9_-]{1,40}$")]


class Instance(BaseModel):
    # scheme, host and port only: no credentials, path or query
    endpoint: str = Field(pattern=r"^https?://(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+)(:\d{1,5})?$")
    # must not start with "-", so it can never be read as a docker flag
    container: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")


def load() -> dict[str, dict]:
    if not STORE.exists():
        return dict(DEFAULT)
    return json.loads(STORE.read_text())


def save(instances: dict[str, dict]) -> None:
    STORE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STORE.with_suffix(".tmp")
    tmp.write_text(json.dumps(instances, indent=2))
    tmp.replace(STORE)


def get_instance(name: Name) -> Instance:
    instances = load()
    if name not in instances:
        raise HTTPException(404, f"Unknown instance: {name}")
    return Instance(**instances[name])


Selected = Annotated[Instance, Depends(get_instance)]


def fetch(instance: Instance, path: str, method="GET", body=None, optional=False, **options):
    """
    Request an internal LocalStack endpoint.

    :param optional: return None on 404, for endpoints that depend on the edition or configuration
    :param options: passed to httpx, such as params and headers
    """
    try:
        response = httpx.request(
            method, instance.endpoint + path, json=body, timeout=15, trust_env=False, **options
        )
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Instance unreachable: {type(e).__name__}") from e
    if optional and response.status_code == 404:
        return None
    if response.is_error:
        raise HTTPException(502, f"{method} {path} returned {response.status_code}")
    return response


def call(instance: Instance, path: str, method="GET", body=None, optional=False):
    """Like `fetch`, returning the redacted JSON body, or None if there is none."""
    response = fetch(instance, path, method, body, optional)
    if response is None:
        return None
    try:
        return redact(response.json())
    except ValueError:
        return None


def docker(*args: str) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(["docker", *args], capture_output=True, text=True, timeout=90)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise HTTPException(502, f"docker failed: {type(e).__name__}") from e


@router.get("")
def list_instances():
    return load()


@router.put("/{name}")
def put_instance(name: Name, instance: Instance):
    save({**load(), name: instance.model_dump()})
    return instance


@router.delete("/{name}", status_code=204)
def delete_instance(name: Name):
    instances = load()
    if name not in instances:
        raise HTTPException(404, f"Unknown instance: {name}")
    if len(instances) == 1:
        raise HTTPException(400, "Cannot delete the only instance")
    del instances[name]
    save(instances)


@router.get("/{name}/overview")
def overview(instance: Selected):
    license_info = call(instance, "/_localstack/licenseinfo", optional=True) or {}
    plugins = call(instance, "/_localstack/plugins")
    return {
        "info": call(instance, "/_localstack/info"),
        "stackinfo": call(instance, "/_localstack/stackinfo", optional=True),
        # only the plan type: the rest of the license document stays on the server
        "license_type": (license_info.get("license") or {}).get("type"),
        "plugins": plugins.get("localstack.platform.plugin", []),
    }


@router.get("/{name}/status")
def status(instance: Selected):
    return {
        "health": call(instance, "/_localstack/health"),
        "init": call(instance, "/_localstack/init", optional=True),
    }


@router.get("/{name}/config")
def config(instance: Selected):
    values = call(instance, "/_localstack/config", optional=True)
    return {"enabled": values is not None, "values": values or {}}


@router.get("/{name}/resources")
def resources(instance: Selected):
    """All resources of the instance, across accounts and regions, grouped by resource type."""
    grouped: dict[str, list] = {}
    # newline delimited JSON, each line holding some resource types
    for line in fetch(instance, "/_localstack/resources").text.splitlines():
        if not line.strip():
            continue
        try:
            for resource_type, items in json.loads(line).items():
                # redact the items only: type names such as ...::Secret look like secret keys
                grouped.setdefault(resource_type, []).extend(redact(items))
        except (ValueError, AttributeError, TypeError) as e:
            raise HTTPException(502, "Unexpected resources response") from e
    return grouped


@router.get("/{name}/container")
def container_state(instance: Selected):
    result = docker("inspect", "--format", "{{.State.Status}}", instance.container)
    return {"state": result.stdout.strip() if result.returncode == 0 else "missing"}


@router.post("/{name}/actions/{action}")
def run_action(instance: Selected, action: Literal["restart", "start", "stop"]):
    if action == "restart":
        call(instance, "/_localstack/health", method="POST", body={"action": "restart"})
    else:
        result = docker(action, instance.container)
        if result.returncode != 0:
            raise HTTPException(502, redact_text(result.stderr.strip()))
    return {"ok": True}
