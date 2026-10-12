import fs from "node:fs";
import path from "node:path";
import { connectAuto, loadEnv, mainDbConfig, rootDir } from "./db-common.mjs";

loadEnv();

const migrationPath = path.join(rootDir, "migrations", "20260728_locations.sql");
const sql = fs.readFileSync(migrationPath, "utf8");
const pool = await connectAuto(mainDbConfig());

try {
  await pool.query(sql);
  const verify = await pool.query(
    `select
       to_regclass('public.site_locations') is not null as site_locations,
       to_regclass('public.site_location_warehouse_settings') is not null as site_location_warehouse_settings,
       to_regclass('public.site_settings_audit') is not null as site_settings_audit,
       exists (
         select 1 from information_schema.columns
         where table_schema = 'public' and table_name = 'users' and column_name = 'location_code'
       ) as users_location_code,
       exists (
         select 1 from information_schema.columns
         where table_schema = 'public' and table_name = 'supply_settings' and column_name = 'location_code'
       ) as supply_settings_location_code,
       exists (
         select 1 from information_schema.columns
         where table_schema = 'public' and table_name = 'ozon_assemblies' and column_name = 'location_code'
       ) as ozon_assemblies_location_code`
  );
  console.log(JSON.stringify({ migration: path.basename(migrationPath), verified: verify.rows[0] }, null, 2));
} finally {
  await pool.end();
}
