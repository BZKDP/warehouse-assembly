import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const REPORT_DIR = path.join(PROJECT_ROOT, "var", "test-runs");

const MAIN_DB = {
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
};

const SKLAD_DB = {
  host: process.env.SKLAD_DB_HOST || "localhost",
  port: Number(process.env.SKLAD_DB_PORT || 5432),
  user: process.env.SKLAD_DB_USER,
  password: process.env.SKLAD_DB_PASSWORD,
  database: process.env.SKLAD_DB_NAME,
  ssl: process.env.SKLAD_DB_SSL === "true" ? { rejectUnauthorized: false } : false,
};

const SBORKA_API_BASE = (process.env.SBORKA_API_BASE || "https://grasklad.ru/sborka/api").replace(/\/$/, "");
const SBORKA_BASE = `${SBORKA_API_BASE}/wb`;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SUPPLY_ID = process.argv[2];
if (!SUPPLY_ID || !MAIN_DB.user || !MAIN_DB.password || !MAIN_DB.database ||
    !SKLAD_DB.user || !SKLAD_DB.password || !SKLAD_DB.database) {
  throw new Error("Provide a supply ID and DB_*/SKLAD_DB_* settings for a disposable test database");
}
const KEEP_STATE = process.argv.includes("--keep-state");
const TEMP_USER_COUNT = 4;
const PICK_PACK_INDEX = 0;
const SPLIT_PICKER_INDEX = 1;
const SPLIT_PACKER_BEFORE_REDISTRIBUTE_INDEX = 2;
const SPLIT_PACKER_AFTER_REDISTRIBUTE_INDEX = 3;
const INITIAL_ACCESS_INDEXES = [PICK_PACK_INDEX, SPLIT_PICKER_INDEX, SPLIT_PACKER_BEFORE_REDISTRIBUTE_INDEX];
const REDISTRIBUTED_ACCESS_INDEXES = [PICK_PACK_INDEX, SPLIT_PICKER_INDEX, SPLIT_PACKER_AFTER_REDISTRIBUTE_INDEX];
const HTTP_RETRY_ATTEMPTS = 4;
const HTTP_RETRY_DELAY_MS = 1500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeMainClient() {
  return new Client(MAIN_DB);
}

function makeSkladClient() {
  return new Client(SKLAD_DB);
}

function log(message, data = null) {
  if (data === null || data === undefined) {
    console.log(`[autotest] ${message}`);
    return;
  }
  console.log(`[autotest] ${message}`, data);
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

function cookieHeader(token) {
  return `sid=${token}`;
}

async function ensureSborkaReachableV2() {
  let lastError = null;
  for (let attempt = 1; attempt <= HTTP_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`${SBORKA_API_BASE}/auth/me`, { headers: { Accept: "application/json" } });
      const contentType = String(response.headers.get("content-type") || "").toLowerCase();
      if (!response.ok) {
        const error = new Error(`sborka proxy unavailable: HTTP ${response.status}`);
        if (response.status >= 500 && attempt < HTTP_RETRY_ATTEMPTS) {
          lastError = error;
          await sleep(HTTP_RETRY_DELAY_MS * attempt);
          continue;
        }
        throw error;
      }
      if (!contentType.includes("application/json")) {
        throw new Error(`sborka proxy returned non-JSON content-type: ${contentType || "unknown"}`);
      }
      return;
    } catch (error) {
      const isNetworkError = /fetch failed|ecconn|socket|network|timeout/i.test(String(error?.message || ""));
      if (!isNetworkError || attempt >= HTTP_RETRY_ATTEMPTS) {
        throw error;
      }
      lastError = error;
      await sleep(HTTP_RETRY_DELAY_MS * attempt);
    }
  }
  throw lastError || new Error("sborka proxy unavailable");
}

async function httpJson(token, route, options = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= HTTP_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`${SBORKA_BASE}${route}`, {
        method: options.method || "GET",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Cookie: cookieHeader(token),
          ...(options.headers || {}),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      const text = await response.text();
      const contentType = String(response.headers.get("content-type") || "").toLowerCase();
      let payload = null;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = { raw: text };
        }
      }
      if (response.ok && !contentType.includes("application/json")) {
        throw new Error(
          `Unexpected non-JSON response for ${options.method || "GET"} ${route}: content-type=${contentType || "unknown"}`
        );
      }
      if (!response.ok) {
        const error = new Error(
          `HTTP ${response.status} ${options.method || "GET"} ${route}: ${payload?.error || text || response.statusText}`
        );
        error.status = response.status;
        error.payload = payload;
        if (response.status >= 500 && attempt < HTTP_RETRY_ATTEMPTS) {
          await sleep(HTTP_RETRY_DELAY_MS * attempt);
          lastError = error;
          continue;
        }
        throw error;
      }
      return payload;
    } catch (error) {
      const isNetworkError = /fetch failed|ecconn|socket|network|timeout/i.test(String(error?.message || ""));
      if (!isNetworkError || attempt >= HTTP_RETRY_ATTEMPTS) {
        throw error;
      }
      lastError = error;
      await sleep(HTTP_RETRY_DELAY_MS * attempt);
    }
  }
  throw lastError || new Error(`HTTP request failed for ${options.method || "GET"} ${route}`);
}

