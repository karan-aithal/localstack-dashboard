"""App Inspector: the operations the instance traced, with their payloads and IAM events."""

from typing import Annotated, Literal

from fastapi import APIRouter, Path
from pydantic import BaseModel

from .instance import Selected, read

router = APIRouter(prefix="/api/instances/{name}/appinspector")

BASE = "/_localstack/appinspector"

TraceId = Annotated[str, Path(pattern=r"^[0-9a-f]{32}$")]
SpanId = Annotated[str, Path(pattern=r"^[0-9a-f]{16}$")]


class Status(BaseModel):
    status: Literal["ENABLED", "DISABLED"]


@router.get("/status")
def status(instance: Selected):
    return read(instance, f"{BASE}/status")


@router.put("/status")
def set_status(instance: Selected, wanted: Status):
    return read(instance, f"{BASE}/status", method="PUT", body=wanted.model_dump())


@router.get("/spans")
def spans(instance: Selected):
    """Traced operations of all traces. The license limits how many the instance keeps."""
    # ponytail: first page only; follow the pagination cursor if a plan stores more than this
    return read(instance, f"{BASE}/v1/traces/*/spans", params={"limit": 500})


@router.get("/spans/{trace_id}/{span_id}/iam")
def iam_events(instance: Selected, trace_id: TraceId, span_id: SpanId):
    return read(instance, f"{BASE}/v1/traces/{trace_id}/spans/{span_id}/events/iam")


@router.delete("/traces")
def clear(instance: Selected):
    return read(instance, f"{BASE}/v1/traces", method="DELETE")
