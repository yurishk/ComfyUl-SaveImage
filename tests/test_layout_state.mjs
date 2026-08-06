import assert from "node:assert/strict";
import test from "node:test";

import { slotPositionChanged } from "../web/layout_state.mjs";

test("stable slot positions do not request another canvas redraw", () => {
  assert.equal(slotPositionChanged([0, 120], [0, 120]), false);
  assert.equal(slotPositionChanged([0, 120], [0, 120.2]), false);
});

test("missing or meaningfully moved slot positions request one redraw", () => {
  assert.equal(slotPositionChanged(undefined, [0, 120]), true);
  assert.equal(slotPositionChanged([0, 120], [0, 121]), true);
});
