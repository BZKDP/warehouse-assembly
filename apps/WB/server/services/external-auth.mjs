import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { Pool } from "pg";
import {
  AUTH_DB_HOST,
  AUTH_DB_NAME,
  AUTH_DB_PASSWORD,
  AUTH_DB_POOL_MAX,
  AUTH_DB_PORT,
  AUTH_DB_SSL,
  AUTH_DB_USER,
  CACHE_DIR,
  DB_POOL_CONNECTION_TIMEOUT_MS,
} from "../config.mjs";
import { normalizeText } from "../utils.mjs";

let poolPromise = null;
let activeUsersCache = null;
const ACTIVE_USERS_CACHE_FILE = path.join(CACHE_DIR, "external-auth-users-cache.json");

function cloneExternalUsers(users = []) {
  return (Array.isArray(users) ? users : []).map((user) => ({ ...user }));
}

function readActiveUsersFromDisk() {
  try {
    if (!fs.existsSync(ACTIVE_USERS_CACHE_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(ACTIVE_USERS_CACHE_FILE, "utf8"));
    const users = cloneExternalUsers(raw?.users || []);
    return users.length ? users : null;
  } catch {
    return null;
  }
}

function writeActiveUsersToDisk(users = []) {
  try {
    fs.writeFileSync(
      ACTIVE_USERS_CACHE_FILE,
      JSON.stringify({ savedAt: new Date().toISOString(), users: cloneExternalUsers(users) }),
      "utf8"
    );
  } catch {}
}

function rememberActiveUsers(users = []) {
  activeUsersCache = {
    ts: Date.now(),
    users: cloneExternalUsers(users),
  };
  writeActiveUsersToDisk(users);
  return cloneExternalUsers(users);
}

function getCachedActiveUsers() {
  if (activeUsersCache?.users?.length) {
    return cloneExternalUsers(activeUsersCache.users);
  }
  const diskUsers = readActiveUsersFromDisk();
  if (!diskUsers) return null;
  activeUsersCache = {
    ts: Date.now(),
    users: cloneExternalUsers(diskUsers),
  };
  return cloneExternalUsers(diskUsers);
}

function makePool(useSsl) {
  return new Pool({
    host: AUTH_DB_HOST,
    port: AUTH_DB_PORT,
    user: AUTH_DB_USER,
    password: AUTH_DB_PASSWORD,
    database: AUTH_DB_NAME,
    application_name: "wb-external-auth",
    max: AUTH_DB_POOL_MAX,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: DB_POOL_CONNECTION_TIMEOUT_MS,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
  });
}

function isRetryablePgConnectionError(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  const message = String(error?.message || "").toLowerCase();
  return (
    code === "ECONNRESET" ||
    code === "53300" ||
    code === "57P01" ||
    code === "57P02" ||
    code === "57P03" ||
    message.includes("remaining connection slots are reserved") ||
    message.includes("too many clients already") ||
    message.includes("timeout exceeded when trying to connect") ||
    message.includes("connection terminated unexpectedly") ||
    message.includes("terminating connection") ||
    message.includes("server closed the connection unexpectedly") ||
    message.includes("read econnreset") ||
    message.includes("socket hang up")
  );
}

async function resetPool(currentPool = null) {
  const existingPromise = poolPromise;
  poolPromise = null;
  if (currentPool) {
    try {
      await currentPool.end();
    } catch {}
    return;
  }
  if (!existingPromise) return;
  try {
    const existingPool = await existingPromise;
    if (existingPool) {
      await existingPool.end();
    }
  } catch {}
}

async function createAndTestPool(useSsl) {
  const pool = makePool(useSsl);
  try {
    await pool.query("select 1 as ok");
    return pool;
  } catch (err) {
    try {
      await pool.end();
    } catch {}
    throw err;
  }
}

async function getPool() {
  if (poolPromise) return poolPromise;
  poolPromise = (async () => {
    if (AUTH_DB_SSL === "disable") {
      return await createAndTestPool(false);
    }
    if (AUTH_DB_SSL === "require") {
      return await createAndTestPool(true);
    }
    try {
      return await createAndTestPool(true);
    } catch {
      return await createAndTestPool(false);
    }
  })();
  return poolPromise;
}

async function authQuery(text, params = []) {
  let pool = await getPool();
  try {
    return await pool.query(text, params);
  } catch (error) {
    if (!isRetryablePgConnectionError(error) || String(error?.code || "").trim().toUpperCase() === "53300") {
      throw error;
    }
    await resetPool(pool);
    pool = await getPool();
    return pool.query(text, params);
  }
}

function mapExternalUserRow(row) {
  if (!row) return null;
  const fullName =
    normalizeText(row.full_name) || normalizeText(row.employee_full_name) || normalizeText(row.login);
  return {
    id: Number(row.id),
    login: normalizeText(row.login),
    fullName,
    employeeId: Number(row.employee_id || 0) || null,
    externalRole: normalizeText(row.role) || "employee",
    status: normalizeText(row.status) || null,
    passwordHash: row.password_hash || "",
    passwordPlain: normalizeText(row.password_plain) || "",
  };
}

export function isExternalAuthConfigured() {
  return Boolean(AUTH_DB_HOST && AUTH_DB_USER && AUTH_DB_NAME);
}

export async function listActiveExternalUsers() {
  try {
    const result = await authQuery(
      `select
         u.id,
         u.login,
         u.full_name,
         u.password_plain,
         u.password_hash,
         u.employee_id,
         u.role,
         e.full_name as employee_full_name,
         e.status
       from users_d u
       join employees_d e on e.id = u.employee_id
       where coalesce(e.status, '') = 'active'
       order by coalesce(nullif(btrim(u.full_name), ''), nullif(btrim(e.full_name), ''), u.login), u.id`,
      []
    );
    return rememberActiveUsers((result.rows || []).map(mapExternalUserRow));
  } catch (error) {
    const cachedUsers = getCachedActiveUsers();
    if (cachedUsers) {
      return cachedUsers;
    }
    throw error;
  }
}

export async function getExternalUserById(userId) {
  const id = Number(userId);
  if (!Number.isFinite(id) || id < 1) return null;
  const result = await authQuery(
    `select
       u.id,
       u.login,
       u.full_name,
       u.password_plain,
       u.password_hash,
       u.employee_id,
       u.role,
       e.full_name as employee_full_name,
       e.status
     from users_d u
     join employees_d e on e.id = u.employee_id
     where u.id = $1
       and coalesce(e.status, '') = 'active'
     limit 1`,
    [id]
  );
  return mapExternalUserRow(result.rows?.[0] || null);
}

export async function getExternalUserByLogin(login) {
  const normalizedLogin = normalizeText(login);
  if (!normalizedLogin) return null;
  const result = await authQuery(
    `select
       u.id,
       u.login,
       u.full_name,
       u.password_plain,
       u.password_hash,
       u.employee_id,
       u.role,
       e.full_name as employee_full_name,
       e.status
     from users_d u
     join employees_d e on e.id = u.employee_id
     where lower(u.login) = lower($1)
       and coalesce(e.status, '') = 'active'
     limit 1`,
    [normalizedLogin]
  );
  return mapExternalUserRow(result.rows?.[0] || null);
}

export async function verifyExternalUserPassword(login, password) {
  const normalizedLogin = normalizeText(login);
  if (!normalizedLogin || typeof password !== "string" || !password) return null;
  const externalUser = await getExternalUserByLogin(normalizedLogin);
  if (!externalUser?.passwordHash) return null;
  const ok = await bcrypt.compare(password, externalUser.passwordHash);
  return ok ? externalUser : null;
}
