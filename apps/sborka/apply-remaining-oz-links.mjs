import fs from "node:fs";
import { Pool } from "pg";

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnv(".env");
loadEnv("../../.env");

const sslMode = String(process.env.SKLAD_DB_SSL || process.env.AUTH_DB_SSL || "disable").toLowerCase();
const sklad = new Pool({
  host: process.env.SKLAD_DB_HOST || process.env.AUTH_DB_HOST,
  port: Number(process.env.SKLAD_DB_PORT || process.env.AUTH_DB_PORT || 5432),
  user: process.env.SKLAD_DB_USER || process.env.AUTH_DB_USER,
  password: String(process.env.SKLAD_DB_PASSWORD || process.env.AUTH_DB_PASSWORD || ""),
  database: process.env.SKLAD_DB_NAME || process.env.AUTH_DB_NAME,
  max: 1,
  ssl: sslMode === "disable" ? undefined : { rejectUnauthorized: false },
});

function splitBarcodes(value) {
  return String(value || "").split(/[;,\s]+/).map((x) => x.trim()).filter(Boolean);
}

function append(value, barcode) {
  const list = splitBarcodes(value);
  if (!list.includes(barcode)) list.push(barcode);
  return list.join(";");
}

const links = [
  { productId: 114, barcode: "3551538921", note: "GRA-00121 лактоферрин 120 капсул" },
  { productId: 111, barcode: "3551555198", note: "GRA-00692 фосфатидилсерин" },
  { productId: 106, barcode: "3556908360", note: "GRA-04432 куркумин с пиперином" },
  { productId: 6, barcode: "5698900048", note: "GRA-07790_2 метилфолат" },
  { productId: 45, barcode: "5700353736", note: "GRA-07910_2 collagen" },
  { productId: 91, barcode: "3556907838", note: "GRA-07962 карнозин + ресвератрол" },
  { productId: 44, barcode: "5697403428", note: "GRA-08110_7 D3K2" },
  { productId: 74, barcode: "5698726341", note: "GRA-09400_2 хром пиколинат" },
];

try {
  await sklad.query("begin");
  const applied = [];
  for (const link of links) {
    const current = await sklad.query(
      "select id, article, code, name, barcode_list from products_s where id = $1 for update",
      [link.productId],
    );
    const row = current.rows[0];
    if (!row) throw new Error(`product ${link.productId} not found`);
    const nextBarcodeList = append(row.barcode_list, link.barcode);
    await sklad.query(
      "update products_s set barcode_list = $2, updated_at = now() where id = $1",
      [link.productId, nextBarcodeList],
    );
    applied.push({ ...link, article: row.article, code: row.code, name: row.name });
  }
  await sklad.query("commit");
  console.log(JSON.stringify({ applied }, null, 2));
} catch (error) {
  await sklad.query("rollback").catch(() => {});
  throw error;
} finally {
  await sklad.end();
}
