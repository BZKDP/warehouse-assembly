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
  host: process.env.SKLAD_DB_HOST, port: Number(process.env.SKLAD_DB_PORT || 5432), database: process.env.SKLAD_DB_NAME,
  user: process.env.SKLAD_DB_USER, password: process.env.SKLAD_DB_PASSWORD,
  ssl: String(process.env.SKLAD_DB_SSL || "disable").toLowerCase() === "disable" ? false : { rejectUnauthorized: false },
});
const searches = [
  ["selenium_zinc", ["селен", "цинк"]],
  ["q10", ["коэнзим", "q10"]],
  ["potassium_magnesium", ["калий", "магний"]],
  ["theanine_magnesium", ["теанин", "theanine"]],
  ["dihydroquercetin", ["дигидро"]],
  ["tyrosine", ["тирозин", "tyrosine"]],
  ["magnesium_citrate_d3", ["цитрат", "d3"]],
  ["monolaurin", ["монолаур"]],
  ["glucosamine", ["глюкозамин"]],
  ["hema_rete", ["hema", "гема"]],
  ["carnosine", ["карноз"]],
  ["taurine", ["таурин"]],
  ["lysine", ["лизин", "lysine"]],
  ["probiotic", ["пробиот"]],
  ["nmn_glutathione_nac", ["глутати"]],
  ["alpha_lipoic", ["липоевая"]],
  ["quercetin", ["кверц"]],
  ["glycine_choline", ["глицин", "холин"]],
  ["methylfolate", ["метилфол"]],
  ["biotin", ["биотин", "biotin"]],
  ["riboflavin", ["рибофлав"]],
  ["alginate", ["альгинат"]],
  ["berberine_curcumin", ["берберин", "куркумин"]],
  ["acetyl_carnitine", ["ацетил", "карнит"]],
  ["ginkgo_choline", ["гинкго", "готу кола"]],
];

await db.connect();
try {
  const products = (await db.query(`select id,article,code,name,entity_type,barcode_list,marketplace_barcodes_json
    from products_s where coalesce(archived,false)=false order by article,id`)).rows;
  const output = {};
  for (const [key, tokens] of searches) {
    output[key] = products.filter((row) => {
      const haystack = `${row.article || ""} ${row.code || ""} ${row.name || ""}`.toLocaleLowerCase("ru");
      return tokens.some((token) => haystack.includes(token));
    }).map((row) => ({
      id:Number(row.id), article:row.article, code:row.code, name:row.name, entityType:row.entity_type,
      barcodes:String(row.barcode_list || "").split(";").filter(Boolean), marketplace:row.marketplace_barcodes_json,
    }));
  }
  console.log(JSON.stringify(output, null, 2));
} finally {
  await db.end();
}
