import {
  inspectResolvedMovementPlan as inspectWbPlan,
  resolveWarehouseProductMeta,
} from "../server/services/sklad-movements.mjs";
import { inspectResolvedMovementPlan as inspectOzPlan } from "../../OZ/server/services/sklad-movements.mjs";

const samples = [
  { label: "repeated bundle", productId: 139, quantity: 2 },
  { label: "mixed bundle", productId: 149, quantity: 1 },
  { label: "single product", productId: 80, quantity: 2 },
  { label: "bundle without composition", productId: 126, quantity: 1, expectError: true },
];

let failed = false;
for (const [marketplace, inspect] of [["WB", inspectWbPlan], ["OZ/YM", inspectOzPlan]]) {
  for (const sample of samples) {
    try {
      const plan = await inspect({ resolvedProductIds: [sample.productId], quantity: sample.quantity });
      if (sample.expectError) {
        failed = true;
        console.error(JSON.stringify({ marketplace, ...sample, unexpectedPlan: plan }));
      } else {
        console.log(JSON.stringify({ marketplace, ...sample, plan }));
      }
    } catch (error) {
      if (!sample.expectError) failed = true;
      console.log(JSON.stringify({ marketplace, ...sample, error: error?.message || String(error) }));
    }
  }
}

const wbMeta = (await resolveWarehouseProductMeta(["GRA-00170"])).get("GRA-00170");
if (!wbMeta?.isBundle || wbMeta.jarCount !== 3 || wbMeta.components?.length !== 1) failed = true;
console.log(JSON.stringify({ marketplace: "WB", label: "bundle display metadata", meta: wbMeta }));

process.exitCode = failed ? 1 : 0;
