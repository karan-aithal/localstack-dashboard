"""
Instance state: reset, save and load, and "local pods", which are state exports kept on this
machine, one zip file per version.
"""

import json
import time
import zipfile
from pathlib import Path as FilePath
from typing import Annotated, Literal

import httpx
from fastapi import APIRouter, HTTPException, Path, Query, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from . import instance as instances
from .instance import Selected, fetch, read
from .security import redact_text

router = APIRouter(prefix="/api")

# no dots or slashes, so a name cannot leave the pods folder
NAME = r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
SERVICE = r"^[a-z0-9-]{1,60}$"
IMPORT_LIMIT = 500 * 1024 * 1024
# loading a large state takes a while
SLOW = 600

PodName = Annotated[str, Path(pattern=NAME)]
Version = Annotated[int, Path(ge=1, le=1_000_000)]
Merge = Annotated[Literal["account-region-merge", "overwrite", "service-merge"], Query()]


class Save(BaseModel):
    pod: str = Field(pattern=NAME)
    services: list[Annotated[str, Field(pattern=SERVICE)]] = Field(default=[], max_length=200)
    # how many versions of this pod to keep, the new one included; all if not said
    keep: int | None = Field(None, ge=1, le=1000)


class Reset(BaseModel):
    service: str | None = Field(None, pattern=SERVICE)


class Remote(BaseModel):
    # no user or password: the address is shown back and kept by the instance
    url: str = Field(pattern=r"^[a-z0-9+.-]+://[^@\s]+$", max_length=500)
    protocols: list[Annotated[str, Field(pattern=r"^[a-z0-9+.-]{1,20}$")]] = Field(
        min_length=1, max_length=10
    )


def folder() -> FilePath:
    return instances.STORE.parent / "pods"


def versions(pod: str) -> list[int]:
    return sorted(int(p.stem) for p in (folder() / pod).glob("*.zip") if p.stem.isdigit())


def archive(pod: str, version: int) -> FilePath:
    path = folder() / pod / f"{version}.zip"
    if not path.is_file():
        raise HTTPException(404, f"No version {version} of pod {pod}")
    return path


def remove(pod: str, version: int) -> None:
    path = archive(pod, version)
    path.unlink()
    path.with_suffix(".json").unlink(missing_ok=True)
    if not any(path.parent.iterdir()):
        path.parent.rmdir()


def reserve(pod: str) -> tuple[int, FilePath]:
    """The next version of a pod and the file to write it to before it takes its name."""
    (folder() / pod).mkdir(parents=True, exist_ok=True)
    version = max(versions(pod), default=0) + 1
    return version, folder() / pod / f"{version}.part"


def publish(pod: str, version: int, part: FilePath, **details) -> dict:
    final = part.with_suffix(".zip")
    if not zipfile.is_zipfile(part):
        part.unlink()
        raise HTTPException(422, "Not a state export: the file is not a zip archive")
    part.replace(final)
    record = {
        "pod": pod,
        "version": version,
        "created": int(time.time()),
        "size": final.stat().st_size,
        **details,
    }
    final.with_suffix(".json").write_text(json.dumps(record))
    return record


@router.get("/pods")
def pods():
    found = []
    for path in folder().glob("*/*.zip"):
        if not path.stem.isdigit():
            continue
        try:
            record = json.loads(path.with_suffix(".json").read_text())
        except (OSError, ValueError):
            record = {"pod": path.parent.name, "version": int(path.stem)}
        found.append({**record, "size": path.stat().st_size})
    found.sort(key=lambda r: (r["pod"], -r["version"]))
    return {"pods": found, "size": sum(r["size"] for r in found), "folder": str(folder())}