async function createAppSessionToken(mainDb, userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_TTL_MS);
  await mainDb.query(
    `insert into sessions (token, user_id, expires_at, created_at, updated_at)
     values ($1, $2, $3, now(), now())`,
    [token, userId, expires]
  );
  return { token, expiresAt: expires.toISOString() };
}

async function getWarehouseEmployeeRoleId(skladDb) {
  const result = await skladDb.query(
    `select role_id
     from users_s
     where lower(role) = 'employee'
       and role_id is not null
     order by id desc
     limit 1`,
    []
  );
  return Number(result.rows?.[0]?.role_id || 3) || 3;
}

async function allocateWarehouseExternalEmployeeId(skladDb) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = 1900000000 + Math.floor(Math.random() * 100000000);
    const exists = await skladDb.query(
      `select 1
       from (
         select external_employee_id as value from employees_s where external_employee_id = $1
         union all
         select id as value from employees_d where id = $1
       ) t
       limit 1`,
      [candidate]
    );
    if (!exists.rows?.length) return candidate;
  }
  throw new Error("Unable to allocate unique warehouse external_employee_id");
}

async function createTempWarehouseActors(skladDb, count, runKey) {
  const roleId = await getWarehouseEmployeeRoleId(skladDb);
  const result = [];
  for (let index = 0; index < count; index += 1) {
    const externalEmployeeId = await allocateWarehouseExternalEmployeeId(skladDb);
    const baseName = `AUTOTEST WB ${runKey} ${index + 1}`;
    const username = `autotest_wb_${runKey}_${index + 1}`.toLowerCase();
    await skladDb.query(
      `insert into employees_d (
         id, full_name, department_id, email, phone, position_id,
         work_format, status, created_at, updated_at, created_by, updated_by,
         advance_exception, work_schedule
       )
       values ($1, $2, 4, '', null, 47, 'production', 'active', now(), now(), 1, 1, false, '5/2')`,
      [externalEmployeeId, baseName]
    );
    const usersDRow = await skladDb.query(
      `insert into users_d (
         login, full_name, password_hash, password_plain, employee_id, role, created_at, created_by
       )
       values ($1, $2, $3, $4, $5, 'employee', now(), 1)
       returning id`,
      [username, baseName, "__autotest__", null, externalEmployeeId]
    );
    const employeeRow = await skladDb.query(
      `insert into employees_s (
         full_name, position, active, created_at, updated_at, external_employee_id, department, gra_balance
       )
       values ($1, $2, true, now(), now(), $3, $4, 0)
       returning id, full_name, external_employee_id`,
      [baseName, "Упаковщик", externalEmployeeId, "Autotest"]
    );
    const employee = employeeRow.rows[0];
    const userRow = await skladDb.query(
      `insert into users_s (
         username, password_hash, role, employee_id, active, created_at, updated_at, role_id, password_plain, users_d_id
       )
       values ($1, $2, 'employee', $3, true, now(), now(), $4, $5, $6)
       returning id, username, employee_id`,
      [username, "__autotest__", Number(employee.id), roleId, null, Number(usersDRow.rows[0].id)]
    );
    result.push({
      index,
      externalEmployeeId: Number(employee.external_employee_id),
      employeeId: Number(employee.id),
      employeeName: employee.full_name,
      usersSId: Number(userRow.rows[0].id),
      usersSUsername: userRow.rows[0].username,
      usersDId: Number(usersDRow.rows[0].id),
    });
  }
  return result;
}

async function createTempAppUsers(mainDb, warehouseActors, runKey) {
  const result = [];
  for (const actor of warehouseActors) {
    const surname = "AUTOTEST";
    const name = `WB ${runKey} ${actor.index + 1}`;
    const fullName = `${surname} ${name}`.trim();
    const row = await mainDb.query(
      `insert into users (
         surname, name, role, password_hash, password_salt, created_at, updated_at,
         position, site_code, auth_source, external_employee_id, external_login, external_full_name
       )
       values (
         $1, $2, 'employee', $3, $4, now(), now(),
         'packer', null, 'legacy', $5, $6, $7
       )
       returning id, surname, name, role, position, auth_source, external_employee_id`,
      [
        surname,
        name,
        `autotest_hash_${runKey}_${actor.index + 1}`,
        `autotest_salt_${runKey}_${actor.index + 1}`,
        actor.externalEmployeeId,
        `autotest.${runKey}.${actor.index + 1}`,
        fullName,
      ]
    );
    result.push({
      index: actor.index,
      userId: Number(row.rows[0].id),
      fullName,
      role: row.rows[0].role,
      position: row.rows[0].position,
      externalEmployeeId: Number(row.rows[0].external_employee_id),
      warehouse: actor,
    });
  }
  return result;
}

async function createTempSessions(mainDb, users) {
  const sessions = new Map();
  for (const user of users) {
    const session = await createAppSessionToken(mainDb, user.userId);
    sessions.set(user.userId, session.token);
  }
  return sessions;
}

