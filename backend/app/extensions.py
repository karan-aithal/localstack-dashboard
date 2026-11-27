"""LocalStack extensions: list, install and remove."""

import json

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .instance import Selected, fetch, read
from .security import redact_text

router = APIRouter(prefix="/api/instances/{name}/extensions")

BASE = "/_localstack/extensions"


class Package(BaseModel):
    # a package name with an optional exact version. No URLs, paths or pip options: installing
    # runs the package's code inside the instance, so only named packages are accepted.
    package: str = Field(
        pattern=r"^[A-Za-z0-9]([A-Za-z0-9._-]{0,100}[A-Za-z0-9])?(==[A-Za-z0-9.]{1,30})?$"
    )


def describe(entry: dict) -> dict:
    """Name and version of an installed extension, wherever the instance puts them."""
    distribution = entry.get("distribution")
    source = distribution if isinstance(distribution, dict) else entry
    name = distribution if isinstance(distribution, str) else source.get("name")
    return {"name": name or entry.get("name"), "version": source.get("version"), "details": entry}


@router.get("")
def installed(instance: Selected):
    return [describe(entry) for entry in read(instance, f"{BASE}/list")]


@router.post("/install")
def install(instance: Selected, wanted: Package):
    response = fetch(
        instance, f"{BASE}/install", method="POST", body={"URL": wanted.package}, timeout=600
    )
    events = []
    try:
        for line in response.text.splitlines():
            if line.strip():
                event = json.loads(line)
                message = redact_text(str(event.get("message", "")))
                events.append({"event": event.get("event"), "message": message})
    except (ValueError, AttributeError) as e:
        raise HTTPException(502, "Unexpected installer response") from e
    # the instance answers 200 even when pip fails: the outcome is in the events
    return {"ok": all(event["event"] != "exception" for event in events), "events": events}


@router.post("/uninstall")
def uninstall(instance: Selected, wanted: Package):
    body = {"distribution": wanted.package}
    read(instance, f"{BASE}/uninstall", method="POST", body=body, timeout=600)
    return {"ok": True}
