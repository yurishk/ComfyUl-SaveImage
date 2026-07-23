import assert from "node:assert/strict";
import test from "node:test";

import { buildReadOnlyPrompt } from "../web/read_only_prompt.mjs";

test("preview snapshot does not serialize or mutate random seed widgets", () => {
  let serializeCalls = 0;
  const seedWidget = {
    name: "noise_seed",
    value: -1,
    serializeValue() {
      serializeCalls += 1;
      this.value = 123456;
      return this.value;
    },
  };
  const sampler = {
    id: 1,
    comfyClass: "KSampler Adv. (Efficient)",
    inputs: [],
    widgets: [seedWidget, { name: "steps", value: 20 }],
  };
  const saver = {
    id: 2,
    comfyClass: "SmartSaveImage",
    inputs: [{ name: "images", link: 10 }],
    widgets: [],
  };
  const unrelated = {
    id: 3,
    comfyClass: "KSampler",
    inputs: [],
    widgets: [{ name: "seed", value: 999 }],
  };
  const graph = {
    _nodes: [sampler, saver, unrelated],
    links: { 10: { origin_id: 1, target_id: 2 } },
    getNodeById(id) {
      return this._nodes.find((node) => node.id === id);
    },
  };

  const snapshot = buildReadOnlyPrompt(graph, saver);

  assert.equal(snapshot["1"].inputs.noise_seed, -1);
  assert.equal(seedWidget.value, -1);
  assert.equal(serializeCalls, 0);
  assert.equal(snapshot["3"], undefined);
});

test("non-serializable controls are ignored without calling hooks", () => {
  const node = {
    id: 4,
    type: "ExampleNode",
    inputs: [],
    widgets: [
      { name: "text", value: "hello" },
      { name: "button", value: "click", options: { serialize: false } },
      { name: "object", value: { nested: true } },
    ],
  };
  const snapshot = buildReadOnlyPrompt({ _nodes: [node] });

  assert.deepEqual(snapshot["4"], {
    class_type: "ExampleNode",
    inputs: { text: "hello" },
  });
});
