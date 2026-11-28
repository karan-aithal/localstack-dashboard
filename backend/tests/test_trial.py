"""
Pages of services outside a freemium license, run for real where the license covers them.

Each case creates a resource and then does what its page does: finds it in the list under the
page's key, opens its views, and removes it with the page's own operation.

Services whose first use makes the instance download software are left out: their engines are
large. Those that download only a little run when DASHBOARD_TEST_DOWNLOADS is set.
"""

import json
import re

import pytest
from conftest import live
from test_features import BASE, REGISTRY, ROLE, name, run, skip_if_it_downloads  # noqa: F401


@pytest.fixture
def covered(client):
    return set(client.get(f"{BASE}/licensed").json()["services"] or [])


def page(path: str):
    """The registry node at "tile/tab/view/..." and the API it calls."""
    tile, *ids = path.split("/")
    service = next(s for s in REGISTRY if s["id"] == tile)
    api, nodes = service["service"], service["tabs"]
    for ident in ids:
        node = next(n for n in nodes if n["id"] == ident)
        api = node.get("service", api)
        nodes = node.get("views", [])
    return node, api


def fill(template, ids, key=None, row=None):
    """Replace the placeholders the browser replaces."""
    if isinstance(template, dict):
        return {k: fill(v, ids, key, row) for k, v in template.items()}
    if isinstance(template, list):
        return [fill(v, ids, key, row) for v in template]
    if not isinstance(template, str):
        return template
    if template == "$key":
        return key
    if template == "$row":
        return row
    if template.startswith("$row."):
        return row[template[5:]]
    if re.fullmatch(r"\$\d", template):
        return ids[int(template[1])]
    return template


def at(value, path: str):
    for part in filter(None, path.split(".")):
        value = value[int(part)] if part.isdigit() else value[part]
    return value


def row_key(row, key):
    if isinstance(row, str):
        return row
    if isinstance(key, list):
        return json.dumps({k: row[k] for k in key})
    return str(row[key])


def lifecycle(run, path, params, ids=()):
    """Do what the page at `path` does with a new resource. Returns the ids of pages below it."""
    node, api = page(path)
    listing, create = node["list"], node["create"]
    asked = fill(listing.get("params", {}), ids)
    if choose := listing.get("choose"):
        asked[choose["name"]] = params[choose["name"]]

    def listed():
        rows = at(run(api, listing["op"], **asked), listing["items"])
        return {row_key(r, listing.get("key")): r for r in rows}

    before = listed()
    run(api, create["op"], **fill(create.get("params", {}), ids), **params)
    # only what was not there before may be touched, and later removed
    new = {k: r for k, r in listed().items() if k not in before}
    assert len(new) == 1, f"{path}: expected one new entry in the list, found {new}"
    [(key, row)] = new.items()
    remove = node["remove"]
    removal = fill(remove.get("params", {}), ids, key, row)
    if first := remove.get("first"):
        found = run(api, first["op"], **fill(first.get("params", {}), ids, key, row))
        removal |= {field: at(found, path) for field, path in first["also"].items()}
    run.later(api, remove["op"], **removal)

    inner = [*ids, key]
    for view in node.get("views", []):
        used = view.get("service", api)
        if show := view.get("show"):
            run(used, show["op"], **fill(show.get("params", {}), inner))
        if source := view.get("form", {}).get("from"):
            answer = run(used, source["op"], **fill(source.get("params", {}), inner))
            at(answer, source["path"])
            for extra in source.get("also", {}).values():
                at(answer, extra)
        if below := view.get("list"):
            run(used, below["op"], **fill(below.get("params", {}), inner))
    return inner


def simple(**params):
    """Cases that need only parameters: "{n}" is the name, "{u}" the name without dashes."""

    def prepare(run, name):
        text = json.dumps(params).replace("{n}", name).replace("{u}", name.replace("-", "_"))
        return json.loads(text)

    return prepare


def scalable_target(run, name):
    run(
        "dynamodb",
        "CreateTable",
        TableName=name,
        KeySchema=[{"AttributeName": "id", "KeyType": "HASH"}],
        AttributeDefinitions=[{"AttributeName": "id", "AttributeType": "S"}],
        BillingMode="PAY_PER_REQUEST",
    )
    run.later("dynamodb", "DeleteTable", TableName=name)
    return {
        "ServiceNamespace": "dynamodb",
        "ResourceId": f"table/{name}",
        "ScalableDimension": "dynamodb:table:ReadCapacityUnits",
        "MinCapacity": 1,
        "MaxCapacity": 2,
    }


def trail(run, name):
    run("s3", "CreateBucket", Bucket=name)
    run.later("s3", "DeleteBucket", Bucket=name)

    def empty():
        for found in run("s3", "ListObjectsV2", Bucket=name).get("Contents", []):
            run("s3", "DeleteObject", Bucket=name, Key=found["Key"])

    # the trail writes into its bucket, which must be empty to be deleted
    run.defer(empty)
    return {"Name": name, "S3BucketName": name}


def pipe(run, name):
    arns = []
    for suffix in ("in", "out"):
        queue = run("sqs", "CreateQueue", QueueName=f"{name}-{suffix}")["QueueUrl"]
        run.later("sqs", "DeleteQueue", QueueUrl=queue)
        found = run("sqs", "GetQueueAttributes", QueueUrl=queue, AttributeNames=["QueueArn"])
        arns.append(found["Attributes"]["QueueArn"])
    return {"Name": name, "Source": arns[0], "Target": arns[1], "RoleArn": ROLE}


