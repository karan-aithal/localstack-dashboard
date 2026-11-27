import assert from "node:assert/strict";
import { test } from "node:test";
import { itemKey, plain, queryParams } from "./dynamo.ts";
import { cell, columns, current, fillLink, getPath, href, label, rowKey, substitute, title } from "./engine.ts";

test("placeholders are filled with their own types", () => {
  const context = { ids: ["layer", "3"], key: "k", row: { Version: 7 } };
  assert.deepEqual(substitute({ A: "$0", B: "#1", C: ["$key"], D: "$row.Version", E: "x$0", F: "$2" }, context), {
    A: "layer",
    B: 3,
    C: ["k"],
    D: 7,
    E: "x$0",
  });
});

test("whole rows, fresh ids and nested lists", () => {
  const row = { Name: "a" };
  assert.deepEqual(substitute({ Set: "$row" }, { row }), { Set: row });
  assert.match((substitute({ Ref: "$now" }, {}) as { Ref: string }).Ref, /^\d+$/);
  const result = { Reservations: [{ Instances: [{ Id: 1 }, { Id: 2 }] }, { Instances: [] }, { Instances: [{ Id: 3 }] }] };
  assert.deepEqual(getPath(result, "Reservations.Instances"), [{ Id: 1 }, { Id: 2 }, { Id: 3 }]);
  assert.equal(getPath(result, "Reservations.0.Instances.1.Id"), 2);
  assert.equal(getPath(result, ""), result);
  assert.equal(title("State.Name"), "State Name");
  assert.equal(cell([{ Value: "1.1.1.1" }, { Value: "2.2.2.2" }]), "1.1.1.1, 2.2.2.2");
});

test("links are escaped", () => {
  assert.equal(fillLink("/resources/logs/groups?p=/aws/lambda/$0", ["a&b"]), "/resources/logs/groups?p=/aws/lambda/a%26b");
  const url = new URL(href("sqs", "queues", ["http://x/q&r", "send"], { new: "1" }), "http://localhost");
  assert.deepEqual(url.searchParams.getAll("p"), ["http://x/q&r", "send"]);
  assert.equal(href("s3", "buckets"), "/resources/s3/buckets");
});

test("rows", () => {
  assert.equal(rowKey("url", undefined), "url");
  assert.equal(rowKey({ Name: "n" }, "Name"), "n");
  assert.equal(rowKey({ a: 1, b: 2 }, ["b"]), '{"b":2}');
  assert.deepEqual(columns([{ a: 1, nested: {} }, { b: "x" }], { op: "", items: "" }), ["a", "b"]);
  assert.deepEqual(columns(["x"], { op: "", items: "" }), []);
  assert.equal(getPath({ a: [{ b: 1 }] }, "a.0.b"), 1);
  assert.equal(getPath({}, "a.0.b"), undefined);
});

test("display", () => {
  assert.equal(title("logGroupName"), "Log Group Name");
  assert.equal(cell(0, "creationTime"), "0");
  assert.equal(cell(1700000000000, "creationTime"), "2023-11-14T22:13:20.000Z");
  assert.equal(cell([{ Name: "a", Value: "1" }]), "a=1");
});

test("headings", () => {
  assert.equal(label("http://sqs.localhost:4566/000000000000/orders"), "orders");
  const metric = { Namespace: "n", MetricName: "m", Dimensions: [{ Name: "Queue", Value: "q" }] };
  assert.equal(label(JSON.stringify(metric)), "n / m / Queue=q");
  assert.equal(label(JSON.stringify({ ...metric, Dimensions: [] })), "n / m");
  assert.equal(label("{not json"), "{not json");
  assert.equal(label("arn:aws:sns:us-east-1:000000000000:t"), "t");
  assert.equal(label("arn:aws:iam::000000000000:policy/p"), "p");
  assert.equal(label("/hostedzone/Z1"), "Z1");
  assert.equal(label("/app/setting"), "/app/setting");
});

const SCHEMA = [
  { AttributeName: "id", KeyType: "HASH" as const },
  { AttributeName: "at", KeyType: "RANGE" as const },
];
const TYPES = [
  { AttributeName: "id", AttributeType: "S" },
  { AttributeName: "at", AttributeType: "N" },
];

test("dynamodb values and keys", () => {
  const item = { id: { S: "a" }, at: { N: "12345678901234567890" }, m: { M: { l: { L: [{ BOOL: false }, { NULL: true }] } } } };
  assert.deepEqual(plain({ M: item }), { id: "a", at: "12345678901234567890", m: { l: [false, null] } });
  assert.deepEqual(itemKey(item, SCHEMA), { id: item.id, at: item.at });
});

test("dynamodb query", () => {
  const query = queryParams(SCHEMA, TYPES, "a", { operator: ">", value: "5" });
  assert.equal(query.KeyConditionExpression, "#pk = :pk AND #sk > :sk");
  assert.deepEqual(query.ExpressionAttributeValues, { ":pk": { S: "a" }, ":sk": { N: "5" } });
  assert.equal(queryParams(SCHEMA, TYPES, "a", { operator: "=", value: "" }).KeyConditionExpression, "#pk = :pk");
  assert.throws(() => queryParams(SCHEMA, TYPES, "a", { operator: "OR", value: "1" }));
});

test("a form starts from what the instance answered", () => {
  const answer = { Config: { Comment: "x" }, ETag: "v1" };
  assert.deepEqual(current(answer, { op: "Get", path: "Config" }), { Comment: "x" });
  assert.deepEqual(current(answer, { op: "Get", path: "Config", as: "Config", also: { IfMatch: "ETag" } }), {
    Config: { Comment: "x" },
    IfMatch: "v1",
  });
  assert.deepEqual(current(answer, { op: "Get", path: "Missing" }), {});
});