async function findAdminUserId(mainDb) {
  const result = await mainDb.query(
    `select id
     from users
     where role = 'admin'
     order by id asc
     limit 1`
  );
  const adminUserId = Number(result.rows?.[0]?.id || 0);
  if (!Number.isInteger(adminUserId) || adminUserId < 1) {
    throw new Error("No admin user found for autotest session");
  }
  return adminUserId;
}

async function createAdminSession(mainDb, adminUserId = null) {
  const resolvedUserId = adminUserId || (await findAdminUserId(mainDb));
  return createAppSessionToken(mainDb, resolvedUserId);
}

async function ensureSborkaReachable() {
  const response = await fetch("http://127.0.0.1:3008/sborka/api/auth/me", { headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`sborka proxy недоступен: HTTP ${response.status}`);
  }
}

async function getSupplySnapshot(mainDb, supplyId) {
  const [settings, orders, access, parts, sessions, pickItems, issues] = await Promise.all([
    mainDb.query(
      `select supply_id, access_mode, employee_workflow_mode, employee_workflow_stage,
              product_picking_started_at, product_picking_started_by, stock_method_enabled
       from supply_settings
       where supply_id = $1`,
      [supplyId]
    ),
    mainDb.query(
      `select wb_order_id, assigned_user_id, assignment_part_id, assigned_at,
              scan_passed_at, scan_passed_by, scan_barcode, scan_error,
              label_scan_passed_at, label_scan_passed_by, label_scan_barcode, label_scan_error,
              collected_at, collected_by, collected_via, collected_session_id
       from supply_orders
       where supply_id = $1
       order by wb_order_id`,
      [supplyId]
    ),
    mainDb.query(`select * from supply_access_users where supply_id = $1 order by user_id`, [supplyId]),
    mainDb.query(`select * from supply_assignment_parts where supply_id = $1 order by id`, [supplyId]),
    mainDb.query(`select * from employee_supply_sessions where supply_id = $1 order by id`, [supplyId]),
    mainDb.query(`select * from employee_supply_pick_items where supply_id = $1 order by id`, [supplyId]),
    mainDb.query(`select * from employee_scan_issues where supply_id = $1 order by id`, [supplyId]),
  ]);
  return {
    settings: settings.rows?.[0] || null,
    orders: orders.rows || [],
    access: access.rows || [],
    parts: parts.rows || [],
    sessions: sessions.rows || [],
    pickItems: pickItems.rows || [],
    issues: issues.rows || [],
  };
}

async function forceResetSupply(mainDb, supplyId) {
  await mainDb.query("begin");
  try {
    await mainDb.query(`delete from employee_scan_issues where supply_id = $1`, [supplyId]);
    await mainDb.query(`delete from employee_supply_pick_items where supply_id = $1`, [supplyId]);
    await mainDb.query(
      `update supply_orders
       set assigned_user_id = null,
           assignment_part_id = null,
           assigned_at = null,
           scan_passed_at = null,
           scan_passed_by = null,
           scan_barcode = null,
           scan_error = null,
           label_scan_passed_at = null,
           label_scan_passed_by = null,
           label_scan_barcode = null,
           label_scan_error = null,
           collected_at = null,
           collected_by = null,
           collected_via = null,
           collected_session_id = null,
           updated_at = now()
       where supply_id = $1`,
      [supplyId]
    );
    await mainDb.query(`delete from employee_supply_sessions where supply_id = $1`, [supplyId]);
    await mainDb.query(`delete from supply_assignment_parts where supply_id = $1`, [supplyId]);
    await mainDb.query(`delete from supply_access_users where supply_id = $1`, [supplyId]);
    await mainDb.query(
      `update supply_settings
       set access_mode = 'selected_split',
           employee_workflow_mode = 'picking',
           employee_workflow_stage = 'orders_only',
           product_picking_started_at = null,
           product_picking_started_by = null,
           stock_method_enabled = true,
           updated_at = now()
       where supply_id = $1`,
      [supplyId]
    );
    await mainDb.query("commit");
  } catch (error) {
    await mainDb.query("rollback");
    throw error;
  }
}

