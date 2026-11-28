"""Chaos engineering: fault rules and added latency, which the instance applies to AWS calls."""

from typing import Annotated

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field

from .instance import Selected, fetch, read

router = APIRouter(prefix="/api/instances/{name}/chaos")

FAULTS = "/_localstack/chaos/faults"
EFFECTS = "/_localstack/chaos/effects"


class Error(BaseModel):
    model_config = ConfigDict(extra="forbid")

    statusCode: int | None = Field(None, ge=400, le=599)
    code: str | None = Field(None, pattern=r"^[a-zA-Z0-9]+$", max_length=100)


class Rule(BaseModel):
    """The conditions of a fault and its effect. A condition left out matches everything."""

    model_config = ConfigDict(extra="forbid")

    region: str | None = Field(None, pattern=r"^[a-zA-Z0-9-]+$", max_length=40)
    service: str | None = Field(None, pattern=r"^[a-zA-Z0-9_-]+$", max_length=60)
    operation: str | None = Field(None, pattern=r"^[a-zA-Z]+$", max_length=100)
    probability: float | None = Field(None, ge=0, le=1)
    description: str | None = Field(None, max_length=8192)
    error: Error | None = None


Rules = Annotated[list[Rule], Field(min_length=1, max_length=100)]


class Latency(BaseModel):
    latency: int = Field(ge=0, le=60_000)


def body(rules: list[Rule]) -> list[dict]:
    return [rule.model_dump(exclude_none=True) for rule in rules]


@router.get("")
def current(instance: Selected):
    return {
        "faults": read(instance, FAULTS),
        "latency": read(instance, EFFECTS)["latency"],
    }


@router.post("/faults")
def add_faults(instance: Selected, rules: Rules):
    fetch(instance, FAULTS, method="PATCH", body=body(rules))
    return {"ok": True}


@router.post("/faults/remove")
def remove_faults(instance: Selected, rules: Rules):
    fetch(instance, FAULTS, method="DELETE", body=body(rules))
    return {"ok": True}


@router.delete("/faults")
def clear_faults(instance: Selected):
    # setting rules replaces all of them
    fetch(instance, FAULTS, method="POST", body=[])
    return {"ok": True}


@router.put("/latency")
def set_latency(instance: Selected, latency: Latency):
    fetch(instance, EFFECTS, method="POST", body=latency.model_dump())
    return latency
