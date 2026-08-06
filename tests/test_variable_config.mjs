import assert from "node:assert/strict";
import test from "node:test";

import {
  createVariableItem,
  isCustomVariableKey,
  normalizeVariableKey,
  parseVariableConfig,
  serializeVariableConfig,
  variableInputName,
  variableInputType,
} from "../web/variable_config.mjs";

test("malformed configuration safely becomes an empty list", () => {
  assert.deepEqual(parseVariableConfig("not json"), []);
  assert.deepEqual(parseVariableConfig({ items: "wrong" }), []);
});

test("configuration round trip preserves row identity, order, and values", () => {
  const items = [
    { id: "first", key: "seed", value: "123" },
    { id: "second", key: "project", value: "Client A" },
  ];
  assert.deepEqual(parseVariableConfig(serializeVariableConfig(items)), items);
});

test("any number of rows can be persisted", () => {
  const items = Array.from({ length: 40 }, (_, index) => ({
    id: `row-${index}`,
    key: `custom_${index}`,
    value: String(index),
  }));
  assert.equal(parseVariableConfig(serializeVariableConfig(items)).length, 40);
});

test("keys are normalized and invalid custom token names are rejected", () => {
  assert.equal(normalizeVariableKey(" Project_Name "), "project_name");
  assert.equal(normalizeVariableKey("bad-name"), "");
  assert.equal(createVariableItem("BAD KEY").key, "seed");
  assert.equal(isCustomVariableKey("project_name"), true);
  assert.equal(isCustomVariableKey("model"), false);
  assert.equal(isCustomVariableKey("date"), false);
});

test("dynamic input names are stable and input support follows the variable type", () => {
  assert.equal(variableInputName("row-123"), "variable_row-123");
  assert.equal(variableInputType("seed"), "INT");
  assert.equal(variableInputType("cfg"), "FLOAT");
  assert.equal(variableInputType("prompt"), "STRING");
  assert.equal(variableInputType("lora"), "*");
  assert.equal(variableInputType("sampler"), null);
  assert.equal(variableInputType("scheduler"), null);
});
