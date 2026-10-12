import test from "node:test";
import assert from "node:assert/strict";

import { buildBundleMovementPlan } from "../../sborka/shared/bundle-movement-plan.mjs";

const builders = [["WB/Ozon/Yandex", buildBundleMovementPlan]];

for (const [name, buildPlan] of builders) {
  test(`${name}: repeated jars are multiplied by bundle count`, () => {
    assert.deepEqual(
      buildPlan(2, [{ component_id: 80, quantity: 3, article: "GRA-07700" }]),
      [{ productId: 80, article: "GRA-07700", name: null, quantity: 6 }]
    );
  });

  test(`${name}: mixed duplicate component rows are merged`, () => {
    assert.deepEqual(
      buildPlan(1, [
        { component_id: 44, quantity: 1, article: "GRA-08110", name: "D3K2" },
        { component_id: 27, quantity: 2, article: "GRA-08240", name: "Magnesium" },
        { component_id: 44, quantity: 2, article: "GRA-08110", name: "D3K2" },
      ]),
      [
        { productId: 27, article: "GRA-08240", name: "Magnesium", quantity: 2 },
        { productId: 44, article: "GRA-08110", name: "D3K2", quantity: 3 },
      ]
    );
  });

  test(`${name}: invalid component rows cannot create movements`, () => {
    assert.deepEqual(buildPlan(1, [
      { component_id: 0, quantity: 3 },
      { component_id: 44, quantity: 0 },
      { component_id: null, quantity: 1 },
    ]), []);
  });
}
