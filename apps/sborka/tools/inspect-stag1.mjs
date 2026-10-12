import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

const root = "/opt/grasklad-sborka";

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

loadEnv(path.join(root, ".env"));
const app = new Client(dbConfig());
const sklad = new Client(dbConfig("SKLAD"));
await Promise.all([app.connect(), sklad.connect()]);

try {
  const user = await app.query(
    `select id, external_user_id, external_employee_id, external_login, external_full_name, surname, name, role, position
       from users
      where lower(coalesce(external_login, '')) = 'stag1'
      order by id`
  );
  console.log(JSON.stringify({ users: user.rows }, null, 2));

  const appTables = [
    "supply_orders",
    "employee_supply_sessions",
    "employee_supply_pick_items",
    "supply_settings",
    "ozon_assembly_orders",
    "ozon_assembly_order_items",
    "ozon_employee_assembly_sessions",
    "ozon_employee_assembly_pick_items",
    "ozon_assemblies",
  ];
  const columns = await app.query(
    `select table_name, column_name, data_type
       from information_schema.columns
      where table_schema = 'public' and table_name = any($1::text[])
      order by table_name, ordinal_position`,
    [appTables]
  );
  const grouped = {};
  for (const row of columns.rows) {
    (grouped[row.table_name] ||= []).push(`${row.column_name}:${row.data_type}`);
  }
  console.log(JSON.stringify({ appColumns: grouped }, null, 2));

  const skladTables = [
    "warehouses_s",
    "racks_s",
    "shelves_s",
    "shelf_boxes_s",
    "shelf_box_items_s",
    "shelf_items_s",
    "products_s",
    "movements_s",
    "shelf_movements_s",
    "employee_inventory_s",
    "employees_s",
    "sborka_live_events_s",
  ];
  const skladColumns = await sklad.query(
    `select table_name, column_name, data_type
       from information_schema.columns
      where table_schema = 'public' and table_name = any($1::text[])
      order by table_name, ordinal_position`,
    [skladTables]
  );
  const skladGrouped = {};
  for (const row of skladColumns.rows) {
    (skladGrouped[row.table_name] ||= []).push(`${row.column_name}:${row.data_type}`);
  }
  console.log(JSON.stringify({ skladColumns: skladGrouped }, null, 2));

  const warehouses = await sklad.query(
    `select w.id, w.name, count(distinct r.id)::int as racks, count(distinct s.id)::int as shelves,
            count(distinct sb.id)::int as boxes,
            coalesce(sum(sbi.quantity), 0)::int + coalesce(sum(si.quantity), 0)::int as rough_quantity
       from warehouses_s w
       left join racks_s r on r.warehouse_id = w.id
       left join shelves_s s on s.rack_id = r.id
       left join shelf_boxes_s sb on sb.shelf_id = s.id
       left join shelf_box_items_s sbi on sbi.shelf_box_id = sb.id
       left join shelf_items_s si on si.shelf_id = s.id
      where lower(w.name) like '%fbs%' or lower(w.name) like '%москва%'
      group by w.id, w.name
      order by w.id`
  );
  console.log(JSON.stringify({ warehouses: warehouses.rows }, null, 2));

  const mappings = await app.query(
    `select id, location_code, marketplace, store_id, marketplace_warehouse_id, marketplace_warehouse_name,
            sklad_warehouse_id, sklad_warehouse_name, active
       from site_location_warehouse_settings
      order by active desc, location_code, marketplace, store_id nulls first, id`
  );
  console.log(JSON.stringify({ mappings: mappings.rows }, null, 2));
} finally {
  await Promise.allSettled([app.end(), sklad.end()]);
}
