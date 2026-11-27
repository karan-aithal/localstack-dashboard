import assert from "node:assert/strict";
import { test } from "node:test";
import { edges, layers, type Machine, nested } from "./sfn.ts";

const machine: Machine = {
  StartAt: "Check",
  States: {
    Check: { Type: "Choice", Choices: [{ Next: "Work" }, { Next: "Work" }], Default: "Stop" },
    Work: { Type: "Parallel", Next: "Check", Catch: [{ Next: "Stop" }], Branches: [{ StartAt: "a", States: { a: { Type: "Pass", End: true } } }] },
    Stop: { Type: "Succeed" },
    Lost: { Type: "Pass", Next: "Missing" },
  },
};

test("edges are unique and point at real states", () => {
  assert.deepEqual(
    edges(machine).map((e) => `${e.from}>${e.to}:${e.kind}`),
    ["Check>Work:choice", "Check>Stop:choice", "Work>Check:next", "Work>Stop:catch"],
  );
});

test("layers follow the distance from the start and end despite loops", () => {
  assert.deepEqual(layers(machine), [["Check"], ["Work", "Stop"], ["Lost"]]);
});

test("branches are found", () => {
  assert.deepEqual(nested(machine).map((n) => n.title), ["Work: branch 1"]);
});
