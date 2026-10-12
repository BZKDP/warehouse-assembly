import pg from "pg";

const { Pool } = pg;

const SHIPMENT_ID = "89366690";
const WAREHOUSE_ID = 46;
const EXTERNAL_EMPLOYEE_ID = 286;
const EXPECTED_ORDERS = 60;
const EXPECTED_LINES = 77;
const EXPECTED_UNITS = 130;
const SOURCE = `ym_manual_shipment:${SHIPMENT_ID}`;
const APPLY = process.argv.includes("--apply");

// The source of truth is the Yandex shipment workbook downloaded on 2026-09-22.
// Three of these orders were later linked to shipment 89357629 in the API, so a
// shipment_id filter alone would silently omit them.
const ORDER_IDS = [
  61906108289, 61913446082, 61913973698, 61925183810, 61925838786,
  61926930434, 61945126723, 61952071363, 61955175362, 61958880963,
  61959423296, 61959738242, 61961360770, 61961921344, 61966021954,
  61967149058, 61971637121, 61972347011, 61974464258, 61975993025,
  61981838209, 61984295939, 61985799360, 61986018499, 61986237184,
  61987609857, 61988451331, 61988690625, 61988884352, 61989032384,
  61989229568, 61993767808, 61994375488, 61994610944, 61996197826,
  61999998017, 62000079937, 62005460482, 62010776323, 62012670594,
  62012670979, 62013784129, 62013920707, 62014812353, 62016058433,
  62016420288, 62019957441, 62020902336, 62021978371, 62022268738,
  62023225411, 62025101443, 62025116289, 62026482176, 62027604225,
  62029184129, 62029487683, 62029492097, 62030352962, 62031088704,
];

function pool(prefix) {
  return new Pool({
    host: process.env[`${prefix}_HOST`],
    port: Number(process.env[`${prefix}_PORT`] || 5432),
    database: process.env[`${prefix}_NAME`],
    user: process.env[`${prefix}_USER`],
    password: process.env[`${prefix}_PASSWORD`],
    ssl: String(process.env[`${prefix}_SSL`] || "").toLowerCase() === "require"
      ? { rejectUnauthorized: false }
      : false,
    max: 2,
  });
}

const appDb = pool("DB");
const skladDb = pool("SKLAD_DB");

