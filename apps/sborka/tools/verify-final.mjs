import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

const root = "/opt/grasklad-sborka";
for (const raw of fs.readFileSync(path.join(root, ".env"), "utf8").split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) continue;
  const i = line.indexOf("=");
  if (i < 1) continue;
  const key = line.slice(0, i).trim();
  let value = line.slice(i + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  if (!process.env[key]) process.env[key] = value;
}
const config = (prefix = "") => {
  const k = (key) => prefix ? `${prefix}_${key}` : key;
  return {
    host: process.env[k("DB_HOST")], port: Number(process.env[k("DB_PORT")] || 5432), database: process.env[k("DB_NAME")],
    user: process.env[k("DB_USER")], password: process.env[k("DB_PASSWORD")],
    ssl: String(process.env[k("DB_SSL")] || "disable").toLowerCase() === "disable" ? false : { rejectUnauthorized: false },
  };
};
const app = new Client(config());
const sklad = new Client(config("SKLAD"));
await Promise.all([app.connect(), sklad.connect()]);
try {
  const user = (await app.query("select id,external_employee_id,external_login from users where lower(external_login)='stag1' limit 1")).rows[0];
  const [oz, wb, mappings, activeAssembly] = await Promise.all([
    app.query(`select count(*)::int rows,coalesce(sum(pi.picked_qty),0)::int units
      from ozon_employee_assembly_pick_items pi join ozon_employee_assembly_sessions s on s.id=pi.session_id
      where pi.user_id=$1 and pi.picked_qty>0 and coalesce(s.picking_started_at,pi.updated_at)>='2026-09-08T00:00:00+03:00'`, [user.id]),
    app.query(`select count(*)::int rows,coalesce(sum(pi.picked_qty),0)::int units
      from employee_supply_pick_items pi join employee_supply_sessions s on s.id=pi.session_id
      where pi.user_id=$1 and pi.picked_qty>0 and coalesce(s.picking_started_at,pi.updated_at)>='2026-09-08T00:00:00+03:00'`, [user.id]),
    app.query(`select marketplace,store_id,marketplace_warehouse_id,sklad_warehouse_id,sklad_warehouse_name
      from site_location_warehouse_settings where active=true and location_code='moscow' and marketplace in ('oz','wb') order by marketplace,store_id,marketplace_warehouse_id`),
    app.query(`select id,name,store_name,sklad_warehouse_id,sklad_warehouse_name,stock_method_enabled,allow_stock_shortage,
      product_picking_started_at from ozon_assemblies where id='ozon-1788938618628-293f44'`),
  ]);
  const warehouse = (await sklad.query("select id,name from warehouses_s where id=46")).rows[0];
  const stock = (await sklad.query(`select
      (select coalesce(sum(sbi.quantity),0) from shelf_box_items_s sbi join shelf_boxes_s sb on sb.id=sbi.shelf_box_id join shelves_s s on s.id=sb.shelf_id join racks_s r on r.id=s.rack_id where r.warehouse_id=46)::numeric box_qty,
      (select coalesce(sum(si.quantity),0) from shelf_items_s si join shelves_s s on s.id=si.shelf_id join racks_s r on r.id=s.rack_id where r.warehouse_id=46 and (coalesce(s.uses_boxes,false)=false or not exists(select 1 from shelf_box_items_s x join shelf_boxes_s b on b.id=x.shelf_box_id where b.shelf_id=si.shelf_id and x.product_id=si.product_id and x.quantity>0)))::numeric shelf_qty,
      (select count(*) from shelf_box_items_s sbi join shelf_boxes_s sb on sb.id=sbi.shelf_box_id join shelves_s s on s.id=sb.shelf_id join racks_s r on r.id=s.rack_id where r.warehouse_id=46 and sbi.quantity<0)::int negative_box_rows,
      (select count(*) from shelf_items_s si join shelves_s s on s.id=si.shelf_id join racks_s r on r.id=s.rack_id where r.warehouse_id=46 and si.quantity<0)::int negative_shelf_rows`)).rows[0];
  const corrections = (await sklad.query(`select movement_type,count(*)::int rows,coalesce(sum(quantity),0)::numeric quantity
      from movements_s where source like 'recon_stag1_0908_w46_v%' group by movement_type order by movement_type`)).rows;
  console.log(JSON.stringify({
    checkedAt:new Date().toISOString(),
    configuredWarehouse:{envId:Number(process.env.SKLAD_FBS_WAREHOUSE_ID),envName:process.env.SKLAD_FBS_WAREHOUSE_NAME,warehouse},
    user,picks:{oz:oz.rows[0],wb:wb.rows[0]},mappings:mappings.rows,activeAssembly:activeAssembly.rows[0],stock,corrections,
  },null,2));
} finally {
  await Promise.allSettled([app.end(), sklad.end()]);
}
