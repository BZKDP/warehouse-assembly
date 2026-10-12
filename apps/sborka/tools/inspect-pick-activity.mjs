import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

const root = "/opt/grasklad-sborka";
const startAt = process.env.RECONCILE_START || "2026-09-08T00:00:00+03:00";
const endAt = process.env.RECONCILE_END || new Date().toISOString();

function loadEnv(filePath) {
  for (const raw of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx < 1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!process.env[key]) process.env[key] = value;
  }
}

function config(prefix = "") {
  const k = (name) => prefix ? `${prefix}_${name}` : name;
  return {
    host: process.env[k("DB_HOST")], port: Number(process.env[k("DB_PORT")] || 5432),
    database: process.env[k("DB_NAME")], user: process.env[k("DB_USER")], password: process.env[k("DB_PASSWORD")],
    ssl: String(process.env[k("DB_SSL")] || "disable").toLowerCase() === "disable" ? false : { rejectUnauthorized: false },
  };
}

loadEnv(path.join(root, ".env"));
const app = new Client(config());
const sklad = new Client(config("SKLAD"));
await Promise.all([app.connect(), sklad.connect()]);
try {
  const user = (await app.query("select id, external_employee_id from users where lower(external_login)='stag1' limit 1")).rows[0];
  const userId = Number(user.id), externalEmployeeId = Number(user.external_employee_id);
  const oz = await app.query(
    `select pi.assembly_id, a.name, a.store_name, a.sklad_warehouse_id, a.stock_method_enabled, a.allow_stock_shortage,
            s.id as session_id, s.picking_started_at, s.picking_finished_at, s.status as session_status,
            pi.id as pick_item_id, pi.article, pi.barcode, pi.product_name, pi.required_qty, pi.picked_qty, pi.updated_at
       from ozon_employee_assembly_pick_items pi
       join ozon_employee_assembly_sessions s on s.id=pi.session_id
       join ozon_assemblies a on a.id=pi.assembly_id
      where pi.user_id=$1 and pi.picked_qty>0
        and coalesce(s.picking_started_at, pi.updated_at) >= $2::timestamptz
        and coalesce(s.picking_started_at, pi.updated_at) < $3::timestamptz
      order by s.picking_started_at, pi.assembly_id, pi.id`,
    [userId, startAt, endAt]
  );
  const wb = await app.query(
    `select pi.supply_id, ss.supply_name, ss.store_name, ss.sklad_warehouse_id, ss.stock_method_enabled, ss.allow_stock_shortage,
            s.id as session_id, s.picking_started_at, s.picking_finished_at, s.status as session_status,
            pi.id as pick_item_id, pi.article, pi.barcode, pi.product_name, pi.required_qty, pi.picked_qty, pi.updated_at
       from employee_supply_pick_items pi
       join employee_supply_sessions s on s.id=pi.session_id
       join supply_settings ss on ss.supply_id=pi.supply_id
      where pi.user_id=$1 and pi.picked_qty>0
        and coalesce(s.picking_started_at, pi.updated_at) >= $2::timestamptz
        and coalesce(s.picking_started_at, pi.updated_at) < $3::timestamptz
      order by s.picking_started_at, pi.supply_id, pi.id`,
    [userId, startAt, endAt]
  );
  const ym = await app.query(
    `select o.assembly_id, a.name, a.campaign_id, a.status, a.allow_zero_stock,
            o.order_id, o.local_state, o.ready_to_ship_at,
            i.item_id, i.offer_id as article, i.name as product_name, i.quantity, i.picked_qty, i.stock_picked_qty,
            i.warehouse_product_id
       from ym_orders o join ym_assemblies a on a.id=o.assembly_id join ym_order_items i on i.order_id=o.order_id
      where o.assigned_user_id=$1 and i.picked_qty>0
        and a.launched_at >= $2::timestamptz and a.launched_at < $3::timestamptz
      order by a.launched_at, o.order_id, i.item_id`,
    [userId, startAt, endAt]
  ).catch(() => ({ rows: [] }));
  const skippedOz = await app.query(
    `select stage, article, barcode, sum(skipped_quantity)::int as skipped
       from ozon_stock_shortage_skips
      where user_id=$1 and created_at >= $2::timestamptz and created_at < $3::timestamptz
      group by stage, article, barcode order by stage, article`,
    [userId, startAt, endAt]
  );
  const skippedWb = await app.query(
    `select stage, article, barcode, sum(skipped_quantity)::int as skipped
       from wb_stock_shortage_skips
      where user_id=$1 and created_at >= $2::timestamptz and created_at < $3::timestamptz
      group by stage, article, barcode order by stage, article`,
    [userId, startAt, endAt]
  );
  const employee = (await sklad.query("select id, full_name from employees_s where external_employee_id=$1 limit 1", [externalEmployeeId])).rows[0];
  const inventory = await sklad.query(
    `select p.id as product_id, p.article, p.name, i.quantity
       from employee_inventory_s i join products_s p on p.id=i.product_id
      where i.employee_id=$1 and i.quantity<>0 order by p.article`,
    [Number(employee?.id || 0)]
  );
  const out = {
    period: { startAt, endAt }, user: { userId, externalEmployeeId, skladEmployeeId: Number(employee?.id || 0), name: employee?.full_name },
    summary: {
      ozPickRows: oz.rows.length, ozPicked: oz.rows.reduce((s,r)=>s+Number(r.picked_qty||0),0),
      wbPickRows: wb.rows.length, wbPicked: wb.rows.reduce((s,r)=>s+Number(r.picked_qty||0),0),
      ymRows: ym.rows.length, ymPicked: ym.rows.reduce((s,r)=>s+Number(r.picked_qty||0),0),
      ymStockPicked: ym.rows.reduce((s,r)=>s+Number(r.stock_picked_qty||0),0),
      currentEmployeeInventory: inventory.rows.reduce((s,r)=>s+Number(r.quantity||0),0),
    },
    ozPickItems: oz.rows, wbPickItems: wb.rows, ymPickItems: ym.rows,
    skippedOz: skippedOz.rows, skippedWb: skippedWb.rows, employeeInventory: inventory.rows,
  };
  const outputPath = path.join(root, "backups", `stag1-pick-activity-${new Date().toISOString().replace(/[:.]/g,"-")}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ outputPath, summary: out.summary, skippedOz: out.skippedOz, skippedWb: out.skippedWb, employeeInventory: out.employeeInventory,
    ozEntities: [...new Map(oz.rows.map(r=>[r.assembly_id,{id:r.assembly_id,name:r.name,store:r.store_name,warehouseId:r.sklad_warehouse_id,stock:r.stock_method_enabled,allowShortage:r.allow_stock_shortage,started:r.picking_started_at,finished:r.picking_finished_at,status:r.session_status}])).values()],
    wbEntities: [...new Map(wb.rows.map(r=>[r.supply_id,{id:r.supply_id,name:r.supply_name,store:r.store_name,warehouseId:r.sklad_warehouse_id,stock:r.stock_method_enabled,allowShortage:r.allow_stock_shortage,started:r.picking_started_at,finished:r.picking_finished_at,status:r.session_status}])).values()] }, null, 2));
} finally {
  await Promise.allSettled([app.end(), sklad.end()]);
}
