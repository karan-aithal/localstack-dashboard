import base64
import io
import json
import time
import uuid
import zipfile
from pathlib import Path

import pytest
from app import aws, features
from conftest import ORIGIN, live

REGISTRY = json.loads((Path(__file__).parents[2] / "web/src/registry.json").read_text())
BASE = "/api/instances/default"


def nodes(items, service, trail):
    for node in items:
        used = node.get("service", service)
        name = f"{trail}/{node['id']}"
        yield name, used, node
        children = node.get("views", []) + node.get("sections", [])
        yield from nodes(children, used, name)


ALL = [n for s in REGISTRY for n in nodes(s["tabs"], s["service"], s["id"])]


def check_call(service, call, complete):
    """The operation exists, and the parameters are ones it takes (all required ones if asked)."""
    shape = aws.operation_model(service, call["op"]).input_shape
    given = set(call.get("params", {}))
    members = set(shape.members) if shape else set()
    assert given <= members, f"{call['op']} has no {given - members}"
    if complete and shape:
        missing = set(shape.required_members) - given
        assert not missing, f"{call['op']} needs {missing}"


def member(shape, path):
    """The shape at a dotted path, looking into the entries of lists on the way."""
    for part in path.split("."):
        while shape.type_name == "list":
            shape = shape.member
        assert part in shape.members, f"{shape.name} has no {part}"
        shape = shape.members[part]
    return shape


@pytest.mark.parametrize("name,service,node", ALL, ids=[n[0] for n in ALL])
def test_registry_matches_the_api(name, service, node):
    kinds = [k for k in ("list", "show", "form", "custom", "link", "sections") if k in node]
    assert len(kinds) == 1
    if "show" in node:
        check_call(service, node["show"], complete=True)
    if "form" in node:
        check_call(service, node["form"], complete=False)
        if source := node["form"].get("from"):
            check_call(service, source, complete=True)
            if field := source.get("as"):
                check_call(service, {"op": node["form"]["op"], "params": {field: ""}}, False)
    if "create" in node:
        check_call(service, node["create"], complete=False)
    for call in [node.get("remove"), *node.get("actions", [])]:
        if call:
            check_call(service, call, complete=True)
    if listing := node.get("list"):
        check_call(service, listing, complete=True)
        shape = aws.operation_model(service, listing["op"]).output_shape
        item = member(shape, listing["items"])
        assert item.type_name == "list"
        item = item.member
        keys = listing.get("key", [])
        wanted = {*([keys] if isinstance(keys, str) else keys), *listing.get("columns", [])}
        if item.type_name == "structure":
            assert keys, "a list of objects needs a key"
            for path in wanted:
                member(item, path)
        else:
            assert not wanted


def test_licensed_service_names(client, monkeypatch):
    plugins = [
        "localstack.aws.provider/s3:default",
        "localstack.aws.provider/lambda-web:default",
        "localstack.platform.plugin/extensions",
    ]
    monkeypatch.setattr(features, "read", lambda *a, **kw: {"available_plugins": plugins})
    assert client.get(f"{BASE}/licensed").json() == {"services": ["lambda-web", "s3"]}
    monkeypatch.setattr(features, "read", lambda *a, **kw: None)
    assert client.get(f"{BASE}/licensed").json() == {"services": None}


@pytest.mark.parametrize(
    "url",
    [
        "/sns/subscription-token?arn=../../_localstack/health",
        "/sns/subscription-token?arn=arn:aws:sns:us-east-1:000000000000:t:../x",
        "/sns/messages?region=a/b&account=000000000000",
        "/s3/download?bucket=b&key=k&account=1",
    ],
)
def test_unsafe_input_rejected(client, url):
    assert client.get(BASE + url).status_code == 422


def test_writes_and_cross_site_downloads_rejected(client):
    assert client.post(f"{BASE}/dynamodb/expired").status_code == 403
    headers = {"sec-fetch-site": "cross-site"}
    url = f"{BASE}/s3/download?bucket=b&key=k"
    assert client.get(url, headers=headers).status_code == 403