async function cleanupAppArtifacts(mainDb, supplyId, tempUsers, sessionTokens) {
  const userIds = tempUsers.map((user) => Number(user.userId));
  const tokens = Array.from(sessionTokens.values ? sessionTokens.values() : sessionTokens).filter(Boolean);
  await mainDb.query("begin");
  try {
    await mainDb.query(`delete from employee_scan_issues where supply_id = $1 and employee_id = any($2::bigint[])`, [supplyId, userIds]);
    await mainDb.query(`delete from employee_supply_pick_items where supply_id = $1 and user_id = any($2::bigint[])`, [supplyId, userIds]);
    await mainDb.query(
      `update supply_orders
       set assigned_user_id = null,
           assignment_part_id = null,
           assigned_at = null,
           scan_passed_at = null,
           scan_passed_by = null,
           scan_barcode = null,
           scan_error = null,
           label_scan_passed_at = null,
           label_scan_passed_by = null,
           label_scan_barcode = null,
           label_scan_error = null,
           collected_at = null,
           collected_by = null,
           collected_via = null,
           collected_session_id = null,
           updated_at = now()
       where supply_id = $1`,
      [supplyId]
    );
    await mainDb.query(`delete from employee_supply_sessions where supply_id = $1`, [supplyId]);
    await mainDb.query(`delete from supply_assignment_parts where supply_id = $1`, [supplyId]);
    await mainDb.query(`delete from supply_access_users where supply_id = $1`, [supplyId]);
    await mainDb.query(
      `update supply_settings
       set access_mode = 'selected_split',
           employee_workflow_mode = 'picking',
           employee_workflow_stage = 'orders_only',
           product_picking_started_at = null,
           product_picking_started_by = null,
           stock_method_enabled = true,
           updated_at = now()
       where supply_id = $1`,
      [supplyId]
    );
    await mainDb.query(`delete from employee_coin_events where user_id = any($1::bigint[])`, [userIds]);
    await mainDb.query(`delete from employee_coin_balances where user_id = any($1::bigint[])`, [userIds]);
    if (tokens.length) {
      await mainDb.query(`delete from sessions where token = any($1::text[])`, [tokens]);
    }
    await mainDb.query(`delete from users where id = any($1::bigint[])`, [userIds]);
    await mainDb.query("commit");
  } catch (error) {
    await mainDb.query("rollback");
    throw error;
  }
}

async function reversePickScanShelfEffects(skladDb, supplyId, startedAtIso) {
  const result = await skladDb.query(
    `select id, product_id, quantity, from_shelf_id, from_shelf_box_id
     from movements_s
     where source = 'wb_pick_scan'
       and notes ilike $1
       and created_at >= $2::timestamptz
     order by id desc`,
    [`%Поставка ${supplyId}%`, startedAtIso]
  );
  for (const row of result.rows || []) {
    const productId = Number(row.product_id);
    const quantity = Number(row.quantity || 0);
    const shelfId = Number(row.from_shelf_id || 0) || null;
    const shelfBoxId = Number(row.from_shelf_box_id || 0) || null;
    if (shelfBoxId) {
      await skladDb.query(
        `insert into shelf_box_items_s (shelf_box_id, product_id, quantity, updated_at)
         values ($1, $2, $3, now())
         on conflict (shelf_box_id, product_id)
         do update set quantity = shelf_box_items_s.quantity + excluded.quantity,
                       updated_at = now()`,
        [shelfBoxId, productId, quantity]
      );
      await skladDb.query(
        `update shelf_boxes_s
         set quantity = greatest(0, coalesce(quantity, 0) + $2)
         where id = $1 and product_id = $3`,
        [shelfBoxId, quantity, productId]
      );
    } else if (shelfId) {
      await skladDb.query(
        `insert into shelf_items_s (shelf_id, product_id, quantity, updated_at)
         values ($1, $2, $3, now())
         on conflict (shelf_id, product_id)
         do update set quantity = shelf_items_s.quantity + excluded.quantity,
                       updated_at = now()`,
        [shelfId, productId, quantity]
      );
    }
  }
}

async function cleanupWarehouseArtifacts(skladDb, supplyId, startedAtIso, warehouseActors) {
  const employeeIds = warehouseActors.map((actor) => Number(actor.employeeId));
  const usersSIds = warehouseActors.map((actor) => Number(actor.usersSId));
  const usersDIds = warehouseActors.map((actor) => Number(actor.usersDId || 0)).filter((value) => Number.isInteger(value) && value > 0);
  const employeesDIds = warehouseActors
    .map((actor) => Number(actor.externalEmployeeId || 0))
    .filter((value) => Number.isInteger(value) && value > 0);
  const result = {
    deletedMovements: 0,
    deletedShelfMovements: 0,
    deletedLiveEvents: 0,
    deletedEarnings: 0,
  };

  await skladDb.query("begin");
  try {
    await reversePickScanShelfEffects(skladDb, supplyId, startedAtIso);

    const movementDelete = await skladDb.query(
      `delete from movements_s
       where source in ('wb_pick_scan', 'wb_collect', 'wb_handoff', 'wb_redistribute')
         and notes ilike $1
         and created_at >= $2::timestamptz`,
      [`%Поставка ${supplyId}%`, startedAtIso]
    );
    result.deletedMovements = Number(movementDelete.rowCount || 0);

    const shelfDelete = await skladDb.query(
      `delete from shelf_movements_s
       where source = 'wb_pick_scan'
         and notes ilike $1
         and created_at >= $2::timestamptz
         and user_id = any($3::int[])`,
      [`%Поставка ${supplyId}%`, startedAtIso, usersSIds]
    );
    result.deletedShelfMovements = Number(shelfDelete.rowCount || 0);

    await skladDb.query(`delete from employee_inventory_s where employee_id = any($1::int[])`, [employeeIds]);

    const liveDelete = await skladDb.query(
      `delete from sborka_live_events_s
       where employee_id = any($1::int[])
         and created_at >= $2::timestamptz`,
      [employeeIds, startedAtIso]
    ).catch(() => ({ rowCount: 0 }));
    result.deletedLiveEvents = Number(liveDelete.rowCount || 0);

    const earningsDelete = await skladDb.query(
      `delete from employee_earnings_s
       where employee_id = any($1::int[])
         and source = 'sborka-site'
         and source_entity_id = $2`,
      [employeeIds, supplyId]
    ).catch(() => ({ rowCount: 0 }));
    result.deletedEarnings = Number(earningsDelete.rowCount || 0);

    await skladDb.query(`delete from users_s where id = any($1::int[])`, [usersSIds]);
    await skladDb.query(`delete from employees_s where id = any($1::int[])`, [employeeIds]);
    if (usersDIds.length) {
      await skladDb.query(`delete from users_d where id = any($1::int[])`, [usersDIds]);
    }
    if (employeesDIds.length) {
      await skladDb.query(`delete from employees_d where id = any($1::int[])`, [employeesDIds]);
    }
    await skladDb.query(
      `delete from shelf_items_s
       where quantity = 0
         and shelf_id in (
           select distinct from_shelf_id
           from movements_s
           where source = 'wb_pick_scan'
             and notes ilike $1
             and created_at >= $2::timestamptz
             and from_shelf_id is not null
         )`,
      [`%Поставка ${supplyId}%`, startedAtIso]
    ).catch(() => {});
    await skladDb.query(
      `delete from shelf_box_items_s
       where quantity = 0
         and shelf_box_id in (
           select distinct from_shelf_box_id
           from movements_s
           where source = 'wb_pick_scan'
             and notes ilike $1
             and created_at >= $2::timestamptz
             and from_shelf_box_id is not null
         )`,
      [`%Поставка ${supplyId}%`, startedAtIso]
    ).catch(() => {});

    await skladDb.query("commit");
  } catch (error) {
    await skladDb.query("rollback");
    throw error;
  }
  return result;
}

