import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

const root = "/opt/grasklad-sborka";
const mappings = [
  { platform: "wb", marketplaceId: "1705248299", sellerArticle: "GRA-01400_5", barcode: "1277226095182", article: "GRA-01400" },
  { platform: "wb", marketplaceId: "1705362437", sellerArticle: "GRA-07500_1", barcode: "7348637587253", article: "GRA-07500" },
  { platform: "wb", marketplaceId: "1705629990", sellerArticle: "GRA-04530_4", barcode: "9782494865044", article: "GRA-04530" },
  { platform: "wb", marketplaceId: "1705677498", sellerArticle: "GRA-00180_1", barcode: "4987249010792", article: "GRA-00180" },
  { platform: "wb", marketplaceId: "1705677793", sellerArticle: "GRA-00090_1", barcode: "2567271588715", article: "GRA-00090" },
  { platform: "wb", marketplaceId: "1705680685", sellerArticle: "GRA-00350_3", barcode: "1242476626981", article: "GRA-00350" },
  { platform: "wb", marketplaceId: "1707011728", sellerArticle: "GRA-08040_8", barcode: "0285383339279", article: "GRA-08040" },
  { platform: "wb", marketplaceId: "1707011880", sellerArticle: "GRA-04540_6", barcode: "7600699306013", article: "GRA-04540" },
  { platform: "wb", marketplaceId: "1707012014", sellerArticle: "GRA-04450_8", barcode: "5996937511151", article: "GRA-04450" },
  { platform: "wb", marketplaceId: "1707012017", sellerArticle: "GRA-09400_9", barcode: "2059872775194", article: "GRA-09400" },
  { platform: "wb", marketplaceId: "1707012447", sellerArticle: "GRA-08400_7", barcode: "2097118757993", article: "GRA-08400" },
  { platform: "wb", marketplaceId: "1707016461", sellerArticle: "GRA-00160_7", barcode: "3646207767482", article: "GRA-00160" },
  { platform: "wb", marketplaceId: "1707017125", sellerArticle: "GRA-08650_9", barcode: "2126212049199", article: "GRA-08650" },
  { platform: "wb", marketplaceId: "1707018095", sellerArticle: "GRA-11600_4", barcode: "3955571160370", article: "GRA-11600" },
  { platform: "wb", marketplaceId: "1707020000", sellerArticle: "GRA-04590_7", barcode: "6060858900253", article: "GRA-04590" },
  { platform: "ozon", marketplaceId: "5873566622", sellerArticle: "GRA-08040_5", barcode: "OZN5873566622", article: "GRA-08040" },
];

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

const splitBarcodes = (value) => String(value || "").split(/[;,\r\n]+/).map((item) => item.trim()).filter(Boolean);
const barcodeKey = (value) => String(value || "").replace(/\s+/g, "").toUpperCase();

await db.connect();
let backupPath = "";
try {
  await db.query("begin");
  await db.query("select pg_advisory_xact_lock(hashtext('link-marketplace-export-20260923-1443'))");

  const articles = [...new Set(mappings.map((row) => row.article))];
  const products = (await db.query(
    `select id, article, code, name, entity_type, production_barcode,
            barcode_list, marketplace_barcodes_json, coalesce(archived, false) archived
       from products_s
      where upper(trim(coalesce(article, ''))) = any($1::text[])
      order by article, id
      for update`,
    [articles],
  )).rows;

  const byArticle = new Map();
  for (const product of products) {
    const key = String(product.article || "").trim().toUpperCase();
    const list = byArticle.get(key) || [];
    list.push(product);
    byArticle.set(key, list);
  }
  for (const mapping of mappings) {
    const matches = byArticle.get(mapping.article) || [];
    if (matches.length !== 1) throw new Error(`${mapping.article}: найдено складских карточек ${matches.length}`);
    if (matches[0].archived) throw new Error(`${mapping.article}: складская карточка архивная`);
  }

  const requestedBarcodes = mappings.map((row) => row.barcode);
  const conflicts = (await db.query(
    `select id, article, name, barcode_list, marketplace_barcodes_json
       from products_s
      where exists (
        select 1
          from unnest($1::text[]) wanted(barcode)
         where upper(coalesce(barcode_list, '')) like '%' || upper(wanted.barcode) || '%'
            or upper(coalesce(marketplace_barcodes_json::text, '')) like '%' || upper(wanted.barcode) || '%'
      )
      for update`,
    [requestedBarcodes],
  )).rows;
  for (const conflict of conflicts) {
    const allowedProductIds = new Set(mappings
      .filter((mapping) => barcodeKey(conflict.barcode_list).includes(barcodeKey(mapping.barcode))
        || barcodeKey(JSON.stringify(conflict.marketplace_barcodes_json || [])).includes(barcodeKey(mapping.barcode)))
      .map((mapping) => Number(byArticle.get(mapping.article)[0].id)));
    if (!allowedProductIds.has(Number(conflict.id))) {
      throw new Error(`Штрихкод уже связан с другой карточкой ${conflict.article} (${conflict.id})`);
    }
  }

  const backup = JSON.stringify({ createdAt: new Date().toISOString(), mappings, products, conflicts }, null, 2);
  const backupDir = path.join(root, "backups", "marketplace-links");
  fs.mkdirSync(backupDir, { recursive: true });
  backupPath = path.join(backupDir, `warehouse-link-not_linked-20260923-1443-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(backupPath, backup, { mode: 0o600 });

  const changed = [];
  for (const mapping of mappings) {
    const product = byArticle.get(mapping.article)[0];
    const values = splitBarcodes(product.barcode_list);
    const keys = new Set(values.map(barcodeKey));
    const added = !keys.has(barcodeKey(mapping.barcode));
    if (added) {
      values.push(mapping.barcode);
      await db.query("update products_s set barcode_list = $2, updated_at = now() where id = $1", [Number(product.id), values.join(";")]);
      product.barcode_list = values.join(";");
    }
    changed.push({ ...mapping, productId: Number(product.id), productName: product.name, added });
  }

  await db.query("commit");

  const { resolveWarehouseProductMeta: resolveWb } = await import(path.join(root, "apps/WB/server/services/sklad-movements.mjs"));
  const { resolveWarehouseProductMeta: resolveOzon } = await import(path.join(root, "apps/OZ/server/services/sklad-movements.mjs"));
  const verification = [];
  for (const platform of ["wb", "ozon"]) {
    const platformMappings = mappings.filter((row) => row.platform === platform);
    const lookup = await (platform === "wb" ? resolveWb : resolveOzon)(platformMappings.map((row) => row.barcode));
    for (const mapping of platformMappings) {
      const expected = Number(byArticle.get(mapping.article)[0].id);
      const actual = Number(lookup.get(barcodeKey(mapping.barcode))?.id || 0);
      verification.push({ platform, marketplaceId: mapping.marketplaceId, barcode: mapping.barcode, article: mapping.article, expected, actual, ok: actual === expected });
    }
  }
  if (verification.some((row) => !row.ok)) throw new Error("Проверка связей после сохранения не прошла");

  console.log(JSON.stringify({
    ok: true,
    backupPath,
    backupSha256: crypto.createHash("sha256").update(backup).digest("hex"),
    total: mappings.length,
    added: changed.filter((row) => row.added).length,
    unchanged: changed.filter((row) => !row.added).length,
    changed,
    verification,
  }, null, 2));
} catch (error) {
  await db.query("rollback").catch(() => {});
  throw error;
} finally {
  await db.end();
}