function asInt(value) {
  return Number.parseInt(String(value || 0), 10) || 0;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function loadPlan() {
  const result = await appDb.query(
    `select o.order_id,
            o.local_state,
            o.stock_writeoff_status,
            i.item_id,
            i.offer_id,
            i.warehouse_product_id,
            i.quantity,
            i.picked_qty,
            i.stock_picked_qty,
            i.packed_qty
       from ym_orders o
       join ym_order_items i on i.order_id = o.order_id
      where o.order_id = any($1::bigint[])
      order by o.order_id, i.item_id`,
    [ORDER_IDS]
  );
  const rows = result.rows || [];
  const orderCount = new Set(rows.map((row) => String(row.order_id))).size;
  const unitCount = rows.reduce((sum, row) => sum + asInt(row.quantity), 0);
  assert(orderCount === EXPECTED_ORDERS, `Expected ${EXPECTED_ORDERS} orders, found ${orderCount}`);
  assert(rows.length === EXPECTED_LINES, `Expected ${EXPECTED_LINES} lines, found ${rows.length}`);
  assert(unitCount === EXPECTED_UNITS, `Expected ${EXPECTED_UNITS} units, found ${unitCount}`);
  assert(rows.every((row) => asInt(row.warehouse_product_id) > 0), "Some Yandex lines have no warehouse product mapping");

  const pendingRows = rows.filter((row) => row.stock_writeoff_status !== "done");
  const byProduct = new Map();
  for (const row of pendingRows) {
    const productId = asInt(row.warehouse_product_id);
    const target = byProduct.get(productId) || {
      productId,
      required: 0,
      alreadyMoved: 0,
      missing: 0,
      offers: new Set(),
    };
    const required = asInt(row.quantity);
    const alreadyMoved = Math.min(required, asInt(row.stock_picked_qty));
    target.required += required;
    target.alreadyMoved += alreadyMoved;
    target.missing += required - alreadyMoved;
    target.offers.add(String(row.offer_id || ""));
    byProduct.set(productId, target);
  }
  return {
    rows,
    pendingRows,
    products: [...byProduct.values()].map((entry) => ({
      ...entry,
      offers: [...entry.offers].filter(Boolean),
    })),
    summary: {
      orders: orderCount,
      lines: rows.length,
      units: unitCount,
      alreadyCompletedUnits: rows
        .filter((row) => row.stock_writeoff_status === "done")
        .reduce((sum, row) => sum + asInt(row.quantity), 0),
      pendingUnits: pendingRows.reduce((sum, row) => sum + asInt(row.quantity), 0),
      alreadyMovedPendingUnits: pendingRows.reduce((sum, row) => sum + Math.min(asInt(row.quantity), asInt(row.stock_picked_qty)), 0),
      missingShelfUnits: pendingRows.reduce((sum, row) => sum + Math.max(0, asInt(row.quantity) - asInt(row.stock_picked_qty)), 0),
    },
  };
}

async function loadWarehouseContext(client, productIds) {
  const products = await client.query(
    `select id, article, name, entity_type
       from products_s
      where id = any($1::int[]) and coalesce(archived, false) = false`,
    [productIds]
  );
  assert(products.rowCount === productIds.length, "Some mapped warehouse products are missing or archived");
  assert(
    products.rows.every((row) => String(row.entity_type || "").toLowerCase() !== "bundle"),
    "The shipment contains a bundle; component expansion is required before reconciliation"
  );
  const actor = await client.query(
    `select e.id as employee_id, e.full_name, u.id as user_id
       from employees_s e
       join users_s u on u.employee_id = e.id and coalesce(u.active, true) = true
      where e.external_employee_id = $1 and coalesce(e.active, true) = true
      order by u.id
      limit 1`,
    [EXTERNAL_EMPLOYEE_ID]
  );
  assert(actor.rowCount === 1, "Warehouse employee for reconciliation is not configured");
  return {
    products: new Map(products.rows.map((row) => [asInt(row.id), row])),
    employeeId: asInt(actor.rows[0].employee_id),
    userId: asInt(actor.rows[0].user_id),
    employeeName: actor.rows[0].full_name,
  };
}

async function listStockRows(client, productId) {
  const result = await client.query(
    `select * from (
       select 'shelf_box'::text as location_type,
              sb.shelf_id,
              sbi.shelf_box_id,
              sbi.id as item_id,
              sbi.product_id,
              sbi.quantity,
              coalesce(nullif(btrim(sb.name), ''), concat(coalesce(s.code, s.name, s.id::text), 'K', coalesce(sb.position::text, sb.id::text))) as cell_name,
              r.number as rack_number,
              s.number as shelf_number
         from shelf_box_items_s sbi
         join shelf_boxes_s sb on sb.id = sbi.shelf_box_id
         join shelves_s s on s.id = sb.shelf_id
         join racks_s r on r.id = s.rack_id
        where r.warehouse_id = $1 and sbi.product_id = $2
       union all
       select 'shelf'::text as location_type,
              si.shelf_id,
              null::int as shelf_box_id,
              si.id as item_id,
              si.product_id,
              si.quantity,
              coalesce(nullif(btrim(s.code), ''), nullif(btrim(s.name), ''), s.id::text) as cell_name,
              r.number as rack_number,
              s.number as shelf_number
         from shelf_items_s si
         join shelves_s s on s.id = si.shelf_id
         join racks_s r on r.id = s.rack_id
        where r.warehouse_id = $1 and si.product_id = $2
          and (coalesce(s.uses_boxes, false) = false or not exists (
            select 1 from shelf_box_items_s sbi
            join shelf_boxes_s sb on sb.id = sbi.shelf_box_id
            where sb.shelf_id = si.shelf_id and sbi.product_id = si.product_id and sbi.quantity > 0
          ))
     ) stock
     order by rack_number nulls last, shelf_number nulls last, cell_name, item_id`,
    [WAREHOUSE_ID, productId]
  );
  return result.rows || [];
}

async function inspectWarehouse(plan) {
  const client = await skladDb.connect();
  try {
    const productIds = plan.products.map((entry) => entry.productId);
    const context = await loadWarehouseContext(client, productIds);
    const marker = await client.query("select count(*)::int as count from movements_s where source = $1", [SOURCE]);
    const inventory = await client.query(
      `select product_id, quantity
         from employee_inventory_s
        where employee_id = $1 and product_id = any($2::int[])`,
      [context.employeeId, productIds]
    );
    const inventoryByProduct = new Map(inventory.rows.map((row) => [asInt(row.product_id), Number(row.quantity || 0)]));
    const products = [];
    for (const entry of plan.products) {
      const stockRows = await listStockRows(client, entry.productId);
      const available = stockRows.reduce((sum, row) => sum + Math.max(0, Number(row.quantity || 0)), 0);
      const meta = context.products.get(entry.productId);
      products.push({
        ...entry,
        article: meta.article,
        name: meta.name,
        available,
        after: available - entry.missing,
        employeeInventory: inventoryByProduct.get(entry.productId) || 0,
        employeeCleanup: Math.min(entry.alreadyMoved, Math.max(0, inventoryByProduct.get(entry.productId) || 0)),
      });
    }
    assert(products.every((entry) => entry.after >= 0), "Not enough positive shelf stock for the manual shipment reconciliation");
    return {
      markerRows: asInt(marker.rows[0]?.count),
      employeeId: context.employeeId,
      employeeName: context.employeeName,
      products,
    };
  } finally {
    client.release();
  }
}

async function applyWarehouse(plan) {
  const client = await skladDb.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [SOURCE]);
    const existing = await client.query("select count(*)::int as count from movements_s where source = $1", [SOURCE]);
    if (asInt(existing.rows[0]?.count) > 0) {
      await client.query("commit");
      return { idempotent: true, shelfWrittenOff: 0, employeeCleaned: 0, employeeCleanupSkipped: 0 };
    }

    const context = await loadWarehouseContext(client, plan.products.map((entry) => entry.productId));
    let shelfWrittenOff = 0;
    let employeeCleaned = 0;
    let employeeCleanupSkipped = 0;
    for (const entry of plan.products) {
      const meta = context.products.get(entry.productId);
      let remaining = entry.missing;
      const stockRows = await listStockRows(client, entry.productId);
      const available = stockRows.reduce((sum, row) => sum + Math.max(0, Number(row.quantity || 0)), 0);
      assert(available >= remaining, `${meta.article}: required ${remaining}, available ${available}`);
      for (const row of stockRows) {
        if (remaining <= 0) break;
        const before = Number(row.quantity || 0);
        if (before <= 0) continue;
        const delta = Math.min(remaining, before);
        const after = before - delta;
        const updated = row.location_type === "shelf_box"
          ? await client.query(
              "update shelf_box_items_s set quantity = quantity - $2, updated_at = now() where id = $1 and quantity >= $2 returning quantity",
              [row.item_id, delta]
            )
          : await client.query(
              "update shelf_items_s set quantity = quantity - $2, updated_by = $3, updated_at = now() where id = $1 and quantity >= $2 returning quantity",
              [row.item_id, delta, context.userId]
            );
        assert(updated.rowCount === 1 && Number(updated.rows[0].quantity) === after, `${meta.article}: stock changed concurrently in ${row.cell_name}`);
        const notes = `Яндекс Маркет: ручная сборка отгрузки ${SHIPMENT_ID}, ${meta.article}, ${delta} шт.`;
        await client.query(
          `insert into shelf_movements_s
            (shelf_id, product_id, operation_type, quantity_before, quantity_after, quantity_delta, user_id, notes, source, created_at)
           values ($1, $2, 'stock_out', $3, $4, $5, $6, $7, $8, now())`,
          [row.shelf_id, entry.productId, before, after, -delta, context.userId, notes, SOURCE]
        );
        await client.query(
          `insert into movements_s
            (movement_type, product_id, quantity, from_shelf_id, from_shelf_box_id, performed_by, notes, source, quantity_before, quantity_after, created_at)
           values ('stock_out', $1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
          [entry.productId, delta, row.shelf_id, row.shelf_box_id, context.userId, notes, SOURCE, before, after]
        );
        remaining -= delta;
        shelfWrittenOff += delta;
      }
      assert(remaining === 0, `${meta.article}: shelf write-off is incomplete`);

      if (entry.alreadyMoved > 0) {
        const inventory = await client.query(
          `select id, quantity from employee_inventory_s
            where employee_id = $1 and product_id = $2 for update`,
          [context.employeeId, entry.productId]
        );
        const before = Number(inventory.rows[0]?.quantity || 0);
        const cleanup = Math.min(entry.alreadyMoved, Math.max(0, before));
        if (cleanup > 0) {
          const after = before - cleanup;
          await client.query("update employee_inventory_s set quantity = $2, updated_at = now() where id = $1", [inventory.rows[0].id, after]);
          await client.query(
            `insert into movements_s
              (movement_type, product_id, quantity, from_employee_id, performed_by, notes, source, quantity_before, quantity_after, created_at)
             values ('employee_writeoff', $1, $2, $3, $4, $5, $6, $7, $8, now())`,
            [entry.productId, cleanup, context.employeeId, context.userId, `Яндекс Маркет: закрытие ранее перемещённого товара отгрузки ${SHIPMENT_ID}, ${meta.article}.`, SOURCE, before, after]
          );
          employeeCleaned += cleanup;
        }
        employeeCleanupSkipped += entry.alreadyMoved - cleanup;
      }
    }
    await client.query("commit");
    return { idempotent: false, shelfWrittenOff, employeeCleaned, employeeCleanupSkipped };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function applyApplicationState() {
  const client = await appDb.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [SOURCE]);
    await client.query(
      `update ym_order_items
          set picked_qty = quantity,
              packed_qty = quantity,
              stock_picked_qty = quantity
        where order_id = any($1::bigint[])`,
      [ORDER_IDS]
    );
    await client.query(
      `update ym_orders
          set stock_writeoff_status = 'done',
              updated_at = now()
        where order_id = any($1::bigint[])`,
      [ORDER_IDS]
    );
    await client.query(
      `insert into ym_audit_log (user_id, action, entity_type, entity_id, details, created_at)
       values (null, 'manual_shipment_stock_reconcile', 'shipment', $1, $2::jsonb, now())`,
      [SHIPMENT_ID, JSON.stringify({ source: SOURCE, orders: EXPECTED_ORDERS, lines: EXPECTED_LINES, units: EXPECTED_UNITS })]
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function verify() {
  const plan = await loadPlan();
  const marker = await skladDb.query(
    `select movement_type, count(*)::int as rows, coalesce(sum(quantity), 0)::numeric as quantity
       from movements_s where source = $1 group by movement_type order by movement_type`,
    [SOURCE]
  );
  return { plan: plan.summary, movements: marker.rows };
}

try {
  const plan = await loadPlan();
  const warehouse = await inspectWarehouse(plan);
  const report = {
    mode: APPLY ? "apply" : "dry-run",
    shipmentId: SHIPMENT_ID,
    source: SOURCE,
    plan: plan.summary,
    warehouse: {
      markerRows: warehouse.markerRows,
      employeeId: warehouse.employeeId,
      employeeName: warehouse.employeeName,
      missingShelfUnits: warehouse.products.reduce((sum, entry) => sum + entry.missing, 0),
      employeeCleanupUnits: warehouse.products.reduce((sum, entry) => sum + entry.employeeCleanup, 0),
      employeeCleanupUnavailableUnits: warehouse.products.reduce((sum, entry) => sum + entry.alreadyMoved - entry.employeeCleanup, 0),
      products: warehouse.products,
    },
  };
  if (APPLY) {
    report.applied = await applyWarehouse(plan);
    await applyApplicationState();
    report.verification = await verify();
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await Promise.allSettled([appDb.end(), skladDb.end()]);
}
