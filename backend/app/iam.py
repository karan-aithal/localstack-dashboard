"""IAM enforcement, permission checks and the policies the instance derives from calls."""

import asyncio
from typing import Literal

import httpx
from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .instance import Instance, Selected, fetch, read
from .logs import HEARTBEAT_SECONDS
from .security import redact_strings, redact_text

router = APIRouter(prefix="/api/instances/{name}/iam")


class Config(BaseModel):
    state: Literal["DISABLED", "ENGINE_ONLY", "SOFT_MODE", "ENFORCED"]


class Permission(BaseModel):
    action: str = Field(pattern=r"^[A-Za-z0-9-]+:[A-Za-z0-9*?]+$", max_length=200)
    resource: str = Field(min_length=1, max_length=2048)


class Check(BaseModel):
    access_key_id: str = Field(pattern=r"^[A-Za-z0-9_]{1,128}$")
    region_name: str = Field(pattern=r"^[a-z0-9-]{1,40}$")
    # plural, unlike the instance's own API description
    required_permissions: list[Permission] = Field(min_length=1, max_length=20)


@router.get("/config")
def config(instance: Selected):
    return read(instance, "/_aws/iam/config")


@router.put("/config")
def set_config(instance: Selected, wanted: Config):
    fetch(instance, "/_aws/iam/config", method="POST", body=wanted.model_dump())
    return wanted


@router.post("/check")
def check(instance: Selected, wanted: Check):
    path = "/_aws/iam/check-actions-allowed"
    response = fetch(instance, path, method="POST", body=wanted.model_dump())
    return redact_strings(response.json())


@router.get("/summary")
def summary(instance: Selected):
    return read(instance, "/_aws/iam/policies/summary")


async def follow(instance: Instance):
    """The instance's policy stream, a line of JSON per call it serves, as server-sent events."""
    queue: asyncio.Queue[str | None] = asyncio.Queue(maxsize=1000)

    async def collect():
        try:
            async with httpx.AsyncClient(trust_env=False) as client:
                timeout = httpx.Timeout(15, read=None)
                url = instance.endpoint + "/_aws/iam/policies/stream"
                async with client.stream("GET", url, timeout=timeout) as response:
                    response.raise_for_status()
                    async for line in response.aiter_lines():
                        if line.strip():
                            await queue.put(redact_text(line.strip()))
        except httpx.HTTPError as e:
            await queue.put(f'{{"error": "{type(e).__name__}"}}')
        await queue.put(None)

    task = asyncio.create_task(collect())
    try:
        # something to send at once, so that the browser sees the stream open
        yield ": open\n\n"
        while True:
            try:
                line = await asyncio.wait_for(queue.get(), HEARTBEAT_SECONDS)
            except TimeoutError:
                # a write is how a disconnected client gets noticed while nothing happens
                yield ": ping\n\n"
                continue
            if line is None:
                break
            yield f"data: {line}\n\n"
        yield "event: end\ndata:\n\n"
    finally:
        task.cancel()


@router.get("/stream")
def stream(instance: Selected):
    return StreamingResponse(follow(instance), media_type="text/event-stream")
