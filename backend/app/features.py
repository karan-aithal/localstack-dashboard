"""What the service pages need beyond plain AWS operations: LocalStack extras and downloads."""

import base64
import io
import zipfile
from typing import Annotated
from urllib.parse import quote

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import APIRouter, Header, HTTPException, Query
from fastapi.responses import StreamingResponse

from .aws import client
from .instance import Selected, fetch, read

router = APIRouter(prefix="/api/instances/{name}")

Region = Annotated[str, Query(pattern=r"^[a-z0-9-]{1,30}$")]
Account = Annotated[str, Query(pattern=r"^\d{12}$")]
SubscriptionArn = Annotated[
    str, Query(pattern=r"^arn:[a-z-]+:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_.-]+:[0-9a-f-]+$")
]

_PROVIDER = "localstack.aws.provider/"


@router.get("/licensed")
def licensed(instance: Selected):
    """Services the license covers, or null if the instance does not say."""
    info = read(instance, "/_localstack/licenseinfo", optional=True) or {}
    plugins = info.get("available_plugins")
    if plugins is None:
        return {"services": None}
    providers = [p.removeprefix(_PROVIDER) for p in plugins if p.startswith(_PROVIDER)]
    # a covered "legacy" provider is not the one in use: MSK has one, yet its calls are refused
    names = {p.split(":")[0] for p in providers if not p.endswith(":legacy")}
    return {"services": sorted(names)}


def _list(value) -> list:
    """The XML style response holds a single entry as an object instead of a list."""
    if not value:
        return []
    return value if isinstance(value, list) else [value]


@router.get("/sqs/messages")
def sqs_messages(instance: Selected, queue_url: Annotated[str, Query(max_length=500)]):
    """All messages of a queue, without receiving them."""
    data = read(
        instance,
        "/_aws/sqs/messages",
        params={"QueueUrl": queue_url},
        headers={"accept": "application/json"},
    )
    result = (data.get("ReceiveMessageResponse") or {}).get("ReceiveMessageResult") or {}
    return [
        {
            "id": message.get("MessageId"),
            "body": message.get("Body"),
            "attributes": {a["Name"]: a.get("Value") for a in _list(message.get("Attribute"))},
            "messageAttributes": {
                a["Name"]: a.get("Value") for a in _list(message.get("MessageAttribute"))
            },
        }
        for message in _list(result.get("Message"))
    ]


@router.get("/sns/messages")
def sns_messages(instance: Selected, region: Region, account: Account):
    """SMS and platform endpoint messages that LocalStack kept instead of delivering."""
    scope = {"region": region, "accountId": account}
    # these endpoints only exist once the SNS service has been used
    sms = read(instance, "/_aws/sns/sms-messages", optional=True, params=scope) or {}
    platform = (
        read(instance, "/_aws/sns/platform-endpoint-messages", optional=True, params=scope) or {}
    )
    return {
        "sms": sms.get("sms_messages", {}),
        "platform": platform.get("platform_endpoint_messages", {}),
    }


@router.get("/sns/subscription-token")
def sns_token(instance: Selected, arn: SubscriptionArn):
    data = read(instance, f"/_aws/sns/subscription-tokens/{arn}", optional=True)
    return {"token": (data or {}).get("subscription_token")}


MessageId = Annotated[str, Query(pattern=r"^[A-Za-z0-9-]{1,200}$")]
RuleArn = Annotated[
    str, Query(pattern=r"^arn:[a-z-]+:events:[a-z0-9-]+:\d{12}:rule/[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)?$")
]


@router.get("/ses/messages")
def ses_messages(instance: Selected):
    """Mail that SES accepted. LocalStack keeps it instead of delivering it."""
    data = read(instance, "/_aws/ses", optional=True) or {}
    return data.get("messages", [])


@router.delete("/ses/messages", status_code=204)
def delete_ses_message(instance: Selected, id: MessageId | None = None):
    """Delete one stored message, or all of them if no id is given."""
    fetch(instance, "/_aws/ses", method="DELETE", params={"id": id} if id else None)


@router.post("/events/trigger", status_code=204)
def trigger_rule(instance: Selected, arn: RuleArn):
    """Run the targets of a rule now, without waiting for its schedule."""
    # "." and ".." are valid in the pattern but would change the path
    if any(part in (".", "..") for part in arn.split("/")):
        raise HTTPException(422, "Invalid rule ARN")
    fetch(instance, f"/_aws/events/rules/{arn}/trigger")


@router.get("/lambda/runtimes")
def lambda_runtimes(instance: Selected):
    data = read(instance, "/_aws/lambda/runtimes", optional=True) or {}
    return sorted(data.get("Runtimes", []))


# a web function is a server of its own: it has to listen where Lambda says
HELLO_WEB = """const http = require("http");
const [host, port] = (process.env.AWS_LAMBDA_HTTP_ENDPOINT || "localhost:3000").split(":");

http
  .createServer((request, response) => {
    response.setHeader("content-type", "text/plain");
    response.end("Hello from Lambda Web Functions!\\n");
  })
  .listen(Number(port), host);
"""


@router.get("/lambda/hello-web")
def hello_web():
    """Deployment package of the Hello World web function."""
    entry = zipfile.ZipInfo("index.js")
    entry.external_attr = 0o644 << 16  # the runtime has to be able to read it
    package = io.BytesIO()
    with zipfile.ZipFile(package, "w") as archive:
        archive.writestr(entry, HELLO_WEB)
    return {"code": HELLO_WEB, "zip": base64.b64encode(package.getvalue()).decode()}


@router.post("/dynamodb/expired")
def delete_expired_items(instance: Selected):
    """Delete items whose time to live has passed, in all tables."""
    return read(instance, "/_aws/dynamodb/expired", method="DELETE")


@router.get("/s3/download")
def download(
    instance: Selected,
    bucket: Annotated[str, Query(max_length=255)],
    key: Annotated[str, Query(max_length=1024)],
    region: Region = "us-east-1",
    account: Account = "000000000000",
    sec_fetch_site: Annotated[str | None, Header()] = None,
):
    if sec_fetch_site == "cross-site":
        raise HTTPException(403, "Cross-site request rejected")
    try:
        s3 = client(instance.endpoint, "s3", region, account)
        body = s3.get_object(Bucket=bucket, Key=key)["Body"]
    except ClientError as e:
        raise HTTPException(404, e.response.get("Error", {}).get("Code", "Not found")) from e
    except BotoCoreError as e:
        raise HTTPException(502, type(e).__name__) from e
    filename = quote(key.rstrip("/").rsplit("/", 1)[-1] or "download", safe="")
    # always a download: an object must never be rendered on the dashboard's own origin
    return StreamingResponse(
        body.iter_chunks(64 * 1024),
        media_type="application/octet-stream",
        headers={
            "content-disposition": f"attachment; filename*=UTF-8''{filename}",
            "x-content-type-options": "nosniff",
        },
    )
