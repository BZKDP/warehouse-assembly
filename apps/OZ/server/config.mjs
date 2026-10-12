import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, "..");

function decodeTextFile(filePath) {
  const buf = fs.readFileSync(filePath);
  if (!buf || buf.length === 0) return "";
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.toString("utf16le");
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.allocUnsafe(buf.length - 2);
    for (let i = 2; i < buf.length; i += 2) {
      swapped[i - 2] = buf[i + 1];
      swapped[i - 1] = buf[i];
    }
    return swapped.toString("utf16le");
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.slice(3).toString("utf8");
  }
  return buf.toString("utf8");
}

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = decodeTextFile(filePath);
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
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

loadEnv(path.join(PROJECT_ROOT, ".env"));

export const ROOT_SITE = process.env.OZ_ROOT_SITE || process.env.ROOT_SITE || "OZ";
export const HOST = process.env.HOST || "127.0.0.1";
export const PORT = Number(process.env.OZ_PORT || process.env.PORT || 3006);

export const OZON_CLIENT_ID = process.env.OZON_CLIENT_ID || "";
export const OZON_API_KEY = process.env.OZON_API_KEY || "";
export const OZON_STORE_1_ID = process.env.OZON_STORE_1_ID || "irina";
export const OZON_STORE_1_NAME = process.env.OZON_STORE_1_NAME || "ИП Ирина";
export const OZON_STORE_1_CLIENT_ID = process.env.OZON_STORE_1_CLIENT_ID || OZON_CLIENT_ID;
export const OZON_STORE_1_API_KEY = process.env.OZON_STORE_1_API_KEY || OZON_API_KEY;
export const OZON_STORE_2_ID = process.env.OZON_STORE_2_ID || "evgeny";
export const OZON_STORE_2_NAME = process.env.OZON_STORE_2_NAME || "ИП Евгений";
export const OZON_STORE_2_CLIENT_ID = process.env.OZON_STORE_2_CLIENT_ID || "";
export const OZON_STORE_2_API_KEY = process.env.OZON_STORE_2_API_KEY || "";
export const OZON_API_BASE = (process.env.OZON_API_BASE || "https://api-seller.ozon.ru").replace(/\/$/, "");
export const OZON_PAGE_LIMIT = Math.max(1, Number(process.env.OZON_PAGE_LIMIT || 1000));
export const OZON_LIST_DAYS = Math.max(1, Number(process.env.OZON_LIST_DAYS || 30));
export const OZON_NEW_LIST_DAYS = Math.max(1, Number(process.env.OZON_NEW_LIST_DAYS || 7));
export const OZON_API_TIMEOUT_MS = Math.max(1000, Number(process.env.OZON_API_TIMEOUT_MS || 12000));
export const OZON_API_FAST_TIMEOUT_MS = Math.max(500, Number(process.env.OZON_API_FAST_TIMEOUT_MS || 3500));

export const MS_FBS_STOCK_WAREHOUSE_NAME = process.env.MS_FBS_STOCK_WAREHOUSE_NAME || "Ижевск FBS";
export const SKLAD_DB_HOST = process.env.SKLAD_DB_HOST || "localhost";
export const SKLAD_DB_PORT = Number(process.env.SKLAD_DB_PORT || 5432);
export const SKLAD_DB_USER = process.env.SKLAD_DB_USER || "danila";
export const SKLAD_DB_PASSWORD = process.env.SKLAD_DB_PASSWORD || "";
export const SKLAD_DB_NAME = process.env.SKLAD_DB_NAME || "bd2";
export const SKLAD_DB_SSL = (process.env.SKLAD_DB_SSL || "disable").toLowerCase();
export const SKLAD_CACHE_MS = Number(process.env.SKLAD_CACHE_MS || 60 * 1000);
export const SKLAD_DB_POOL_MAX = Math.max(1, Number(process.env.SKLAD_DB_POOL_MAX || 2) || 2);
export const SKLAD_FBS_WAREHOUSE_ID = Number(process.env.SKLAD_FBS_WAREHOUSE_ID || 1);
export const SKLAD_FBS_WAREHOUSE_NAME = process.env.SKLAD_FBS_WAREHOUSE_NAME || "Ижевск FBS";

export const MAX_CREATE_COUNT = Number(process.env.MAX_CREATE_COUNT || 400);
export const LABELS_RETRY_DELAY_MS = Number(process.env.LABELS_RETRY_DELAY_MS || 60000);
export const LABELS_BATCH_DELAY_MS = Number(process.env.LABELS_BATCH_DELAY_MS || 200);

export const DB_HOST = process.env.DB_HOST || "<SERVER_HOST>";
export const DB_PORT = Number(process.env.DB_PORT || 5432);
export const DB_USER = process.env.DB_USER || "gen_user";
export const DB_PASSWORD = process.env.DB_PASSWORD || "";
export const DB_NAME = process.env.DB_NAME || "default_db";
export const DB_SSL = (process.env.DB_SSL || "auto").toLowerCase();
export const DB_POOL_CONNECTION_TIMEOUT_MS = Math.max(
  3000,
  Number(process.env.DB_POOL_CONNECTION_TIMEOUT_MS || 8000) || 8000
);

export const AUTH_DB_HOST = process.env.AUTH_DB_HOST || "";
export const AUTH_DB_PORT = Number(process.env.AUTH_DB_PORT || 5432);
export const AUTH_DB_USER = process.env.AUTH_DB_USER || "";
export const AUTH_DB_PASSWORD = process.env.AUTH_DB_PASSWORD || "";
export const AUTH_DB_NAME = process.env.AUTH_DB_NAME || "";
export const AUTH_DB_SSL = (process.env.AUTH_DB_SSL || "disable").toLowerCase();
export const AUTH_DB_POOL_MAX = Math.max(1, Number(process.env.AUTH_DB_POOL_MAX || 1) || 1);

export const S3_ENDPOINT = (process.env.S3_ENDPOINT || "https://s3.twcstorage.ru").replace(/\/$/, "");
export const S3_BUCKET = process.env.S3_BUCKET || "postav";
export const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY || "";
export const S3_SECRET_KEY = process.env.S3_SECRET_KEY || "";
export const S3_REGION = process.env.S3_REGION || "ru-1";
export const S3_FORCE_PATH_STYLE = process.env.S3_FORCE_PATH_STYLE === "0" ? false : true;
export const S3_PUBLIC_BASE = (process.env.S3_PUBLIC_BASE || `${S3_ENDPOINT}/${S3_BUCKET}`).replace(/\/$/, "");

export const LABEL_BATCH_SIZE = Number(process.env.LABEL_BATCH_SIZE || 20);

export const COOKIE_SECURE = process.env.COOKIE_SECURE === "1";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const COOKIE_NAME = "sid";
export const COOKIE_PATH = "/" + ROOT_SITE;

export const ROLE_SUPER = "super_admin";
export const ROLE_ADMIN = "admin";
export const ROLE_EMPLOYEE = "employee";

const DEFAULT_CACHE_DIR = process.env.CACHE_DIR || path.join(PROJECT_ROOT, "var");
try {
  fs.mkdirSync(DEFAULT_CACHE_DIR, { recursive: true });
} catch {}
export const CACHE_DIR = DEFAULT_CACHE_DIR;
export const CACHE_MS = Number(process.env.CACHE_MS || 15000);