async function ensureWarehouseActorsActive(skladDb, warehouseActors = []) {
  if (!skladDb || !warehouseActors.length) return;
  const employeeIds = warehouseActors.map((actor) => Number(actor.employeeId)).filter((value) => Number.isInteger(value) && value > 0);
  const usersSIds = warehouseActors.map((actor) => Number(actor.usersSId)).filter((value) => Number.isInteger(value) && value > 0);
  if (employeeIds.length) {
    await skladDb.query(
      `update employees_s
       set active = true,
           updated_at = now()
       where id = any($1::int[])`,
      [employeeIds]
    );
  }
  if (usersSIds.length) {
    await skladDb.query(
      `update users_s
       set active = true,
           updated_at = now()
       where id = any($1::int[])`,
      [usersSIds]
    );
  }
}

async function getEmployeeSupplies(token) {
  const payload = await httpJson(token, "/employee/supplies");
  return Array.isArray(payload?.supplies) ? payload.supplies : [];
}

async function getEmployeeSession(token, supplyId) {
  return httpJson(token, `/employee/supplies/${encodeURIComponent(supplyId)}/session`);
}

async function startEmployee(token, supplyId) {
  return httpJson(token, `/employee/supplies/${encodeURIComponent(supplyId)}/start`, { method: "POST", body: {} });
}

async function getPickItems(token, supplyId) {
  const payload = await httpJson(token, `/employee/supplies/${encodeURIComponent(supplyId)}/pick-items`);
  return Array.isArray(payload?.items) ? payload.items : [];
}

async function pickScan(token, supplyId, barcode) {
  return httpJson(token, `/employee/supplies/${encodeURIComponent(supplyId)}/pick-scan`, {
    method: "POST",
    body: { barcode },
  });
}

async function finishPick(token, supplyId) {
  return httpJson(token, `/employee/supplies/${encodeURIComponent(supplyId)}/pick-finish`, { method: "POST", body: {} });
}

async function confirmTable(token, supplyId) {
  return httpJson(token, `/employee/supplies/${encodeURIComponent(supplyId)}/table-confirm`, { method: "POST", body: {} });
}

async function getOrders(token, supplyId) {
  const payload = await httpJson(token, `/employee/supplies/${encodeURIComponent(supplyId)}/orders`);
  return Array.isArray(payload?.orders) ? payload.orders : [];
}

async function scanOrder(token, supplyId, orderId, barcode) {
  return httpJson(token, `/employee/supplies/${encodeURIComponent(supplyId)}/orders/${encodeURIComponent(orderId)}/scan`, {
    method: "POST",
    body: { barcode },
  });
}

async function labelScan(token, supplyId, orderId, stickerBarcode) {
  return httpJson(token, `/employee/supplies/${encodeURIComponent(supplyId)}/orders/${encodeURIComponent(orderId)}/label-scan`, {
    method: "POST",
    body: { barcode: stickerBarcode },
  });
}

async function getAdminSettings(token, supplyId) {
  return httpJson(token, `/supplies/${encodeURIComponent(supplyId)}/settings`);
}