class Runner:
    """Run AWS operations through the dashboard API, and clean up afterwards."""

    def __init__(self, client):
        self.client = client
        self.cleanups = []

    def __call__(self, service, operation, **params):
        url = f"{BASE}/aws/{service}/{operation}"
        response = self.client.post(url, json={"params": params}, headers=ORIGIN)
        assert response.status_code == 200, response.json()
        return response.json()["result"]

    def later(self, service, operation, **params):
        self.cleanups.append((service, operation, params))


@pytest.fixture
def run(client):
    runner = Runner(client)
    yield runner
    for service, operation, params in reversed(runner.cleanups):
        runner(service, operation, **params)


@pytest.fixture
def name():
    return f"dashboard-test-{uuid.uuid4().hex[:10]}"


def zipped(filename: str, code: str) -> str:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        info = zipfile.ZipInfo(filename)
        info.external_attr = 0o644 << 16
        archive.writestr(info, code)
    return base64.b64encode(buffer.getvalue()).decode()


@live
def test_live_licensed(client):
    services = client.get(f"{BASE}/licensed").json()["services"]
    used = {service for _, service, _ in ALL}
    assert used <= set(services)


@live
def test_live_s3(client, run, name):
    run("s3", "CreateBucket", Bucket=name)
    run.later("s3", "DeleteBucket", Bucket=name)
    key = "folder/ünicode <name>.html"
    body = base64.b64encode(b"<script>alert(1)</script>").decode()
    run("s3", "PutObject", Bucket=name, Key=key, Body=body)
    run.later("s3", "DeleteObject", Bucket=name, Key=key)
    listed = run("s3", "ListObjectsV2", Bucket=name, Delimiter="/")
    assert listed["CommonPrefixes"] == [{"Prefix": "folder/"}]

    response = client.get(f"{BASE}/s3/download", params={"bucket": name, "key": key})
    assert response.content == b"<script>alert(1)</script>"
    assert response.headers["content-type"] == "application/octet-stream"
    assert response.headers["content-disposition"].startswith("attachment;")
    assert response.headers["x-content-type-options"] == "nosniff"
    missing = client.get(f"{BASE}/s3/download", params={"bucket": name, "key": "nope"})
    assert missing.status_code == 404


@live
def test_live_sqs_and_sns(client, run, name):
    queue = run("sqs", "CreateQueue", QueueName=name)["QueueUrl"]
    run.later("sqs", "DeleteQueue", QueueUrl=queue)

    def peek():
        return client.get(f"{BASE}/sqs/messages", params={"queue_url": queue}).json()

    assert peek() == []
    attribute = {"colour": {"DataType": "String", "StringValue": "red"}}
    run("sqs", "SendMessage", QueueUrl=queue, MessageBody="one", MessageAttributes=attribute)
    assert [m["body"] for m in peek()] == ["one"]
    assert peek()[0]["messageAttributes"]["colour"]["StringValue"] == "red"
    run("sqs", "SendMessage", QueueUrl=queue, MessageBody="two")
    # peeking must not consume
    assert sorted(m["body"] for m in peek()) == ["one", "two"]

    topic = run("sns", "CreateTopic", Name=name)["TopicArn"]
    run.later("sns", "DeleteTopic", TopicArn=topic)
    number = "+15550100123"
    run("sns", "Subscribe", TopicArn=topic, Protocol="sms", Endpoint=number)
    email = run(
        "sns",
        "Subscribe",
        TopicArn=topic,
        Protocol="email",
        Endpoint="test@example.com",
        ReturnSubscriptionArn=True,
    )["SubscriptionArn"]
    run("sns", "Publish", TopicArn=topic, Message=name)
    scope = {"region": "us-east-1", "account": "000000000000"}
    sent = client.get(f"{BASE}/sns/messages", params=scope).json()
    assert name in [m["Message"] for m in sent["sms"][number]]
    token = client.get(f"{BASE}/sns/subscription-token", params={"arn": email}).json()["token"]
    assert token and token != "<redacted>"
    # the email subscription left messages in the SES mailbox
    for mail in client.get(f"{BASE}/ses/messages").json():
        if name in json.dumps(mail):
            client.delete(f"{BASE}/ses/messages", params={"id": mail["Id"]}, headers=ORIGIN)
    # the SMS delivery writes a log group, a moment after the publish: wait for it and remove it
    group = {"params": {"logGroupName": f"sns/us-east-1/000000000000/{name}"}}
    for _ in range(50):
        response = client.post(f"{BASE}/aws/logs/DeleteLogGroup", json=group, headers=ORIGIN)
        if response.status_code == 200:
            break
        time.sleep(0.1)


