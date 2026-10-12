import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const xlsxPath = process.argv[2];
const execute = process.argv.includes("--execute");

if (!xlsxPath) {
  throw new Error("Usage: node tools/link-marketplace-export-from-xlsx.mjs <xlsx> [--execute]");
}

const envPath = process.env.GRASKLAD_ENV_FILE || path.join(appRoot, ".env");
if (fs.existsSync(envPath)) {
  for (const raw of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index < 1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!process.env[key]) process.env[key] = value;
  }
}

const python = spawnSync("python", ["-c", `
import json, sys
from openpyxl import load_workbook
p=sys.argv[1]
wb=load_workbook(p, read_only=True, data_only=True)
ws=wb.active
rows=list(ws.iter_rows(values_only=True))
out=[]
for r in rows[1:]:
    if not r or len(r) < 8:
        continue
    platform=str(r[0] or '').strip().lower()
    marketplace_id=str(r[2] or '').strip()
    seller_article=str(r[4] or '').strip()
    barcode=str(r[6] or '').strip()
    article=str(r[7] or '').strip()
    if not article or article in ('—','-','0'):
        import re
        m=re.search(r'GRA-\\d+', seller_article.upper())
        if m:
            article=m.group(0)
    if platform == 'oz':
        platform = 'ozon'
    if not platform or platform in ('—','-') or not barcode or barcode in ('—','-') or not article or article in ('—','-','0'):
        continue
    out.append({
        'platform': platform,
        'marketplaceId': marketplace_id,
        'sellerArticle': seller_article,
        'barcode': barcode,
        'article': article.upper()
    })
print(json.dumps(out, ensure_ascii=False))
`, xlsxPath], { encoding: "utf8" });

if (python.status !== 0) {
  throw new Error(`Не удалось прочитать xlsx: ${python.stderr || python.stdout}`);
}

const rawMappings = JSON.parse(python.stdout);
const uniq = new Map();
for (const row of rawMappings) {
  uniq.set(`${row.article}|${row.barcode.replace(/\s+/g, "").toUpperCase()}`, row);
}
const mappings = [...uniq.values()];

const db = new Client({
  host: process.env.SKLAD_DB_HOST,
  port: Number(process.env.SKLAD_DB_PORT || 5432),
  database: process.env.SKLAD_DB_NAME,
  user: process.env.SKLAD_DB_USER,
  password: process.env.SKLAD_DB_PASSWORD,
  ssl: String(process.env.SKLAD_DB_SSL || "disable").toLowerCase() === "disable" ? false : { rejectUnauthorized: false },
});

const splitBarcodes = (value) => String(value || "").split(/[;,\r\n]+/).map((item) => item.trim()).filter(Boolean);
const key = (value) => String(value || "").replace(/\s+/g, "").toUpperCase();

await db.connect();
let backupPath = "";
try {
  await db.query("begin");
  await db.query("select pg_advisory_xact_lock(hashtext('link-marketplace-export-from-xlsx'))");

  const articles = [...new Set(mappings.map((row) => row.article))];
  const products = (await db.query(
    `select id, article, code, name, barcode_list, marketplace_barcodes_json, coalesce(archived, false) archived
       from products_s
      where upper(trim(coalesce(article, ''))) = any($1::text[])
      order by article, id
      for update`,
    [articles],
  )).rows;

  const byArticle = new Map();
  for (const product of products) {
    const productKey = String(product.article || "").trim().toUpperCase();
    const list = byArticle.get(productKey) || [];
    list.push(product);
    byArticle.set(productKey, list);
  }

  const missing = [];
  const ambiguous = [];
  for (const mapping of mappings) {
    const matches = (byArticle.get(mapping.article) || []).filter((product) => !product.archived);
    if (!matches.length) missing.push(mapping);
    if (matches.length > 1) ambiguous.push({ mapping, productIds: matches.map((product) => Number(product.id)) });
  }
  if (missing.length || ambiguous.length) {
    throw new Error(JSON.stringify({ missing: missing.slice(0, 30), missingCount: missing.length, ambiguous: ambiguous.slice(0, 30), ambiguousCount: ambiguous.length }, null, 2));
  }

  const barcodeKeys = new Set(mappings.map((row) => key(row.barcode)));
  const allCandidates = (await db.query(
    `select id, article, name, barcode_list, marketplace_barcodes_json
       from products_s
      where coalesce(barcode_list, '') <> ''
         or marketplace_barcodes_json is not null
      for update`,
  )).rows;

  for (const product of allCandidates) {
    const existing = [
      ...splitBarcodes(product.barcode_list),
      ...splitBarcodes(JSON.stringify(product.marketplace_barcodes_json || [])),
    ].map(key);
    const hit = existing.find((value) => barcodeKeys.has(value));
    if (!hit) continue;
    const allowed = mappings.some((mapping) => mapping.article === String(product.article || "").trim().toUpperCase() && key(mapping.barcode) === hit);
    if (!allowed) throw new Error(`Штрихкод ${hit} уже связан с другой карточкой ${product.article} (${product.id})`);
  }

  const backup = JSON.stringify({ createdAt: new Date().toISOString(), xlsxPath, mappings, products }, null, 2);
  const backupDir = path.join(appRoot, "backups", "marketplace-links");
  fs.mkdirSync(backupDir, { recursive: true });
  backupPath = path.join(backupDir, `warehouse-link-linked-20260924-1325-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(backupPath, backup, { mode: 0o600 });

  const changed = [];
  for (const mapping of mappings) {
    const product = byArticle.get(mapping.article).find((item) => !item.archived);
    const values = splitBarcodes(product.barcode_list);
    const keys = new Set(values.map(key));
    const added = !keys.has(key(mapping.barcode));
    if (added && execute) {
      values.push(mapping.barcode);
      await db.query("update products_s set barcode_list = $2, updated_at = now() where id = $1", [Number(product.id), values.join(";")]);
      product.barcode_list = values.join(";");
    }
    changed.push({ ...mapping, productId: Number(product.id), added });
  }

  if (execute) await db.query("commit");
  else await db.query("rollback");

  console.log(JSON.stringify({
    ok: true,
    execute,
    totalRows: rawMappings.length,
    totalUnique: mappings.length,
    added: changed.filter((row) => row.added).length,
    unchanged: changed.filter((row) => !row.added).length,
    backupPath: execute ? backupPath : null,
    backupSha256: execute ? crypto.createHash("sha256").update(backup).digest("hex") : null,
    changed,
  }, null, 2));
} catch (error) {
  await db.query("rollback").catch(() => {});
  throw error;
} finally {
  await db.end();
}