async function patchAdminSettings(token, supplyId, body) {
  return httpJson(token, `/supplies/${encodeURIComponent(supplyId)}/settings`, {
    method: "PATCH",
    body,
  });
}

async function saveAccessUsers(token, supplyId, userIds) {
  return httpJson(token, `/supplies/${encodeURIComponent(supplyId)}/access`, {
    method: "POST",
    body: { userIds },
  });
}

async function splitSupply(token, supplyId, parts) {
  return httpJson(token, `/supplies/${encodeURIComponent(supplyId)}/split`, {
    method: "POST",
    body: { parts },
  });
}

async function redistributeSupply(token, supplyId, parts) {
  return httpJson(token, `/supplies/${encodeURIComponent(supplyId)}/redistribute`, {
    method: "POST",
    body: { parts },
  });
}

async function startAdminProductPicking(token, supplyId) {
  return httpJson(token, `/supplies/${encodeURIComponent(supplyId)}/product-picking/start`, {
    method: "POST",
    body: {},
  });
}

async function processAllPickItems(token, supplyId, options = {}) {
  const items = await getPickItems(token, supplyId);
  const stats = {
    items: items.length,
    requiredQty: 0,
    scans: 0,
    byArticle: [],
  };
  for (const item of items) {
    const requiredQty = Number(item.requiredQty || 0);
    stats.requiredQty += requiredQty;
    stats.byArticle.push({
      article: item.article,
      barcode: item.barcode,
      requiredQty,
    });
    for (let scanIndex = 0; scanIndex < requiredQty; scanIndex += 1) {
      await ensureWarehouseActorsActive(options.skladDb, options.warehouseActors);
      await pickScan(token, supplyId, item.barcode);
      stats.scans += 1;
    }
  }
  await finishPick(token, supplyId);
  return stats;
}

async function processAllOrders(token, supplyId, options = {}) {
  const orders = await getOrders(token, supplyId);
  const stats = {
    orders: orders.length,
    scanned: 0,
    labeled: 0,
    firstOrderId: orders[0]?.id || null,
    lastOrderId: orders[orders.length - 1]?.id || null,
  };
  for (const order of orders) {
    await ensureWarehouseActorsActive(options.skladDb, options.warehouseActors);
    await scanOrder(token, supplyId, order.id, order.barcode);
    stats.scanned += 1;
    if (!order.stickerBarcode) {
      throw new Error(`У заказа ${order.id} нет stickerBarcode`);
    }
    await ensureWarehouseActorsActive(options.skladDb, options.warehouseActors);
    await labelScan(token, supplyId, order.id, order.stickerBarcode);
    stats.labeled += 1;
  }
  return stats;
}

async function waitForCoinSync(mainDb, userIds, expectedEventCount, timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await mainDb.query(
      `select count(*)::int as total,
              count(*) filter (where external_sync_status = 'synced')::int as synced
       from employee_coin_events
       where user_id = any($1::bigint[])`,
      [userIds]
    );
    const row = result.rows?.[0] || {};
    const total = Number(row.total || 0);
    const synced = Number(row.synced || 0);
    if (total >= expectedEventCount && synced >= expectedEventCount) {
      return { total, synced, waitedMs: Date.now() - startedAt };
    }
    await sleep(250);
  }
  const result = await mainDb.query(
    `select count(*)::int as total,
            count(*) filter (where external_sync_status = 'synced')::int as synced
     from employee_coin_events
     where user_id = any($1::bigint[])`,
    [userIds]
  );
  return {
    total: Number(result.rows?.[0]?.total || 0),
    synced: Number(result.rows?.[0]?.synced || 0),
    waitedMs: Date.now() - startedAt,
  };
}

async function loadRewardSummary(mainDb, skladDb, tempUsers) {
  const userIds = tempUsers.map((user) => Number(user.userId));
  const externalEmployeeIds = tempUsers.map((user) => Number(user.externalEmployeeId));
  const localEvents = await mainDb.query(
    `select user_id, event_type, count(*)::int as cnt, coalesce(sum(amount_delta), 0) as amount
     from employee_coin_events
     where user_id = any($1::bigint[])
     group by user_id, event_type
     order by user_id, event_type`,
    [userIds]
  );
  const localBalances = await mainDb.query(
    `select user_id, balance
     from employee_coin_balances
     where user_id = any($1::bigint[])
     order by user_id`,
    [userIds]
  );
  const remoteEmployees = await skladDb.query(
    `select id, external_employee_id, full_name, gra_balance
     from employees_s
     where external_employee_id = any($1::int[])
     order by external_employee_id`,
    [externalEmployeeIds]
  );
  const remoteIds = remoteEmployees.rows.map((row) => Number(row.id));
  const remoteEvents =
    remoteIds.length > 0
      ? await skladDb.query(
          `select employee_id, event_type, count(*)::int as cnt, coalesce(sum(amount_delta), 0) as amount
           from employee_earnings_s
           where employee_id = any($1::int[])
             and source = 'sborka-site'
             and source_entity_id = $2
           group by employee_id, event_type
           order by employee_id, event_type`,
          [remoteIds, SUPPLY_ID]
        )
      : { rows: [] };
  return {
    localEvents: localEvents.rows || [],
    localBalances: localBalances.rows || [],
    remoteEmployees: remoteEmployees.rows || [],
    remoteEvents: remoteEvents.rows || [],
  };
}

