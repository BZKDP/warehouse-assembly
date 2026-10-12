import fs from "node:fs";

if (process.env.SERVER_PID) {
  const entries = fs.readFileSync(`/proc/${process.env.SERVER_PID}/environ`, "utf8").split("\0");
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator > 0) process.env[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
}

const { Pool } = await import("pg");
const { DB_HOST, DB_NAME, DB_PASSWORD, DB_PORT, DB_SSL, DB_USER } = await import("../server/config.mjs");
const pool = new Pool({
  host: DB_HOST,
  port: DB_PORT,
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
  ssl: DB_SSL === "require" ? { rejectUnauthorized: false } : false,
  max: 1,
});

try {
  const result = await pool.query(
    `select operation_token, supply_id, wb_order_id, employee_id, status, plan,
            error_message, started_at, finished_at, updated_at
       from wb_dispenser_operations
      order by created_at desc
      limit 20`
  );
  const reworks = await pool.query(
    `select operation_token, supply_id, wb_order_id, employee_id, status,
            error_message, started_at, finished_at
       from wb_dispenser_reworks
      order by created_at desc
      limit 20`
  );
  const clientLogs = await pool.query(
    `select event_id, severity, user_id, user_name, message, context,
            client_created_at, created_at
       from application_error_logs
      where source = 'wb-dispenser'
      order by created_at desc
      limit 30`
  );
  console.log(JSON.stringify({ operations: result.rows || [], reworks: reworks.rows || [], clientLogs: clientLogs.rows || [] }, null, 2));
} finally {
  await pool.end();
}
