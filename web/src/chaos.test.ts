import assert from "node:assert/strict";
import { test } from "node:test";
import { EXPERIMENTS, list, template, type Values } from "./chaos.ts";

const values: Values = { probability: "25", region: " eu-west-1 ", services: "kms, s3,", regions: "us-east-1,us-west-2" };

test("lists ignore blanks", () => {
  assert.deepEqual(list(" a, ,b ,"), ["a", "b"]);
  assert.deepEqual(list(""), []);
});

test("experiments build their rules", () => {
  const [dynamo, , internal, services, regions] = EXPERIMENTS.map((e) => e.rules(values));
  assert.deepEqual(dynamo, [
    { service: "dynamodb", probability: 0.25, error: { statusCode: 400, code: "ProvisionedThroughputExceededException" } },
  ]);
  assert.equal(internal[0].region, "eu-west-1");
  assert.deepEqual(services.map((r) => r.service), ["kms", "s3"]);
  assert.deepEqual(regions.map((r) => r.region), ["us-east-1", "us-west-2"]);
});

test("a blank field makes no rule that would match everything", () => {
  const blank = { ...values, region: " ", services: "", regions: "," };
  for (const experiment of EXPERIMENTS.slice(2)) assert.deepEqual(experiment.rules(blank), []);
});

test("the command survives quotes", () => {
  assert.ok(template("http://x", [{ description: "it's" }]).endsWith(`-d '[{"description":"it'\\''s"}]'`));
});