async function loadFinalSupplyState(mainDb, supplyId) {
  const [orders, sessions, parts] = await Promise.all([
    mainDb.query(
      `select
         count(*)::int as total,
         count(*) filter (where collected_at is not null)::int as collected,
         count(*) filter (where assigned_user_id is not null and collected_at is null)::int as remaining_assigned,
         count(*) filter (where scan_passed_at is not null)::int as scanned,
         count(*) filter (where label_scan_passed_at is not null)::int as labeled
       from supply_orders
       where supply_id = $1`,
      [supplyId]
    ),
    mainDb.query(
      `select id, user_id, assignment_mode, session_role, status, assigned_order_count, collected_order_count,
              picking_status, picking_required_qty, picking_collected_qty
       from employee_supply_sessions
       where supply_id = $1
       order by id`,
      [supplyId]
    ),
    mainDb.query(
      `select id, part_no, role_mode, picker_user_id, packer_user_id, table_no, handoff_status
       from supply_assignment_parts
       where supply_id = $1
       order by part_no`,
      [supplyId]
    ),
  ]);
  return {
    totals: orders.rows?.[0] || {},
    sessions: sessions.rows || [],
    parts: parts.rows || [],
  };
}

async function main() {
  ensureDir(REPORT_DIR);
  const runKey = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const reportPath = path.join(REPORT_DIR, `wb-live-autotest-${SUPPLY_ID}-${runKey}.json`);
  const mainDb = makeMainClient();
  const skladDb = makeSkladClient();
  const report = {
    supplyId: SUPPLY_ID,
    startedAt: nowIso(),
    keepState: KEEP_STATE,
    runKey,
    setup: {},
    scenario: {},
    rewards: {},
    finalState: {},
    cleanup: {},
  };

  const sessionTokens = new Map();
  let tempWarehouseActors = [];
  let tempUsers = [];
  let startedAtIso = report.startedAt;

  await mainDb.connect();
  await skladDb.connect();

  try {
    await ensureSborkaReachableV2();
    report.setup.initialSnapshot = await getSupplySnapshot(mainDb, SUPPLY_ID);
    await forceResetSupply(mainDb, SUPPLY_ID);

    tempWarehouseActors = await createTempWarehouseActors(skladDb, TEMP_USER_COUNT, runKey);
    await ensureWarehouseActorsActive(skladDb, tempWarehouseActors);
    tempUsers = await createTempAppUsers(mainDb, tempWarehouseActors, runKey);
    const adminSession = await createAdminSession(mainDb);
    sessionTokens.set("admin", adminSession.token);
    const employeeSessions = await createTempSessions(mainDb, tempUsers);
    for (const user of tempUsers) {
      sessionTokens.set(user.userId, employeeSessions.get(user.userId));
    }

    report.setup.tempUsers = tempUsers.map((user) => ({
      userId: user.userId,
      fullName: user.fullName,
      externalEmployeeId: user.externalEmployeeId,
      warehouseEmployeeId: user.warehouse.employeeId,
      warehouseUsersSId: user.warehouse.usersSId,
    }));

    const adminToken = sessionTokens.get("admin");
    await patchAdminSettings(adminToken, SUPPLY_ID, {
      accessMode: "selected_split",
      employeeWorkflowMode: "picking",
      stockMethodEnabled: true,
    });
    await saveAccessUsers(adminToken, SUPPLY_ID, INITIAL_ACCESS_INDEXES.map((index) => tempUsers[index].userId));

    const initialParts = [
      {
        partNo: 1,
        roleMode: "pick_pack",
        pickerUserId: null,
        packerUserId: tempUsers[PICK_PACK_INDEX].userId,
        tableNo: null,
      },
      {
        partNo: 2,
        roleMode: "split",
        pickerUserId: tempUsers[SPLIT_PICKER_INDEX].userId,
        packerUserId: tempUsers[SPLIT_PACKER_BEFORE_REDISTRIBUTE_INDEX].userId,
        tableNo: 1,
      },
    ];
    report.scenario.initialSplit = await splitSupply(adminToken, SUPPLY_ID, initialParts);
    await startAdminProductPicking(adminToken, SUPPLY_ID);

    const oldPackerToken = sessionTokens.get(tempUsers[SPLIT_PACKER_BEFORE_REDISTRIBUTE_INDEX].userId);
    let blockedStart = null;
    try {
      await startEmployee(oldPackerToken, SUPPLY_ID);
    } catch (error) {
      blockedStart = {
        status: error.status || null,
        error: error.payload?.error || error.message,
      };
    }
    report.scenario.blockedPackerStartBeforePicking = blockedStart;

    const splitPickerToken = sessionTokens.get(tempUsers[SPLIT_PICKER_INDEX].userId);
    report.scenario.splitPickerSupplyListBeforeStart = await getEmployeeSupplies(splitPickerToken);
    await ensureWarehouseActorsActive(skladDb, tempWarehouseActors);
    report.scenario.splitPickerStart = await startEmployee(splitPickerToken, SUPPLY_ID);
    report.scenario.splitPickerPickStats = await processAllPickItems(splitPickerToken, SUPPLY_ID, {
      skladDb,
      warehouseActors: tempWarehouseActors,
    });
    report.scenario.splitPickerTableConfirm = await confirmTable(splitPickerToken, SUPPLY_ID);

    const redistributedParts = [
      {
        partNo: 1,
        roleMode: "pick_pack",
        pickerUserId: null,
        packerUserId: tempUsers[PICK_PACK_INDEX].userId,
        tableNo: null,
      },
      {
        partNo: 2,
        roleMode: "split",
        pickerUserId: tempUsers[SPLIT_PICKER_INDEX].userId,
        packerUserId: tempUsers[SPLIT_PACKER_AFTER_REDISTRIBUTE_INDEX].userId,
        tableNo: 1,
      },
    ];
    await saveAccessUsers(adminToken, SUPPLY_ID, REDISTRIBUTED_ACCESS_INDEXES.map((index) => tempUsers[index].userId));
    report.scenario.redistribute = await redistributeSupply(adminToken, SUPPLY_ID, redistributedParts);
    report.scenario.splitPickerTableConfirmAfterRedistribute = await confirmTable(splitPickerToken, SUPPLY_ID);

    report.scenario.oldPackerSuppliesAfterRedistribute = await getEmployeeSupplies(oldPackerToken);
    const newPackerToken = sessionTokens.get(tempUsers[SPLIT_PACKER_AFTER_REDISTRIBUTE_INDEX].userId);
    report.scenario.newPackerSuppliesAfterRedistribute = await getEmployeeSupplies(newPackerToken);
    report.scenario.newPackerSessionBeforeStart = await getEmployeeSession(newPackerToken, SUPPLY_ID);
    await ensureWarehouseActorsActive(skladDb, tempWarehouseActors);
    report.scenario.newPackerStart = await startEmployee(newPackerToken, SUPPLY_ID);
    report.scenario.newPackerOrders = await processAllOrders(newPackerToken, SUPPLY_ID, {
      skladDb,
      warehouseActors: tempWarehouseActors,
    });

    report.scenario.adminProductPickingRestartAfterRedistribute = await startAdminProductPicking(adminToken, SUPPLY_ID);
    const pickPackToken = sessionTokens.get(tempUsers[PICK_PACK_INDEX].userId);
    report.scenario.pickPackSessionBeforeStart = await getEmployeeSession(pickPackToken, SUPPLY_ID);
    await ensureWarehouseActorsActive(skladDb, tempWarehouseActors);
    report.scenario.pickPackStartPicking = await startEmployee(pickPackToken, SUPPLY_ID);
    report.scenario.pickPackPickStats = await processAllPickItems(pickPackToken, SUPPLY_ID, {
      skladDb,
      warehouseActors: tempWarehouseActors,
    });
    await ensureWarehouseActorsActive(skladDb, tempWarehouseActors);
    report.scenario.pickPackStartPacking = await startEmployee(pickPackToken, SUPPLY_ID);
    report.scenario.pickPackOrders = await processAllOrders(pickPackToken, SUPPLY_ID, {
      skladDb,
      warehouseActors: tempWarehouseActors,
    });

    await sleep(1000);

    const expectedRewardEvents =
      Number(report.scenario.splitPickerPickStats?.scans || 0) +
      Number(report.scenario.newPackerOrders?.orders || 0) +
      Number(report.scenario.pickPackPickStats?.scans || 0) +
      Number(report.scenario.pickPackOrders?.orders || 0);

    report.rewards.sync = await waitForCoinSync(
      mainDb,
      tempUsers.map((user) => user.userId),
      expectedRewardEvents,
      30000
    );
    report.rewards.summary = await loadRewardSummary(mainDb, skladDb, tempUsers);
    report.finalState = await loadFinalSupplyState(mainDb, SUPPLY_ID);

    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
    log(`Отчёт сохранён: ${reportPath}`);
  } finally {
    report.cleanup.startedAt = nowIso();
    report.cleanup.keepState = KEEP_STATE;
    if (!KEEP_STATE) {
      try {
        if (tempWarehouseActors.length) {
          report.cleanup.warehouse = await cleanupWarehouseArtifacts(skladDb, SUPPLY_ID, startedAtIso, tempWarehouseActors);
        }
      } catch (error) {
        report.cleanup.warehouseError = error.message || String(error);
      }
      try {
        await cleanupAppArtifacts(mainDb, SUPPLY_ID, tempUsers, sessionTokens);
        report.cleanup.app = { ok: true };
      } catch (error) {
        report.cleanup.appError = error.message || String(error);
      }
    }
    report.cleanup.finishedAt = nowIso();
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
    await Promise.allSettled([mainDb.end(), skladDb.end()]);
  }
}

main().catch((error) => {
  console.error("[autotest] FAILED", error?.stack || error?.message || error);
  process.exit(1);
});
