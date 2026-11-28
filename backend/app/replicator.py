"""
Replicator: the instance copies a resource from a real AWS account into itself.

This is the one feature that reads outside the instance. The source credentials arrive with each
job, are handed to the instance and are neither stored nor returned by the dashboard.
"""

from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field, SecretStr, model_validator

from .instance import Selected, call, fetch, read
from .security import redact_strings

router = APIRouter(prefix="/api/instances/{name}/replicator")

JOBS = "/_localstack/replicator/jobs"


class Source(BaseModel):
    # no endpoint address: credentials go to AWS only, never to an address typed into a form
    model_config = ConfigDict(extra="forbid")

    aws_access_key_id: str = Field(pattern=r"^[A-Za-z0-9]{1,128}$")
    aws_secret_access_key: SecretStr = Field(min_length=1, max_length=200)
    aws_session_token: SecretStr | None = Field(None, max_length=4096)
    region_name: str = Field(pattern=r"^[a-z0-9-]{1,40}$")


class Resource(BaseModel):
    model_config = ConfigDict(extra="forbid")

    resource_arn: str | None = Field(None, pattern=r"^arn:[\w-]+:[^\s]{1,2000}$")
    resource_type: str | None = Field(None, pattern=r"^AWS::\w+::\w+$")
    resource_identifier: str | None = Field(None, min_length=1, max_length=2000)

    @model_validator(mode="after")
    def one_way_to_name_it(self):
        pair = self.resource_type is not None and self.resource_identifier is not None
        half = (self.resource_type is None) != (self.resource_identifier is None)
        if half or pair == (self.resource_arn is not None):
            raise ValueError("Give either the ARN, or both the type and the identifier")
        return self


class Job(BaseModel):
    model_config = ConfigDict(extra="forbid")

    replication_type: Literal["MOCK", "SINGLE_RESOURCE"]
    source_aws_config: Source
    replication_job_config: Resource | None = None

    @model_validator(mode="after")
    def resource_needed(self):
        if self.replication_type == "SINGLE_RESOURCE" and not self.replication_job_config:
            raise ValueError("Name the resource to copy")
        return self


@router.get("/jobs")
def jobs(instance: Selected):
    # also hides secret looking fields, should a job describe its configuration
    return call(instance, JOBS) or []


@router.get("/resources")
def resources(instance: Selected):
    return read(instance, "/_localstack/replicator/resources", timeout=60)


@router.post("/jobs")
def submit(instance: Selected, job: Job):
    source = job.source_aws_config
    secrets = [source.aws_secret_access_key.get_secret_value()]
    config = source.model_dump(exclude_none=True)
    config["aws_secret_access_key"] = secrets[0]
    if source.aws_session_token:
        secrets.append(source.aws_session_token.get_secret_value())
        config["aws_session_token"] = secrets[1]
    body = {"replication_type": job.replication_type, "source_aws_config": config}
    if job.replication_job_config:
        body["replication_job_config"] = job.replication_job_config.model_dump(exclude_none=True)

    def hide(text: str) -> str:
        for secret in filter(None, secrets):
            text = text.replace(secret, "<redacted>")
        return text

    try:
        answer = redact_strings(fetch(instance, JOBS, method="POST", body=body).json())
    except HTTPException as e:
        raise HTTPException(e.status_code, hide(str(e.detail))) from None
    # the answer describes the job; make sure it does not repeat the credentials
    entries = answer if isinstance(answer, list) else [answer]
    return [
        {k: hide(str(v)) for k, v in entry.items() if k in ("job_id", "state", "type")}
        for entry in entries
        if isinstance(entry, dict)
    ]
