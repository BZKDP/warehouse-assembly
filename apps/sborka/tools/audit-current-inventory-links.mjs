import fs from "node:fs";
import { Client } from "pg";

const root = "/opt/grasklad-sborka";
for (const raw of fs.readFileSync(`${root}/.env`, "utf8").split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) continue;
  const index = line.indexOf("=");
  if (index < 1) continue;
  const key = line.slice(0, index).trim();
  let value = line.slice(index + 1).trim();
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
  const session = (await db.query(
    `select s.token
       from sessions s
       join users u on u.id = s.user_id
      where s.expires_at > now()
        and u.role in ('admin', 'super_admin')
      order by s.updated_at desc nulls last, s.created_at desc
      limit 1`
  )).rows[0];
  if (!session?.token) throw new Error("Нет активной административной сессии для read-only аудита");

  const response = await fetch("http://127.0.0.1:3008/sborka/api/inventory-links?force=1", {
    headers: { cookie: `${process.env.COOKIE_NAME || "sid"}=${session.token}` },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body?.error || "inventory links unavailable"}`);
  const unlinked = (body.items || []).filter((item) => !item.linked).map((item) => ({
    marketplace: item.marketplace,
    storeName: item.storeName,
    source: item.source,
    entityName: item.entityName,
    article: item.article,
    name: item.name,
    quantity: item.quantity,
    imageUrl: item.imageUrl,
    barcode: item.barcode,
    barcodes: item.barcodes,
  }));
  const ambiguous = (body.items || []).filter((item) => (item.warehouseMatches || []).length > 1).map((item) => ({
    marketplace: item.marketplace,
    storeName: item.storeName,
    source: item.source,
    entityName: item.entityName,
    article: item.article,
    name: item.name,
    barcodes: item.barcodes,
    warehouseMatches: item.warehouseMatches,
  }));
  const errors = (await db.query(
    `select created_at, source, severity, marketplace, user_name, request_path, http_status, message, context
       from application_error_logs
      where created_at >= now() - interval '3 hours'
        and (
          severity in ('error', 'warning')
          or request_path ~* '(pick|scan|collect|assembl|suppl)'
          or message ~* '(barcode|warehouse|штрих|товар|связ)'
        )
      order by created_at desc
      limit 80`
  )).rows;
  console.log(JSON.stringify({ summary: body.summary, warnings: body.warnings, unlinked, ambiguous, recentRelevantErrors: errors }, null, 2));
} finally {
  await db.end();
}
