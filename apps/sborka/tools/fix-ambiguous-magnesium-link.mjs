import crypto from "node:crypto";
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

const aliases = new Set(["3556399759", "OZN3556399759"]);
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
  await db.query("select pg_advisory_xact_lock(hashtext('fix-ambiguous-magnesium-link-20260909'))");
  const rows = (await db.query(
    `select id, article, code, name, production_barcode, barcode_list, marketplace_barcodes_json
       from products_s
      where id in (40, 201)
      order by id
      for update`
  )).rows;
  const correct = rows.find((row) => Number(row.id) === 40);
  const wrong = rows.find((row) => Number(row.id) === 201);
  if (!correct || !wrong) throw new Error("Одна из проверяемых складских карточек не найдена");
  if (String(correct.article).trim().toUpperCase() !== "GRA-11500") throw new Error("ID 40 больше не соответствует GRA-11500");
  if (String(wrong.article).trim().toUpperCase() !== "GRA-11580") throw new Error("ID 201 больше не соответствует GRA-11580");

  const backupBody = JSON.stringify({ createdAt: new Date().toISOString(), aliases: [...aliases], rows }, null, 2);
  backupPath = path.join(root, "backups", `ambiguous-magnesium-link-before-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(backupPath, backupBody, { mode: 0o600 });

  const barcodeList = String(wrong.barcode_list || "").split(/[;,\r\n]+/).map((value) => value.trim()).filter(Boolean)
    .filter((value) => !aliases.has(normalize(value)));
  const marketplace = Array.isArray(wrong.marketplace_barcodes_json) ? wrong.marketplace_barcodes_json : [];
  const filteredMarketplace = marketplace.filter((entry) => {
    const value = entry && typeof entry === "object" ? entry.value : entry;
    return !aliases.has(normalize(value));
  });
  const productionBarcode = aliases.has(normalize(wrong.production_barcode)) ? null : wrong.production_barcode;

  await db.query(
    `update products_s
        set production_barcode = $2,
            barcode_list = $3,
            marketplace_barcodes_json = $4::jsonb,
            updated_at = now()
      where id = $1`,
    [Number(wrong.id), productionBarcode, barcodeList.join(";"), JSON.stringify(filteredMarketplace)]
  );

  const remainingWrong = (await db.query(
    `select exists (
       select 1 from products_s p
        where p.id = 201 and (
          upper(regexp_replace(coalesce(p.production_barcode, ''), '\\s+', '', 'g')) = any($1::text[])
          or exists (select 1 from regexp_split_to_table(coalesce(p.barcode_list, ''), ';') x(value)
                     where upper(regexp_replace(trim(x.value), '\\s+', '', 'g')) = any($1::text[]))
          or exists (select 1 from jsonb_array_elements(case when jsonb_typeof(coalesce(p.marketplace_barcodes_json, '[]'::jsonb)) = 'array' then coalesce(p.marketplace_barcodes_json, '[]'::jsonb) else '[]'::jsonb end) e
                     where upper(regexp_replace(coalesce(e->>'value', ''), '\\s+', '', 'g')) = any($1::text[]))
        )
     ) as found`,
    [[...aliases]]
  )).rows[0]?.found;
  if (remainingWrong) throw new Error("Штрихкод остался в ошибочной карточке");
  await db.query("commit");

  const { resolveWarehouseProductMeta } = await import(path.join(root, "apps/OZ/server/services/sklad-movements.mjs"));
  const resolved = await resolveWarehouseProductMeta(["3556399759"]);
  const hit = resolved.get("3556399759");
  if (Number(hit?.id) !== 40) throw new Error(`После исправления резолвер выбрал ID ${hit?.id || "null"} вместо 40`);
  console.log(JSON.stringify({
    ok: true,
    backupPath,
    backupSha256: crypto.createHash("sha256").update(backupBody).digest("hex"),
    removedFrom: { id: 201, article: "GRA-11580" },
    resolvesTo: { id: Number(hit.id), article: "GRA-11500", name: hit.name },
  }, null, 2));
} catch (error) {
  await db.query("rollback").catch(() => {});
  throw error;
} finally {
  await db.end();
}
