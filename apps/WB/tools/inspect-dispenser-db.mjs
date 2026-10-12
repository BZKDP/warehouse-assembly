import fs from "node:fs";

if (process.env.SERVER_PID) {
  const entries = fs.readFileSync(`/proc/${process.env.SERVER_PID}/environ`, "utf8").split("\0");
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator > 0) process.env[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
}

const { Pool } = await import("pg");
const {
  SKLAD_DB_HOST,
  SKLAD_DB_NAME,
  SKLAD_DB_PASSWORD,
  SKLAD_DB_PORT,
  SKLAD_DB_SSL,
  SKLAD_DB_USER,
} = await import("../server/config.mjs");

const ssl = SKLAD_DB_SSL === "require" ? { rejectUnauthorized: false } : false;
const pool = new Pool({
  host: SKLAD_DB_HOST,
  port: SKLAD_DB_PORT,
  user: SKLAD_DB_USER,
  password: SKLAD_DB_PASSWORD,
  database: SKLAD_DB_NAME,
  ssl,
  max: 1,
});

try {
  const result = await pool.query(
    `select w.id,
            w.name,
            r.id as rack_id,
            r.number as rack_number,
            s.id as shelf_id,
            s.name as shelf_name,
            s.number as shelf_number,
            sb.id as box_id,
            sb.name as box_name,
            sb.position,
            sb.product_id as box_product_id,
            sb.quantity as box_quantity,
            sbi.product_id as item_product_id,
            sbi.quantity as item_quantity,
            p.article,
            p.name as product_name
       from warehouses_s w
       left join racks_s r on r.warehouse_id = w.id
       left join shelves_s s on s.rack_id = r.id
       left join shelf_boxes_s sb on sb.shelf_id = s.id
       left join shelf_box_items_s sbi on sbi.shelf_box_id = sb.id
       left join products_s p on p.id = coalesce(sbi.product_id, sb.product_id)
      where lower(btrim(w.name)) = lower('Дозатор')
      order by r.number, s.number, sb.position, sb.id, sbi.product_id`,
    []
  );
  console.log(JSON.stringify(result.rows || [], null, 2));
} finally {
  await pool.end();
}
