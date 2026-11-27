import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeText, encodeText, type Field, isDestructive, parseParams, toParams, toValues } from "./params.ts";

const field = (name: string, type: string): Field => ({
  name,
  type,
  required: false,
  enum: [],
  documentation: "",
  template: null,
});
const FIELDS = [
  field("Name", "string"),
  field("Count", "integer"),
  field("Flag", "boolean"),
  field("Tags", "list"),
  field("Body", "blob"),
];

test("form values become typed parameters and back", () => {
  const params = { Name: "123", Count: 0, Flag: false, Tags: [{ Key: "a" }], Body: "aGk=" };
  assert.deepEqual(toParams(toValues(params, FIELDS), FIELDS), params);
});

test("empty fields are omitted", () => {
  assert.deepEqual(toParams({ Name: "", Count: "" }, FIELDS), {});
});

test("bad input is reported", () => {
  assert.throws(() => toParams({ Count: "x" }, FIELDS), /Count/);
  assert.throws(() => toParams({ Tags: "[" }, FIELDS), /Tags/);
  assert.throws(() => toValues({ Other: 1 }, FIELDS), /Other/);
  assert.throws(() => toValues({ Name: 1 }, FIELDS), /Name/);
  assert.throws(() => parseParams("[1]"), /object/);
});

test("text survives base64, binary is recognised", () => {
  assert.equal(decodeText(encodeText("héllo ✓")), "héllo ✓");
  assert.equal(decodeText("//4="), null);
  assert.equal(decodeText("not base64!"), null);
});

test("destructive operations are recognised", () => {
  for (const name of ["DeleteBucket", "BatchDeleteImage", "TerminateInstances", "PurgeQueue", "ScheduleKeyDeletion", "RemovePermission"]) {
    assert.ok(isDestructive(name), name);
  }
  assert.ok(!isDestructive("ListBuckets"));
});
