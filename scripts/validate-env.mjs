import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(rootDir, ".env");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
  return true;
}

const required = [
  "DB_HOST",
  "DB_PORT",
  "DB_NAME",
  "DB_USER",
  "DB_PASSWORD",
  "AUTH_DB_HOST",
  "AUTH_DB_PORT",
  "AUTH_DB_NAME",
  "AUTH_DB_USER",
  "AUTH_DB_PASSWORD",
  "SKLAD_DB_HOST",
  "SKLAD_DB_PORT",
  "SKLAD_DB_NAME",
  "SKLAD_DB_USER",
  "SKLAD_DB_PASSWORD",
  "SBORKA_PORT",
  "OZ_BACKEND",
  "WB_BACKEND",
  "WB_PORT",
  "WB_ROOT_SITE",
  "WB_API_TOKEN",
  "WB_API_TOKEN_2",
  "WB_STORE_1_ID",
  "WB_STORE_1_NAME",
  "WB_STORE_2_ID",
  "WB_STORE_2_NAME",
  "OZ_PORT",
  "OZ_ROOT_SITE",
  "OZON_STORE_1_ID",
  "OZON_STORE_1_NAME",
  "OZON_STORE_1_CLIENT_ID",
  "OZON_STORE_1_API_KEY",
  "OZON_STORE_2_ID",
  "OZON_STORE_2_NAME",
  "OZON_STORE_2_CLIENT_ID",
  "OZON_STORE_2_API_KEY",
  "SKLAD_FBS_WAREHOUSE_ID",
  "SKLAD_FBS_WAREHOUSE_NAME",
  "MS_FBS_STOCK_WAREHOUSE_NAME",
];

const optional = [
  "COOKIE_SECURE",
  "DB_SSL",
  "AUTH_DB_SSL",
  "SKLAD_DB_SSL",
  "SKLAD_CACHE_MS",
  "S3_ENDPOINT",
  "S3_BUCKET",
  "S3_ACCESS_KEY",
  "S3_SECRET_KEY",
  "S3_REGION",
  "S3_FORCE_PATH_STYLE",
  "S3_PUBLIC_BASE",
  "SBORKA_BOOTSTRAP_SUPERADMIN_LOGIN",
  "SBORKA_BOOTSTRAP_SUPERADMIN_PASSWORD",
  "SBORKA_BOOTSTRAP_SUPERADMIN_NAME",
  "SBORKA_BOOTSTRAP_SUPERADMIN_RESET",
  "WB_CLIENT_SECRET",
  "WB_CLIENT_SECRET_2",
];

const hasEnvFile = loadEnvFile(envPath);
const missing = required.filter((name) => !String(process.env[name] || "").trim());

const hasS3AccessKey = Boolean(String(process.env.S3_ACCESS_KEY || "").trim());
const hasS3SecretKey = Boolean(String(process.env.S3_SECRET_KEY || "").trim());
const s3Enabled = hasS3AccessKey && hasS3SecretKey;
const missingS3 = s3Enabled
  ? ["S3_ENDPOINT", "S3_BUCKET", "S3_REGION", "S3_PUBLIC_BASE"].filter((name) => !String(process.env[name] || "").trim())
  : [];

if (!hasEnvFile) {
  console.error(`Missing .env file at ${envPath}`);
}

if (missing.length || missingS3.length) {
  console.error("Missing required environment variables:");
  for (const name of missing) console.error(`- ${name}`);
  for (const name of missingS3) console.error(`- ${name}`);
  console.error("");
  console.error(`Optional variables tracked by this app: ${optional.join(", ")}`);
  process.exit(1);
}

console.log(`Environment check passed. Required variables present: ${required.length}.`);
console.log(`Label storage: ${s3Enabled ? "S3" : "local files"}.`);
if (hasS3AccessKey !== hasS3SecretKey) {
  console.warn("S3 credentials are incomplete; label uploads will use local file storage.");
}
console.log(`Optional variables tracked by this app: ${optional.join(", ")}`);
