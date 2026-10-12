import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

const root = "/opt/grasklad-sborka";
const mappings = [
  { article: "GRA-08540", barcodes: ["OZN2862917698", "2862917698"] },
  { article: "GRA-04730", barcodes: ["0771752731008", "2562732843037"] },
  { article: "GRA-08090", barcodes: ["5797481510900"] },
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

const normalize = (value) => String(value || "").replace(/\s+/g, "").toUpperCase();
const db = new Client({
  host: process.env.SKLAD_DB_HOST,
  port: Number(process.env.SKLAD_DB_PORT || 5432),
  database: process.env.SKLAD_DB_NAME,
  user: process.env.SKLAD_DB_USER,
  password: process.env.SKLAD_DB_PASSWORD,
  ssl: String(process.env.SKLAD_DB_SSL || "disable").toLowerCase() === "disable" ? false : { rejectUnauthorized: false },
});

await db.connect();
let backupPath = "";
try {
  await db.query("begin");
  await db.query("select pg_advisory_xact_lock(hashtext('fix-night-link-problems-20260910'))");
  const products = (await db.query(
    `select id, article, code, name, barcode_list, marketplace_barcodes_json, coalesce(archived, false) archived
       from products_s
      where upper(trim(article)) = any($1::text[])
      order by article, id
      for update`,
    [mappings.map((item) => item.article)]
  )).rows;
  const byArticle = new Map();
  for (const row of products) {
    const key = String(row.article).trim().toUpperCase();
    const list = byArticle.get(key) || [];
    list.push(row);
    byArticle.set(key, list);
  }
  for (const mapping of mappings) {
    const rows = byArticle.get(mapping.article) || [];
    if (rows.length !== 1) throw new Error(`${mapping.article}: найдено карточек ${rows.length}`);
    if (rows[0].archived) throw new Error(`${mapping.article}: карточка архивная`);
  }

  const backupBody = JSON.stringify({ createdAt: new Date().toISOString(), mappings, products }, null, 2);
  backupPath = path.join(root, "backups", `night-link-fix-before-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(backupPath, backupBody, { mode: 0o600 });

  const changed = [];
  for (const mapping of mappings) {
    const product = byArticle.get(mapping.article)[0];
    const values = String(product.barcode_list || "").split(/[;,\r\n]+/).map((value) => value.trim()).filter(Boolean);
    const existing = new Set(values.map(normalize));
    const added = [];
    for (const barcode of mapping.barcodes) {
      if (!existing.has(normalize(barcode))) {
        values.push(barcode);
        existing.add(normalize(barcode));
        added.push(barcode);
      }
    }
    if (added.length) {
      await db.query("update products_s set barcode_list = $2, updated_at = now() where id = $1", [Number(product.id), values.join(";")]);
    }
    changed.push({ productId: Number(product.id), article: mapping.article, name: product.name, added });
  }
  await db.query("commit");

  const [ozModule, wbModule] = await Promise.all([
    import(path.join(root, "apps/OZ/server/services/sklad-movements.mjs")),
    import(path.join(root, "apps/WB/server/services/sklad-movements.mjs")),
  ]);
  const tokens = mappings.flatMap((item) => item.barcodes);
  const [ozResolved, wbResolved] = await Promise.all([
    ozModule.resolveWarehouseProductMeta(tokens),
    wbModule.resolveWarehouseProductMeta(tokens),
  ]);
  const verification = mappings.flatMap((mapping) => mapping.barcodes.map((barcode) => {
    const expectedProductId = Number(byArticle.get(mapping.article)[0].id);
    const ozProductId = Number(ozResolved.get(normalize(barcode))?.id || 0);
    const wbHit = wbResolved.get(normalize(barcode));
    return {
      barcode,
      expected: mapping.article,
      expectedProductId,
      ozProductId,
      wbResolved: Boolean(wbHit),
      ok: ozProductId === expectedProductId && Boolean(wbHit),
    };
  }));
  if (verification.some((item) => !item.ok)) throw new Error("Проверка связей после сохранения не прошла");
  console.log(JSON.stringify({
    ok: true,
    backupPath,
    backupSha256: crypto.createHash("sha256").update(backupBody).digest("hex"),
    changed,
    verification,
  }, null, 2));
} catch (error) {
  await db.query("rollback").catch(() => {});
  throw error;
} finally {
  await db.end();
}
