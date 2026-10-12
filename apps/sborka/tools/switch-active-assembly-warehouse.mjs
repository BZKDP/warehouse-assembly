import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

const root = "/opt/grasklad-sborka";
const assemblyId = process.env.ASSEMBLY_ID || "ozon-1788938618628-293f44";
const fromWarehouseId = 38;
const toWarehouseId = 46;
const toWarehouseName = "FBS МОСКВА";

for (const raw of fs.readFileSync(path.join(root, ".env"), "utf8").split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) continue;
  const i = line.indexOf("=");
  if (i < 1) continue;
  const key = line.slice(0, i).trim();
  let value = line.slice(i + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  if (!process.env[key]) process.env[key] = value;
}

const db = new Client({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: String(process.env.DB_SSL || "disable").toLowerCase() === "disable" ? false : { rejectUnauthorized: false },
});

await db.connect();
try {
  await db.query("begin");
  await db.query("select pg_advisory_xact_lock(hashtext($1))", [`assembly-warehouse:${assemblyId}`]);
  const currentResult = await db.query("select * from ozon_assemblies where id=$1 for update", [assemblyId]);
  const current = currentResult.rows[0];
  if (!current) throw new Error(`Assembly not found: ${assemblyId}`);

  const sessions = (await db.query(
    `select * from ozon_employee_assembly_sessions where assembly_id=$1 order by id`,
    [assemblyId]
  )).rows;
  const pickSummary = (await db.query(
    `select count(*)::int rows, coalesce(sum(required_qty),0)::int required,
            coalesce(sum(picked_qty),0)::int picked, max(updated_at) last_pick_at
       from ozon_employee_assembly_pick_items where assembly_id=$1`,
    [assemblyId]
  )).rows[0];
  const backup = {
    createdAt: new Date().toISOString(),
    action: "switch-active-assembly-warehouse",
    assembly: current,
    sessions,
    pickSummary,
  };
  const backupBody = JSON.stringify(backup, null, 2);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(root, "backups", `assembly-${assemblyId}-before-fbs46-${stamp}.json`);
  fs.writeFileSync(backupPath, backupBody, { mode: 0o600 });

  const currentWarehouseId = Number(current.sklad_warehouse_id || 0);
  if (currentWarehouseId !== toWarehouseId) {
    if (currentWarehouseId !== fromWarehouseId) {
      throw new Error(`Unexpected current warehouse ${currentWarehouseId}; expected ${fromWarehouseId}`);
    }
    await db.query(
      `update ozon_assemblies
          set sklad_warehouse_id=$2, sklad_warehouse_name=$3, updated_at=now()
        where id=$1`,
      [assemblyId, toWarehouseId, toWarehouseName]
    );
  }
  const verified = (await db.query(
    `select id,name,store_name,sklad_warehouse_id,sklad_warehouse_name,
            stock_method_enabled,allow_stock_shortage,product_picking_started_at,updated_at
       from ozon_assemblies where id=$1`,
    [assemblyId]
  )).rows[0];
  await db.query("commit");
  console.log(JSON.stringify({
    ok: true,
    changed: currentWarehouseId !== toWarehouseId,
    backupPath,
    backupSha256: crypto.createHash("sha256").update(backupBody).digest("hex"),
    pickSummary,
    verified,
  }, null, 2));
} catch (error) {
  await db.query("rollback").catch(() => {});
  throw error;
} finally {
  await db.end();
}