@live
def test_live_dynamodb(client, run, name):
    run(
        "dynamodb",
        "CreateTable",
        TableName=name,
        KeySchema=[{"AttributeName": "id", "KeyType": "HASH"}],
        AttributeDefinitions=[{"AttributeName": "id", "AttributeType": "S"}],
        BillingMode="PAY_PER_REQUEST",
    )
    run.later("dynamodb", "DeleteTable", TableName=name)
    assert name in run("dynamodb", "ListTables")["TableNames"]
    item = {"id": {"S": "a"}, "blob": {"B": "/wA="}, "expires": {"N": "1"}}
    run("dynamodb", "PutItem", TableName=name, Item=item)
    assert run("dynamodb", "Scan", TableName=name)["Items"] == [item]
    ttl = {"Enabled": True, "AttributeName": "expires"}
    run("dynamodb", "UpdateTimeToLive", TableName=name, TimeToLiveSpecification=ttl)
    response = client.post(f"{BASE}/dynamodb/expired", headers=ORIGIN)
    assert response.json()["ExpiredItems"] >= 1
    assert run("dynamodb", "Scan", TableName=name)["Items"] == []


@live
def test_live_cloudwatch(run, name):
    run("logs", "CreateLogGroup", logGroupName=name)
    run.later("logs", "DeleteLogGroup", logGroupName=name)
    run("logs", "CreateLogStream", logGroupName=name, logStreamName="s")
    groups = run("logs", "DescribeLogGroups", logGroupNamePrefix=name)["logGroups"]
    assert [g["logGroupName"] for g in groups] == [name]

    metric = [{"MetricName": "Hits", "Value": 3}]
    run("cloudwatch", "PutMetricData", Namespace=name, MetricData=metric)
    assert run("cloudwatch", "ListMetrics", Namespace=name)["Metrics"]
    run(
        "cloudwatch",
        "PutMetricAlarm",
        AlarmName=name,
        Namespace=name,
        MetricName="Hits",
        Statistic="Sum",
        Period=60,
        EvaluationPeriods=1,
        Threshold=1,
        ComparisonOperator="GreaterThanThreshold",
    )
    run.later("cloudwatch", "DeleteAlarms", AlarmNames=[name])
    assert run("cloudwatch", "DescribeAlarms", AlarmNames=[name])["MetricAlarms"]


