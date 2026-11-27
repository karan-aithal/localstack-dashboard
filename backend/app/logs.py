"""Live container logs as server-sent events."""

import asyncio
import re
from typing import Annotated

from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse

from .instance import Selected
from .security import redact_text

router = APIRouter(prefix="/api/instances")

ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
HEARTBEAT_SECONDS = 15


async def follow(container: str, tail: int):
    process = await asyncio.create_subprocess_exec(
        "docker", "logs", "--follow", "--tail", str(tail), container,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        # ponytail: a single log line above 16 MiB ends the stream; chunked reads if that happens
        limit=16 * 1024 * 1024,
    )  # fmt: skip
    try:
        while True:
            try:
                line = await asyncio.wait_for(process.stdout.readline(), HEARTBEAT_SECONDS)
            except TimeoutError:
                # a write is how a disconnected client gets noticed while the log is quiet
                yield ": ping\n\n"
                continue
            if not line:
                break
            text = ANSI.sub("", line.decode(errors="replace")).rstrip().replace("\r", "")
            yield f"data: {redact_text(text)}\n\n"
        yield "event: end\ndata:\n\n"
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()


@router.get("/{name}/logs")
def logs(instance: Selected, tail: Annotated[int, Query(ge=0, le=5000)] = 500):
    return StreamingResponse(follow(instance.container, tail), media_type="text/event-stream")
