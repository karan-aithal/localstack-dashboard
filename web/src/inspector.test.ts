import assert from "node:assert/strict";
import { test } from "node:test";
import { caller, flow, millis, payload, type Span, traces } from "./inspector.ts";

const span = (id: string, trace: string, parent: string | null, service: string, start: number, status = "ok"): Span => ({
  trace_id: trace,
  span_id: id,
  parent_span_id: parent,
  start_time_unix_nano: String(1_795_764_182_000_000_000n + BigInt(start) * 1_000_000n),
  end_time_unix_nano: null,
  service_name: service,
  operation_name: `Op${id}`,
  operation_status: status,
  resource_name: "r",
  arn: "",
  account_id: "",
  region: "",
  kind: 1,
  status_message: null,
  attributes: { "localstack.aws.service.request": '{"a":1}', "localstack.aws.service.response": null },
});

const publish = span("1", "t1", null, "sns", 10);
const send = span("2", "t1", "1", "sqs", 20, "error");
const later = span("3", "t2", null, "s3", 30, "iam_implicit_warn");

test("requests are grouped, newest first", () => {
  const found = traces([send, later, publish]);
  assert.deepEqual(found.map((t) => t.id), ["t2", "t1"]);
  assert.equal(found[1].root.span_id, "1");
  assert.equal(found[1].errors, 1);
  assert.equal(found[0].warnings, 1);
  assert.equal(found[1].consumer, "Client");
});

test("a request whose parent was not stored still shows", () => {
  const [only] = traces([send]);
  assert.equal(only.root.span_id, "2");
  assert.equal(only.consumer, "Client");
});

test("callers and flow", () => {
  assert.equal(caller(send, [publish, send]), "sns: r");
  const graph = flow([publish, send, publish]);
  assert.deepEqual(graph.columns, [["Client"], ["sns: r"], ["sqs: r"]]);
  assert.equal(graph.links.length, 2);
  assert.deepEqual(graph.links[0].operations, ["Op1"]);
  assert.equal(graph.links[1].failed, true);
});

test("times and payloads", () => {
  assert.equal(millis("1795764182000000000"), 1795764182000);
  assert.equal(payload(publish, "request"), '{\n  "a": 1\n}');
  assert.equal(payload(publish, "response"), null);
});