@live
def test_live_lambda(client, run, name):
    runtimes = client.get(f"{BASE}/lambda/runtimes").json()
    assert "python3.13" in runtimes
    code = "def handler(event, context):\n    print('seen', event)\n    return event\n"
    run(
        "lambda",
        "CreateFunction",
        FunctionName=name,
        Runtime="python3.13",
        Handler="app.handler",
        Role="arn:aws:iam::000000000000:role/lambda-role",
        Code={"ZipFile": zipped("app.py", code)},
    )
    # the log group appears on first invocation
    run.later("logs", "DeleteLogGroup", logGroupName=f"/aws/lambda/{name}")
    run.later("lambda", "DeleteFunction", FunctionName=name)
    waiter = aws.client(
        "http://localhost:4566", "lambda", "us-east-1", "000000000000"
    ).get_waiter("function_active_v2")
    waiter.wait(FunctionName=name)
    payload = base64.b64encode(b'{"n": 1}').decode()
    result = run("lambda", "Invoke", FunctionName=name, Payload=payload, LogType="Tail")
    assert json.loads(result["Payload"]["text"]) == {"n": 1}
    assert b"seen" in base64.b64decode(result["LogResult"])

    layer = run(
        "lambda",
        "PublishLayerVersion",
        LayerName=name,
        Content={"ZipFile": zipped("python/x.py", "X = 1\n")},
    )
    run.later("lambda", "DeleteLayerVersion", LayerName=name, VersionNumber=layer["Version"])
    assert run("lambda", "ListLayerVersions", LayerName=name)["LayerVersions"]


@pytest.mark.parametrize(
    "method,url",
    [
        ("delete", "/ses/messages?id=../x"),
        ("post", "/events/trigger?arn=../../health"),
        ("post", "/events/trigger?arn=arn:aws:events:us-east-1:000000000000:rule/.."),
    ],
)
def test_unsafe_changes_rejected(client, method, url):
    assert getattr(client, method)(BASE + url, headers=ORIGIN).status_code == 422
    assert getattr(client, method)(BASE + url).status_code == 403


def trust(service: str) -> str:
    statement = {"Effect": "Allow", "Principal": {"Service": service}, "Action": "sts:AssumeRole"}
    return json.dumps({"Version": "2012-10-17", "Statement": [statement]})


POLICY = json.dumps(
    {"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Action": "s3:*", "Resource": "*"}]}
)
ROLE = "arn:aws:iam::000000000000:role/r"
WAIT = {"Version": "1.0", "StartAt": "a", "States": {"a": {"Type": "Pass", "End": True}}}

# service, create operation, its parameters, delete operation and parameters.
# "{n}" is the resource name; "{name}" in the delete parameters is taken from the create result.
# OpenSearch, Redshift and Transcribe are listed only: creating them downloads large engines.
LIFECYCLES = [
    ("apigateway", "CreateRestApi", {"name": "{n}"}, "DeleteRestApi", {"restApiId": "{id}"},
     "GetRestApi", "GetRestApis"),
    ("stepfunctions", "CreateStateMachine",
     {"name": "{n}", "definition": json.dumps(WAIT), "roleArn": ROLE},
     "DeleteStateMachine", {"stateMachineArn": "{stateMachineArn}"},
     "DescribeStateMachine", "ListStateMachines"),
    ("events", "CreateEventBus", {"Name": "{n}"}, "DeleteEventBus", {"Name": "{n}"},
     "DescribeEventBus", "ListEventBuses"),
    ("ssm", "PutParameter", {"Name": "{n}", "Value": "v", "Type": "SecureString"},
     "DeleteParameter", {"Name": "{n}"}, "GetParameter", "DescribeParameters"),
    ("ses", "VerifyEmailIdentity", {"EmailAddress": "{n}@example.com"},
     "DeleteIdentity", {"Identity": "{n}@example.com"}, None, "ListIdentities"),
    ("acm", "RequestCertificate", {"DomainName": "{n}.example.com"},
     "DeleteCertificate", {"CertificateArn": "{CertificateArn}"},
     "DescribeCertificate", "ListCertificates"),
    ("iam", "CreateRole", {"RoleName": "{n}", "AssumeRolePolicyDocument": trust("ec2.amazonaws.com")},
     "DeleteRole", {"RoleName": "{n}"}, "GetRole", "ListRoles"),
    ("iam", "CreatePolicy", {"PolicyName": "{n}", "PolicyDocument": POLICY},
     "DeletePolicy", {"PolicyArn": "{Policy.Arn}"}, "GetPolicy", "ListPolicies"),
    ("secretsmanager", "CreateSecret", {"Name": "{n}", "SecretString": "s"},
     "DeleteSecret", {"SecretId": "{n}", "ForceDeleteWithoutRecovery": True},
     "GetSecretValue", "ListSecrets"),
    ("kinesis", "CreateStream", {"StreamName": "{n}", "ShardCount": 1},
     "DeleteStream", {"StreamName": "{n}"}, "DescribeStreamSummary", "ListStreams"),
    ("firehose", "CreateDeliveryStream", {"DeliveryStreamName": "{n}"},
     "DeleteDeliveryStream", {"DeliveryStreamName": "{n}"},
     "DescribeDeliveryStream", "ListDeliveryStreams"),
]


