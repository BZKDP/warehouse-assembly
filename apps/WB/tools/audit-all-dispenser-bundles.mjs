import fs from "node:fs";
import { Pool } from "pg";

if (process.env.SERVER_PID) {
  for (const entry of fs.readFileSync(`/proc/${process.env.SERVER_PID}/environ`, "utf8").split("\0")) {
    const separator = entry.indexOf("=");
    if (separator > 0) process.env[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
}

const [{ getDispenserLaneState }, config] = await Promise.all([
  import("../server/services/sklad-movements.mjs"),
  import("../server/config.mjs"),
]);

const pool = new Pool({
  host: config.SKLAD_DB_HOST,
  port: config.SKLAD_DB_PORT,
  user: config.SKLAD_DB_USER,
  password: config.SKLAD_DB_PASSWORD,
  database: config.SKLAD_DB_NAME,
  ssl: config.SKLAD_DB_SSL === "require" ? { rejectUnauthorized: false } : false,
  max: 1,
});

try {
  const laneState = await getDispenserLaneState({ warehouseName: "Дозатор" });
  const laneByProduct = new Map(laneState.lanes.map((lane) => [Number(lane.productId), lane]));
  const rows = await pool.query(
    `select b.id, b.article, b.name,
            coalesce(jsonb_agg(jsonb_build_object(
              'productId', c.id,
              'article', c.article,
              'name', c.name,
              'quantity', bc.quantity
            ) order by bc.id) filter (where c.id is not null), '[]'::jsonb) as components
       from products_s b
       left join bundle_components_s bc on bc.bundle_id = b.id
       left join products_s c on c.id = bc.component_id and coalesce(c.archived, false) = false
      where lower(coalesce(b.entity_type, '')) = 'bundle'
        and coalesce(b.archived, false) = false
      group by b.id, b.article, b.name
      order by b.article, b.id`
  );
  const eligible = [];
  const broken = [];
  for (const bundle of rows.rows || []) {
    const components = Array.isArray(bundle.components) ? bundle.components : [];
    if (!components.length || components.some((component) => !Number(component.productId) || Number(component.quantity) <= 0)) {
      broken.push({ article: bundle.article, name: bundle.name, reason: "Нет корректного состава" });
      continue;
    }
    if (!components.every((component) => laneByProduct.has(Number(component.productId)))) continue;
    const planComponents = components.map((component) => ({
      ...component,
      lane: laneByProduct.get(Number(component.productId)).lane,
      boxId: laneByProduct.get(Number(component.productId)).boxId,
    }));
    eligible.push({
      article: bundle.article,
      name: bundle.name,
      components: planComponents,
      lanes: planComponents.flatMap((component) => Array.from({ length: Number(component.quantity) }, () => component.lane)),
      totalJars: planComponents.reduce((sum, component) => sum + Number(component.quantity), 0),
    });
  }
  console.log(JSON.stringify({ configured: laneState.configured, laneErrors: laneState.errors, laneCount: laneState.lanes.length, totalBundles: rows.rowCount, eligibleCount: eligible.length, eligible, broken }, null, 2));
} finally {
  await pool.end();
}