def default_network(run):
    vpcs = run("ec2", "DescribeVpcs", Filters=[{"Name": "is-default", "Values": ["true"]}])
    vpc = vpcs["Vpcs"][0]["VpcId"]
    found = run("ec2", "DescribeSubnets", Filters=[{"Name": "vpc-id", "Values": [vpc]}])
    return vpc, [s["SubnetId"] for s in found["Subnets"][:2]]


def load_balancer(run, name):
    return {"Name": name, "Subnets": default_network(run)[1]}


def target_group(run, name):
    return {"Name": name, "Protocol": "HTTP", "Port": 80, "VpcId": default_network(run)[0]}


DISTRIBUTION = {
    "CallerReference": "{n}",
    "Comment": "dashboard-test",
    "Enabled": False,
    "Origins": {
        "Quantity": 1,
        "Items": [
            {
                "Id": "o",
                "DomainName": "example.com",
                "CustomOriginConfig": {
                    "HTTPPort": 80,
                    "HTTPSPort": 443,
                    "OriginProtocolPolicy": "http-only",
                },
            }
        ],
    },
    "DefaultCacheBehavior": {
        "TargetOriginId": "o",
        "ViewerProtocolPolicy": "allow-all",
        "ForwardedValues": {"QueryString": False, "Cookies": {"Forward": "none"}},
        "MinTTL": 0,
    },
}

# page, how to make its create parameters, and pages below the new resource
CASES = [
    ("amplify/apps", simple(name="{n}"), {}),
    ("apigateway/v2", simple(Name="{n}", ProtocolType="HTTP"), {}),
    ("appconfig/applications", simple(Name="{n}"), {}),
    ("application-autoscaling/targets", scalable_target, {}),
    (
        "appsync/apis",
        simple(name="{n}", authenticationType="API_KEY"),
        {"datasources": simple(name="{u}", type="NONE"), "keys": simple(description="{n}")},
    ),
    (
        "backup/plans",
        simple(
            BackupPlan={
                "BackupPlanName": "{n}",
                "Rules": [{"RuleName": "r", "TargetBackupVaultName": "Default"}],
            }
        ),
        {},
    ),
    ("backup/vaults", simple(BackupVaultName="{n}"), {}),
    (
        "ce/categories",
        simple(
            Name="{n}",
            RuleVersion="CostCategoryExpression.v1",
            Rules=[
                {
                    "Value": "v",
                    "Rule": {"Dimensions": {"Key": "LINKED_ACCOUNT", "Values": ["000000000000"]}},
                }
            ],
        ),
        {},
    ),
    ("cloudfront/distributions", simple(DistributionConfig=DISTRIBUTION), {}),
    ("cloudtrail/trails", trail, {}),
    (
        "cognito/pools",
        simple(PoolName="{n}"),
        {"groups": simple(GroupName="{n}"), "users": simple(Username="{n}")},
    ),
    (
        "cognito/identity-pools",
        simple(IdentityPoolName="{u}", AllowUnauthenticatedIdentities=False),
        {},
    ),
    ("ec2/load-balancers", load_balancer, {}),
    ("ec2/target-groups", target_group, {}),
    ("ecs/clusters", simple(clusterName="{n}"), {}),
    (
        "ecs/definitions",
        simple(family="{n}", containerDefinitions=[{"name": "c", "image": "nginx", "memory": 128}]),
        {},
    ),
    ("events/pipes", pipe, {}),
    (
        "glue/databases",
        simple(DatabaseInput={"Name": "{u}"}),
        {"tables": simple(TableInput={"Name": "{u}"})},
    ),
    (
        "glue/connections",
        simple(
            ConnectionInput={
                "Name": "{n}",
                "ConnectionType": "JDBC",
                "ConnectionProperties": {
                    "JDBC_CONNECTION_URL": "jdbc:postgresql://localhost:5432/db",
                    "USERNAME": "u",
                    "PASSWORD": "dashboard-test",
                },
            }
        ),
        {},
    ),
    (
        "glue/crawlers",
        simple(Name="{n}", Role=ROLE, Targets={"S3Targets": [{"Path": "s3://{n}"}]}),
        {},
    ),
    (
        "glue/jobs",
        simple(Name="{n}", Role=ROLE, Command={"Name": "glueetl", "ScriptLocation": "s3://x/y"}),
        {},
    ),
    ("glue/registries", simple(RegistryName="{n}"), {}),
    (
        "glue/schemas",
        simple(
            SchemaName="{n}",
            DataFormat="AVRO",
            Compatibility="NONE",
            SchemaDefinition='{"type":"record","name":"r","fields":[]}',
        ),
        {},
    ),
    (
        "sagemaker/models",
        # the instance fails with an internal error without a container
        simple(ModelName="{n}", ExecutionRoleArn=ROLE, PrimaryContainer={"Image": "test:none"}),
        {},
    ),
    (
        "sagemaker/endpoint-configs",
        simple(
            EndpointConfigName="{n}",
            ProductionVariants=[
                {
                    "VariantName": "v",
                    "ModelName": "{n}",
                    "InitialInstanceCount": 1,
                    "InstanceType": "ml.t2.medium",
                }
            ],
        ),
        {},
    ),
    ("ses/v2", simple(EmailIdentity="{n}@example.com"), {}),
    ("timestream/databases", simple(DatabaseName="{n}"), {"tables": simple(TableName="{n}")}),
]


@live
@pytest.mark.parametrize("path,prepare,children", CASES, ids=[c[0] for c in CASES])
def test_live_page_lifecycle(run, name, covered, path, prepare, children):  # noqa: F811
    api = page(path)[1]
    if api not in covered:
        pytest.skip(f"the license does not cover {api}")
    skip_if_it_downloads(api)
    ids = lifecycle(run, path, prepare(run, name))
    for view, child in children.items():
        lifecycle(run, f"{path}/{view}", child(run, name), ids)