def fill(value, name, result):
    """Replace "{n}" with the name and "{A.B}" with that part of the create result."""
    if isinstance(value, dict):
        return {k: fill(v, name, result) for k, v in value.items()}
    if not isinstance(value, str):
        return value
    if value.startswith("{") and value.endswith("}") and value != "{n}" and '"' not in value:
        found = result
        for part in value[1:-1].split("."):
            found = found[part]
        return found
    return value.replace("{n}", name)


@live
@pytest.mark.parametrize("case", LIFECYCLES, ids=[f"{c[0]}-{c[1]}" for c in LIFECYCLES])
def test_live_lifecycle(run, name, case):
    service, create, params, delete, delete_params, view, listing = case
    result = run(service, create, **fill(params, name, {}))
    removal = fill(delete_params, name, result)
    try:
        listed = run(service, listing, **({"Scope": "Local"} if listing == "ListPolicies" else {}))
        assert name in json.dumps(listed) or str(result.get("id")) in json.dumps(listed)
        if view:
            run(service, view, **removal if delete != "DeleteSecret" else {"SecretId": name})
    finally:
        run(service, delete, **removal)


@live
@pytest.mark.parametrize(
    "service,operation",
    [
        ("opensearch", "ListDomainNames"),
        ("redshift", "DescribeClusters"),
        ("transcribe", "ListTranscriptionJobs"),
        ("route53resolver", "ListResolverEndpoints"),
    ],
)
def test_live_list_only(run, service, operation):
    run(service, operation)


@live
def test_live_kms(run):
    key = run("kms", "CreateKey", Description="dashboard-test")["KeyMetadata"]["KeyId"]
    run.later("kms", "ScheduleKeyDeletion", KeyId=key, PendingWindowInDays=7)
    assert key in [k["KeyId"] for k in run("kms", "ListKeys")["Keys"]]
    run("kms", "DisableKey", KeyId=key)
    assert run("kms", "DescribeKey", KeyId=key)["KeyMetadata"]["KeyState"] == "Disabled"
    run("kms", "EnableKey", KeyId=key)


@live
def test_live_ec2(run, name):
    image = run("ec2", "DescribeImages")["Images"][0]["ImageId"]
    launched = run("ec2", "RunInstances", ImageId=image, MinCount=1, MaxCount=1)
    instance_id = launched["Instances"][0]["InstanceId"]
    run.later("ec2", "TerminateInstances", InstanceIds=[instance_id])
    reservations = run("ec2", "DescribeInstances", InstanceIds=[instance_id])["Reservations"]
    assert reservations[0]["Instances"][0]["State"]["Name"]
    vpc = run("ec2", "CreateVpc", CidrBlock="10.99.0.0/16")["Vpc"]["VpcId"]
    run.later("ec2", "DeleteVpc", VpcId=vpc)
    group = run("ec2", "CreateSecurityGroup", GroupName=name, Description="t", VpcId=vpc)["GroupId"]
    run.later("ec2", "DeleteSecurityGroup", GroupId=group)