@router.post("/instances/{name}/pods")
def save_pod(instance: Selected, wanted: Save):
    params = {"pod_name": wanted.pod}
    if wanted.services:
        params["services"] = ",".join(wanted.services)
    version, part = reserve(wanted.pod)
    url = instance.endpoint + "/_localstack/pods/state"
    try:
        with httpx.stream("GET", url, params=params, timeout=SLOW, trust_env=False) as response:
            if response.is_error:
                raise HTTPException(502, f"Export failed with status {response.status_code}")
            with part.open("xb") as file:
                for chunk in response.iter_bytes():
                    file.write(chunk)
            services = response.headers.get("x-localstack-pod-services", "")
        record = publish(wanted.pod, version, part, services=redact_text(services))
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Export failed: {type(e).__name__}") from e
    finally:
        part.unlink(missing_ok=True)
    if wanted.keep:
        for old in versions(wanted.pod)[: -wanted.keep]:
            remove(wanted.pod, old)
    return record


@router.post("/pods/{pod}")
async def import_pod(pod: PodName, request: Request):
    """Keep an uploaded state export as the next version of a pod."""
    version, part = reserve(pod)
    size = 0
    try:
        with part.open("xb") as file:
            async for chunk in request.stream():
                size += len(chunk)
                if size > IMPORT_LIMIT:
                    raise HTTPException(413, "The file is larger than 500 MB")
                file.write(chunk)
        return publish(pod, version, part, services="")
    finally:
        part.unlink(missing_ok=True)


@router.get("/pods/{pod}/{version}/download")
def download_pod(request: Request, pod: PodName, version: Version):
    if request.headers.get("sec-fetch-site") == "cross-site":
        raise HTTPException(403, "Cross-site request rejected")
    return FileResponse(
        archive(pod, version),
        media_type="application/zip",
        filename=f"{pod}-{version}.zip",
        headers={"x-content-type-options": "nosniff"},
    )


@router.delete("/pods/{pod}/{version}", status_code=204)
def delete_pod(pod: PodName, version: Version):
    remove(pod, version)


@router.post("/instances/{name}/pods/{pod}/{version}/load")
def load_pod(
    instance: Selected,
    pod: PodName,
    version: Version,
    merge: Merge = "account-region-merge",
):
    fetch(
        instance,
        "/_localstack/pods",
        method="POST",
        params={"merge": merge},
        content=archive(pod, version).read_bytes(),
        headers={"content-type": "application/octet-stream"},
        timeout=SLOW,
    )
    return {"ok": True}


@router.post("/instances/{name}/state/reset")
def reset(instance: Selected, wanted: Reset):
    path = f"/_localstack/state/{wanted.service}/reset" if wanted.service else None
    fetch(instance, path or "/_localstack/state/reset", method="POST", timeout=SLOW)
    return {"ok": True}


@router.post("/instances/{name}/state/{action}")
def save_or_load(instance: Selected, action: Literal["save", "load"]):
    """Write state to the instance's own volume, or read it back. Answers one result per service."""
    path = f"/_localstack/state/{action}"
    response = fetch(instance, path, method="POST", optional=True, timeout=SLOW)
    if response is None:
        detail = f"The instance does not offer state {action} (404). It may be running without persistence."
        raise HTTPException(502, detail)
    results = []
    for line in response.text.splitlines():
        try:
            entry = json.loads(line)
            results.append(
                {k: redact_text(str(entry[k])) for k in ("service", "status", "message") if k in entry}
            )
        except (ValueError, TypeError):
            continue
    return results


@router.get("/instances/{name}/state/metamodel")
def metamodel(instance: Selected):
    return read(instance, "/_localstack/pods/state/metamodel", timeout=120)


@router.get("/instances/{name}/remotes")
def remotes(instance: Selected):
    found = read(instance, "/_localstack/pods/remotes").get("remotes", [])
    # a remote's token stays on the server
    return [{k: r.get(k) for k in ("name", "protocols", "url")} for r in found]


@router.post("/instances/{name}/remotes/{remote}")
def add_remote(instance: Selected, remote: PodName, wanted: Remote):
    body = {"protocols": wanted.protocols, "remote_url": wanted.url}
    fetch(instance, f"/_localstack/pods/remotes/{remote}", method="POST", body=body)
    return {"ok": True}


@router.delete("/instances/{name}/remotes/{remote}", status_code=204)
def delete_remote(instance: Selected, remote: PodName):
    fetch(instance, f"/_localstack/pods/remotes/{remote}", method="DELETE")
