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

const db = new Client({
  host: process.env.SKLAD_DB_HOST,
  port: Number(process.env.SKLAD_DB_PORT || 5432),
  database: process.env.SKLAD_DB_NAME,
  user: process.env.SKLAD_DB_USER,
  password: process.env.SKLAD_DB_PASSWORD,
  ssl: String(process.env.SKLAD_DB_SSL || "disable").toLowerCase() === "disable" ? false : { rejectUnauthorized: false },
});

await db.connect();
try {
  const warehouses = (await db.query(
    `select id,name,created_at,updated_at from warehouses_s
      where lower(name) like '%кутуз%' or id=46 order by id desc`
  )).rows;
  const details = [];
  for (const warehouse of warehouses) {
    const structure = (await db.query(
      `select r.id rack_id,r.name rack_name,s.id shelf_id,s.name shelf_name,
              coalesce(s.uses_boxes,false) uses_boxes,
              count(distinct b.id)::int boxes,
              count(distinct bi.product_id)::int products_in_boxes,
              coalesce(sum(bi.quantity),0)::numeric quantity_in_boxes
         from racks_s r
         left join shelves_s s on s.rack_id=r.id
         left join shelf_boxes_s b on b.shelf_id=s.id
         left join shelf_box_items_s bi on bi.shelf_box_id=b.id
        where r.warehouse_id=$1
        group by r.id,r.name,s.id,s.name,s.uses_boxes
        order by r.id,s.id`,
      [warehouse.id]
    )).rows;
    details.push({ warehouse, structure });
  }
  console.log(JSON.stringify({ warehouses: details }, null, 2));
} finally {
  await db.end();
}