@live
def test_live_cloudformation(run, name):
    template = {
        "Parameters": {"QueueName": {"Type": "String"}},
        "Resources": {"Q": {"Type": "AWS::SQS::Queue", "Properties": {"QueueName": {"Ref": "QueueName"}}}},
    }
    body = json.dumps(template)
    found = run("cloudformation", "ValidateTemplate", TemplateBody=body)["Parameters"]
    assert [p["ParameterKey"] for p in found] == ["QueueName"]
    parameters = [{"ParameterKey": "QueueName", "ParameterValue": name}]
    run("cloudformation", "CreateStack", StackName=name, TemplateBody=body, Parameters=parameters)
    run.later("cloudformation", "DeleteStack", StackName=name)
    cfn = aws.client("http://localhost:4566", "cloudformation", "us-east-1", "000000000000")
    cfn.get_waiter("stack_create_complete").wait(StackName=name, WaiterConfig={"Delay": 1})
    assert run("cloudformation", "ListStackResources", StackName=name)["StackResourceSummaries"]
    assert run("cloudformation", "DescribeStackEvents", StackName=name)["StackEvents"]
    assert run("cloudformation", "GetTemplate", StackName=name)["TemplateBody"]


@live
def test_live_route53(run, name):
    zone = run("route53", "CreateHostedZone", Name=f"{name}.test", CallerReference=name)
    zone = zone["HostedZone"]["Id"]
    run.later("route53", "DeleteHostedZone", Id=zone)
    record = {
        "Name": f"www.{name}.test.",
        "Type": "A",
        "TTL": 60,
        "ResourceRecords": [{"Value": "10.0.0.1"}],
    }

    def change(action, record_set):
        batch = {"Changes": [{"Action": action, "ResourceRecordSet": record_set}]}
        run("route53", "ChangeResourceRecordSets", HostedZoneId=zone, ChangeBatch=batch)

    change("CREATE", record)
    listed = run("route53", "ListResourceRecordSets", HostedZoneId=zone)["ResourceRecordSets"]
    # the browser deletes by handing a listed record straight back
    change("DELETE", next(r for r in listed if r["Type"] == "A"))


@live
def test_live_rule_trigger_and_mail(client, run, name):
    queue = run("sqs", "CreateQueue", QueueName=name)["QueueUrl"]
    run.later("sqs", "DeleteQueue", QueueUrl=queue)
    arn = run("sqs", "GetQueueAttributes", QueueUrl=queue, AttributeNames=["QueueArn"])
    rule = run("events", "PutRule", Name=name, ScheduleExpression="rate(1 day)")["RuleArn"]
    run.later("events", "DeleteRule", Name=name)
    run("events", "PutTargets", Rule=name, Targets=[{"Id": "q", "Arn": arn["Attributes"]["QueueArn"]}])
    run.later("events", "RemoveTargets", Rule=name, Ids=["q"])
    response = client.post(f"{BASE}/events/trigger", params={"arn": rule}, headers=ORIGIN)
    assert response.status_code == 204
    for _ in range(50):
        if client.get(f"{BASE}/sqs/messages", params={"queue_url": queue}).json():
            break
        time.sleep(0.1)
    else:
        pytest.fail("the triggered rule did not reach its target")

    sender = f"{name}@example.com"
    run("ses", "VerifyEmailIdentity", EmailAddress=sender)
    run.later("ses", "DeleteIdentity", Identity=sender)
    message = {"Subject": {"Data": name}, "Body": {"Html": {"Data": "<b>hi</b>"}}}
    sent = run("ses", "SendEmail", Source=sender, Destination={"ToAddresses": [sender]}, Message=message)
    stored = client.get(f"{BASE}/ses/messages").json()
    assert name in [m.get("Subject") for m in stored]
    url = f"{BASE}/ses/messages"
    assert client.delete(url, params={"id": sent["MessageId"]}, headers=ORIGIN).status_code == 204
    assert name not in [m.get("Subject") for m in client.get(url).json()]
