import fs from "node:fs";

if (process.env.SERVER_PID) {
  const entries = fs.readFileSync(`/proc/${process.env.SERVER_PID}/environ`, "utf8").split("\0");
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator > 0) process.env[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
}

const articles = [
  "GRA-00170", "GRA-08330", "GRA-00070", "GRA-00060",
  "GRA-08590", "GRA-00190", "GRA-00120", "GRA-08510",
  "GRA-08570", "GRA-07920", "GRA-00080", "GRA-00180",
  "GRA-00220", "GRA-07950", "GRA-08520", "GRA-08720",
];

const [{ getMsBundleComponents }, { getDispenserLaneState }] = await Promise.all([
  import("../server/services/ms.mjs"),
  import("../server/services/sklad-movements.mjs"),
]);

const [bundleMap, laneState] = await Promise.all([
  getMsBundleComponents(articles),
  getDispenserLaneState({ warehouseName: "Дозатор" }),
]);
const laneByProduct = new Map((laneState.lanes || []).map((lane) => [Number(lane.productId), lane]));
const result = articles.map((article) => {
  const bundle = bundleMap.get(article);
  const components = (bundle?.components || []).map((component) => ({
    productId: component.id,
    article: component.article,
    name: component.name,
    quantity: component.quantity,
    lane: laneByProduct.get(Number(component.id))?.lane || null,
    dispenserQuantity: laneByProduct.get(Number(component.id))?.quantity ?? null,
  }));
  return {
    article,
    found: Boolean(bundle),
    name: bundle?.name || null,
    components,
    ready: Boolean(bundle?.components?.length) && components.every((component) => component.lane),
  };
});
console.log(JSON.stringify({ laneState, bundles: result }, null, 2));
