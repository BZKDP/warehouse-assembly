import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

const PROJECT_ROOT = "/opt/grasklad-sborka";
const USER_LOGIN = String(process.env.RECONCILE_LOGIN || "stag1").trim().toLowerCase();
const START_AT = process.env.RECONCILE_START || "2026-09-08T00:00:00+03:00";
const END_AT = process.env.RECONCILE_END || new Date().toISOString();
const TARGET_WAREHOUSE_ID = Number(process.env.RECONCILE_WAREHOUSE_ID || 46);

function loadEnv(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx < 1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function dbConfig(prefix = "") {
  const key = (name) => (prefix ? `${prefix}_${name}` : name);
  const sslMode = String(process.env[key("DB_SSL")] || "disable").toLowerCase();
  return {
    host: process.env[key("DB_HOST")],
    port: Number(process.env[key("DB_PORT")] || 5432),
    database: process.env[key("DB_NAME")],
    user: process.env[key("DB_USER")],
    password: process.env[key("DB_PASSWORD")],
    ssl: sslMode === "disable" ? false : { rejectUnauthorized: false },
  };
}

function normalize(value) {
  return String(value ?? "").replace(/\s+/g, "").trim().toUpperCase();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

loadEnv(path.join(PROJECT_ROOT, ".env"));
const app = new Client(dbConfig());
const sklad = new Client(dbConfig("SKLAD"));
await Promise.all([app.connect(), sklad.connect()]);

try {
  const userResult = await app.query(
    `select id, external_employee_id, external_login, external_full_name, surname, name
       from users
      where lower(coalesce(external_login, '')) = $1
      order by id desc
      limit 1`,
    [USER_LOGIN]
  );
  const user = userResult.rows[0];
  if (!user) throw new Error(`User not found: ${USER_LOGIN}`);
  const userId = Number(user.id);
  const externalEmployeeId = Number(user.external_employee_id || 0);

  const wbResult = await app.query(
    `select 'wb'::text as marketplace, so.supply_id as entity_id, so.wb_order_id::text as order_id,
            so.article, so.barcode, so.product_name, greatest(1, coalesce(so.quantity, 1))::int as quantity,
            so.collected_at as completed_at, ss.store_id, ss.store_name,
            ss.sklad_warehouse_id, ss.sklad_warehouse_name, ss.stock_method_enabled, ss.allow_stock_shortage
       from supply_orders so
       join supply_settings ss on ss.supply_id = so.supply_id
      where so.collected_by = $1 and so.collected_at >= $2::timestamptz and so.collected_at < $3::timestamptz
      order by so.collected_at, so.wb_order_id`,
    [userId, START_AT, END_AT]
  );

  const ozResult = await app.query(
    `select 'oz'::text as marketplace, o.assembly_id as entity_id, o.posting_number as order_id,
            i.offer_id as article, coalesce(nullif(p.barcode, ''), 'OZN' || i.sku::text) as barcode,
            i.name as product_name, greatest(1, coalesce(i.quantity, 1))::int as quantity,
            o.collected_at as completed_at, a.store_id, a.store_name,
            a.sklad_warehouse_id, a.sklad_warehouse_name, a.stock_method_enabled, a.allow_stock_shortage
       from ozon_assembly_orders o
       join ozon_assemblies a on a.id = o.assembly_id
       join ozon_assembly_order_items i on i.assembly_id = o.assembly_id and i.posting_number = o.posting_number
       left join lateral (
         select pi.barcode
           from ozon_employee_assembly_pick_items pi
          where pi.assembly_id = o.assembly_id and upper(btrim(pi.article)) = upper(btrim(i.offer_id))
          order by pi.id desc limit 1
       ) p on true
      where o.collected_by = $1 and o.collected_at >= $2::timestamptz and o.collected_at < $3::timestamptz
      order by o.collected_at, o.posting_number, i.line_no`,
    [userId, START_AT, END_AT]
  );

  const ymResult = await app.query(
    `select 'ym'::text as marketplace, o.assembly_id::text as entity_id, o.order_id::text as order_id,
            i.offer_id as article,
            coalesce(nullif(i.barcodes->>0, ''), '') as barcode,
            i.name as product_name, greatest(1, coalesce(i.quantity, 1))::int as quantity,
            o.ready_to_ship_at as completed_at, a.campaign_id::text as store_id,
            ('Yandex ' || a.campaign_id::text) as store_name,
            null::int as sklad_warehouse_id, null::text as sklad_warehouse_name,
            true as stock_method_enabled, a.allow_zero_stock as allow_stock_shortage,
            i.warehouse_product_id
       from ym_orders o
       join ym_assemblies a on a.id = o.assembly_id
       join ym_order_items i on i.order_id = o.order_id
      where o.assigned_user_id = $1 and o.local_state = 'completed'
        and o.ready_to_ship_at >= $2::timestamptz and o.ready_to_ship_at < $3::timestamptz
      order by o.ready_to_ship_at, o.order_id, i.item_id`,
    [userId, START_AT, END_AT]
  ).catch(() => ({ rows: [] }));

  const lines = [...wbResult.rows, ...ozResult.rows, ...ymResult.rows].map((row) => ({
    ...row,
    quantity: Number(row.quantity || 0),
    sklad_warehouse_id: row.sklad_warehouse_id == null ? null : Number(row.sklad_warehouse_id),
    warehouse_product_id: row.warehouse_product_id == null ? null : Number(row.warehouse_product_id),
  }));

  const allTokens = unique(lines.flatMap((line) => [line.article, line.barcode]));
  process.env.SKLAD_FBS_WAREHOUSE_ID = String(TARGET_WAREHOUSE_ID);
  const movementModule = await import(path.join(PROJECT_ROOT, "apps/OZ/server/services/sklad-movements.mjs"));
  const metaMap = await movementModule.resolveWarehouseProductMeta(allTokens);

  for (const line of lines) {
    const barcodeMeta = metaMap.get(normalize(line.barcode));
    const articleMeta = metaMap.get(normalize(line.article));
    const explicitMeta = line.warehouse_product_id
      ? { id: line.warehouse_product_id, name: null, entityType: null, isBundle: false, components: null }
      : null;
    const meta = explicitMeta || barcodeMeta || articleMeta || null;
    line.resolution = meta
      ? {
          productId: Number(meta.id),
          productName: meta.name || null,
          entityType: meta.entityType || null,
          isBundle: meta.isBundle === true,
          components: Array.isArray(meta.components) ? meta.components : [],
          matchedBy: explicitMeta ? "warehouse_product_id" : barcodeMeta ? "barcode" : "article",
        }
      : null;
  }

  const resolvedIds = unique(lines.flatMap((line) => {
    const resolution = line.resolution;
    if (!resolution) return [];
    if (resolution.isBundle && resolution.components.length) return [];
    return [Number(resolution.productId)];
  }));
  const componentArticles = unique(lines.flatMap((line) => line.resolution?.components?.map((c) => c.article) || []));
  const componentProducts = componentArticles.length
    ? await sklad.query(
        `select id, article, code, name from products_s
          where coalesce(archived, false) = false
            and (upper(btrim(article)) = any($1::text[]) or upper(btrim(code)) = any($1::text[]))`,
        [componentArticles.map(normalize)]
      )
    : { rows: [] };
  const componentByArticle = new Map();
  for (const row of componentProducts.rows) {
    componentByArticle.set(normalize(row.article), row);
    componentByArticle.set(normalize(row.code), row);
  }

  const requirements = new Map();
  const unresolved = [];
  for (const line of lines) {
    const resolution = line.resolution;
    if (!resolution) {
      unresolved.push({ ...line, reason: "product_not_resolved" });
      continue;
    }
    const parts = resolution.isBundle && resolution.components.length
      ? resolution.components.map((component) => {
          const product = componentByArticle.get(normalize(component.article));
          return product
            ? { productId: Number(product.id), article: product.article || product.code, name: product.name, multiplier: Number(component.quantity || 0) }
            : { productId: null, article: component.article, name: component.name, multiplier: Number(component.quantity || 0) };
        })
      : [{ productId: Number(resolution.productId), article: line.article, name: resolution.productName || line.product_name, multiplier: 1 }];
    for (const part of parts) {
      if (!part.productId || part.multiplier <= 0) {
        unresolved.push({ ...line, reason: "bundle_component_not_resolved", component: part });
        continue;
      }
      const quantity = line.quantity * part.multiplier;
      const current = requirements.get(part.productId) || {
        productId: part.productId,
        article: part.article,
        name: part.name,
        required: 0,
        orderRefs: [],
      };
      current.required += quantity;
      current.orderRefs.push(`${line.marketplace}:${line.order_id}`);
      requirements.set(part.productId, current);
    }
  }

  const requiredProductIds = [...requirements.keys()];
  const stockResult = requiredProductIds.length
    ? await sklad.query(
        `select p.id as product_id, p.article, p.code, p.name,
                coalesce(sum(case when r.warehouse_id = $1 then sbi.quantity else 0 end), 0)::numeric as box_qty,
                coalesce((select sum(si.quantity)
                            from shelf_items_s si join shelves_s sh on sh.id = si.shelf_id join racks_s rr on rr.id = sh.rack_id
                           where rr.warehouse_id = $1 and si.product_id = p.id), 0)::numeric as loose_qty
           from products_s p
           left join shelf_box_items_s sbi on sbi.product_id = p.id
           left join shelf_boxes_s sb on sb.id = sbi.shelf_box_id
           left join shelves_s s on s.id = sb.shelf_id
           left join racks_s r on r.id = s.rack_id
          where p.id = any($2::int[])
          group by p.id, p.article, p.code, p.name
          order by p.article, p.id`,
        [TARGET_WAREHOUSE_ID, requiredProductIds]
      )
    : { rows: [] };
  const stockByProduct = new Map(stockResult.rows.map((row) => [Number(row.product_id), row]));
  for (const requirement of requirements.values()) {
    const stock = stockByProduct.get(requirement.productId);
    requirement.article = stock?.article || stock?.code || requirement.article;
    requirement.name = stock?.name || requirement.name;
    requirement.available = Number(stock?.box_qty || 0) + Number(stock?.loose_qty || 0);
    requirement.shortage = Math.max(0, requirement.required - requirement.available);
  }

  const skladEmployee = await sklad.query(
    `select id, external_employee_id, full_name from employees_s where external_employee_id = $1 limit 1`,
    [externalEmployeeId]
  );
  const skladEmployeeId = Number(skladEmployee.rows[0]?.id || 0);
  const existingMovements = skladEmployeeId
    ? await sklad.query(
        `select m.id, m.movement_type, m.product_id, p.article, p.name, m.quantity,
                m.from_shelf_id, m.from_shelf_box_id, m.from_employee_id, m.to_employee_id,
                m.source, m.notes, m.created_at,
                case when r.warehouse_id is not null then r.warehouse_id else rb.warehouse_id end as warehouse_id
           from movements_s m
           join products_s p on p.id = m.product_id
           left join shelves_s s on s.id = m.from_shelf_id
           left join racks_s r on r.id = s.rack_id
           left join shelf_boxes_s sb on sb.id = m.from_shelf_box_id
           left join shelves_s ss on ss.id = sb.shelf_id
           left join racks_s rb on rb.id = ss.rack_id
          where m.created_at >= $1::timestamptz and m.created_at < $2::timestamptz
            and (m.from_employee_id = $3 or m.to_employee_id = $3)
          order by m.created_at, m.id`,
        [START_AT, END_AT, skladEmployeeId]
      )
    : { rows: [] };

  const entities = [...new Map(lines.map((line) => [`${line.marketplace}:${line.entity_id}`, {
    marketplace: line.marketplace,
    entityId: line.entity_id,
    storeId: line.store_id,
    storeName: line.store_name,
    skladWarehouseId: line.sklad_warehouse_id,
    skladWarehouseName: line.sklad_warehouse_name,
    stockMethodEnabled: line.stock_method_enabled === true,
    allowStockShortage: line.allow_stock_shortage === true,
  }])).values()];

  const marketplaceSummary = {};
  for (const line of lines) {
    const entry = marketplaceSummary[line.marketplace] ||= { orderIds: new Set(), itemUnits: 0 };
    entry.orderIds.add(line.order_id);
    entry.itemUnits += line.quantity;
  }
  for (const value of Object.values(marketplaceSummary)) {
    value.orders = value.orderIds.size;
    delete value.orderIds;
  }

  const report = {
    generatedAt: new Date().toISOString(),
    period: { startAt: START_AT, endAt: END_AT },
    targetWarehouse: { id: TARGET_WAREHOUSE_ID, name: "FBS МОСКВА" },
    user: {
      id: userId,
      externalEmployeeId,
      skladEmployeeId: skladEmployeeId || null,
      login: user.external_login,
      name: user.external_full_name || `${user.surname || ""} ${user.name || ""}`.trim(),
    },
    summary: {
      marketplace: marketplaceSummary,
      totalOrders: unique(lines.map((line) => `${line.marketplace}:${line.order_id}`)).length,
      totalMarketplaceUnits: lines.reduce((sum, line) => sum + line.quantity, 0),
      totalWarehouseUnitsRequired: [...requirements.values()].reduce((sum, row) => sum + row.required, 0),
      resolvedProducts: requirements.size,
      unresolvedLines: unresolved.length,
      shortageProducts: [...requirements.values()].filter((row) => row.shortage > 0).length,
      existingMovementRows: existingMovements.rows.length,
    },
    entities,
    requirements: [...requirements.values()].sort((a, b) => String(a.article).localeCompare(String(b.article), "ru")),
    unresolved,
    existingMovements: existingMovements.rows,
    lines,
  };

  const outputPath = path.join(PROJECT_ROOT, "backups", `stag1-fbs-audit-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ outputPath, ...report.summary, entities, requirements: report.requirements, unresolved }, null, 2));
} finally {
  await Promise.allSettled([app.end(), sklad.end()]);
}
