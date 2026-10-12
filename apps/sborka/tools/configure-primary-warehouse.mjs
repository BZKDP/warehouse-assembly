import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

const root = "/opt/grasklad-sborka";
const targetId = 46;
const targetName = "FBS МОСКВА";

function parseEnv(filePath) {
  const data = {};
  for (const raw of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx < 1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    data[key] = value;
    if (!process.env[key]) process.env[key] = value;
  }
  return data;
}

function setEnvValue(filePath, key, value) {
  const before = fs.readFileSync(filePath, "utf8");
  const lines = before.split(/\r?\n/);
  let found = false;
  const output = lines.map(line => {
    if (!new RegExp(`^\\s*${key}\\s*=`).test(line)) return line;
    found = true;
    return `${key}=${value}`;
  });
  if (!found) output.push(`${key}=${value}`);
  const after = output.join("\n");
  fs.writeFileSync(filePath, after);
  return {
    changed: before !== after,
    beforeSha256: crypto.createHash("sha256").update(before).digest("hex"),
    afterSha256: crypto.createHash("sha256").update(after).digest("hex"),
  };
}

const envPath = path.join(root, ".env");
const ymEnvPath = path.join(root, ".env.yandex");
parseEnv(envPath);
if (fs.existsSync(ymEnvPath)) parseEnv(ymEnvPath);
const db = new Client({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432), database: process.env.DB_NAME,
  user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  ssl: String(process.env.DB_SSL || "disable").toLowerCase() === "disable" ? false : { rejectUnauthorized: false },
});
await db.connect();
try {
  const target = await db.query("select $1::int id, $2::text name", [targetId, targetName]);
  if (Number(target.rows[0]?.id) !== targetId) throw new Error("Target validation failed");
  const beforeMappings = await db.query(
    `select id,location_code,marketplace,store_id,marketplace_warehouse_id,marketplace_warehouse_name,
            sklad_warehouse_id,sklad_warehouse_name,active,updated_at
       from site_location_warehouse_settings
      where active=true and location_code='moscow' and marketplace in ('oz','wb')
      order by id`
  );
  const beforeOpenOz = await db.query(
    `select a.id,a.name,a.sklad_warehouse_id,a.sklad_warehouse_name,a.stock_method_enabled,a.allow_stock_shortage
       from ozon_assemblies a
      where a.created_at >= now()-interval '7 days' and a.location_code='moscow'
        and a.product_picking_started_at is null
        and exists(select 1 from ozon_assembly_orders o where o.assembly_id=a.id and o.collected_at is null)
      order by a.created_at`
  );
  const beforeOpenWb = await db.query(
    `select s.supply_id,s.supply_name,s.sklad_warehouse_id,s.sklad_warehouse_name,s.stock_method_enabled,s.allow_stock_shortage
       from supply_settings s
      where s.created_at >= now()-interval '7 days' and s.location_code='moscow'
        and s.product_picking_started_at is null
        and exists(select 1 from supply_orders o where o.supply_id=s.supply_id and o.collected_at is null)
      order by s.created_at`
  );
  const backup = {
    createdAt: new Date().toISOString(), targetWarehouse:{id:targetId,name:targetName},
    mappings: beforeMappings.rows, unstartedOzon: beforeOpenOz.rows, unstartedWb: beforeOpenWb.rows,
  };
  const backupPath = path.join(root,"backups",`primary-warehouse-before-${new Date().toISOString().replace(/[:.]/g,"-")}.json`);
  fs.writeFileSync(backupPath,JSON.stringify(backup,null,2));
  const backupSha256=crypto.createHash("sha256").update(fs.readFileSync(backupPath)).digest("hex");

  await db.query("begin");
  const mappings = await db.query(
    `update site_location_warehouse_settings
        set sklad_warehouse_id=$1,sklad_warehouse_name=$2,updated_at=now()
      where active=true and location_code='moscow' and marketplace in ('oz','wb')
      returning id,marketplace,store_id,marketplace_warehouse_id`, [targetId,targetName]
  );
  const oz = await db.query(
    `update ozon_assemblies a set sklad_warehouse_id=$1,sklad_warehouse_name=$2,updated_at=now()
      where a.created_at >= now()-interval '7 days' and a.location_code='moscow'
        and a.product_picking_started_at is null
        and exists(select 1 from ozon_assembly_orders o where o.assembly_id=a.id and o.collected_at is null)
      returning a.id,a.name`, [targetId,targetName]
  );
  const wb = await db.query(
    `update supply_settings s set sklad_warehouse_id=$1,sklad_warehouse_name=$2,updated_at=now()
      where s.created_at >= now()-interval '7 days' and s.location_code='moscow'
        and s.product_picking_started_at is null
        and exists(select 1 from supply_orders o where o.supply_id=s.supply_id and o.collected_at is null)
      returning s.supply_id,s.supply_name`, [targetId,targetName]
  );
  await db.query("commit");

  const envChanges = {
    skladId: setEnvValue(envPath,"SKLAD_FBS_WAREHOUSE_ID",String(targetId)),
    skladName: setEnvValue(envPath,"SKLAD_FBS_WAREHOUSE_NAME",targetName),
    yandexId: fs.existsSync(ymEnvPath) ? setEnvValue(ymEnvPath,"YANDEX_SKLAD_WAREHOUSE_ID",String(targetId)) : null,
  };
  const verification = await db.query(
    `select id,marketplace,store_id,marketplace_warehouse_id,sklad_warehouse_id,sklad_warehouse_name
       from site_location_warehouse_settings
      where active=true and location_code='moscow' and marketplace in ('oz','wb') order by id`
  );
  console.log(JSON.stringify({ok:true,backupPath,backupSha256,
    changed:{mappings:mappings.rowCount,unstartedOzon:oz.rowCount,unstartedWb:wb.rowCount,env:envChanges},
    unstartedUpdated:{oz:oz.rows,wb:wb.rows},verification:verification.rows},null,2));
} catch(error) {
  await db.query("rollback").catch(()=>{});
  throw error;
} finally { await db.end(); }
