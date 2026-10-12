import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

const root = "/opt/grasklad-sborka";
for (const raw of fs.readFileSync(path.join(root, ".env"), "utf8").split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) continue;
  const index = line.indexOf("=");
  if (index < 1) continue;
  const key = line.slice(0, index).trim();
  let value = line.slice(index + 1).trim();
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
  const result = await db.query(
    `select p.id, p.article, p.code, p.name, p.entity_type, p.production_barcode,
            p.barcode_list, p.marketplace_barcodes_json,
            coalesce((select sum(sbi.quantity) from shelf_box_items_s sbi where sbi.product_id = p.id), 0)::numeric as total_qty
       from products_s p
      where coalesce(p.archived, false) = false
        and (
          upper(coalesce(p.article, '')) similar to '%(08540|04730|08090|09800|11500|11580)%'
          or lower(coalesce(p.name, '')) similar to '%(йохимбин|перуанск|индол|карбинол|магний.*хелат|хелат.*магний|магний.*глицинат|глицинат.*магний)%'
        )
      order by p.article, p.id`
  );
  console.log(JSON.stringify(result.rows.map((row) => ({
    id: Number(row.id),
    article: row.article,
    code: row.code,
    name: row.name,
    entityType: row.entity_type,
    productionBarcode: row.production_barcode,
    barcodeList: row.barcode_list,
    marketplaceBarcodes: row.marketplace_barcodes_json,
    totalQty: Number(row.total_qty),
  })), null, 2));
} finally {
  await db.end();
}
