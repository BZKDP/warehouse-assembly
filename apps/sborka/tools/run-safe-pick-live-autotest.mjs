import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..");
const projectRoot = path.resolve(appRoot, "../..");

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
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
}

loadEnv(path.join(projectRoot, ".env"));
loadEnv(path.join(appRoot, ".env"));

const apiRoot = (process.env.SAFE_PICK_TEST_API || "http://127.0.0.1:3008/sborka/api").replace(/\/$/, "");
const runKey = `${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${crypto.randomBytes(3).toString("hex")}`;
const ozAssemblyId = `AUTOTEST-OZ-${runKey}`;
const wbSupplyId = `AUTOTEST-WB-${runKey}`;
const markerEventId = `autotest-client-${runKey}`;
const reportDir = path.join(appRoot, "var", "test-runs");
const reportPath = path.join(reportDir, `safe-pick-live-${runKey}.json`);

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function makeMainDb() {
  return new Client({
    host: process.env.DB_HOST || "<SERVER_HOST>",
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || "gen_user",
    password: requiredEnv("DB_PASSWORD"),
    database: process.env.DB_NAME || "default_db",
    ssl: String(process.env.DB_SSL || "").toLowerCase() === "require" ? { rejectUnauthorized: false } : false,
  });
}

function makeSkladDb() {
  return new Client({
    host: requiredEnv("SKLAD_DB_HOST"),
    port: Number(process.env.SKLAD_DB_PORT || 5432),
    user: requiredEnv("SKLAD_DB_USER"),
    password: requiredEnv("SKLAD_DB_PASSWORD"),
    database: requiredEnv("SKLAD_DB_NAME"),
    ssl: String(process.env.SKLAD_DB_SSL || "").toLowerCase() === "require" ? { rejectUnauthorized: false } : false,
  });
}

function cookie(token) {
  return `sid=${token}`;
}

async function requestJson(token, url, { method = "GET", body, headers = {}, expected = [200] } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      Accept: "application/json",
      Cookie: cookie(token),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  if (!expected.includes(response.status)) {
    const error = new Error(`${method} ${url} returned ${response.status}: ${payload?.error || text}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return { status: response.status, payload };
}

function mpRequest(mp, token, route, options = {}) {
  return requestJson(token, `${apiRoot}/${mp}${route}`, options);
}

function rootRequest(token, route, options = {}) {
  return requestJson(token, `${apiRoot}${route}`, options);
}

async function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString("hex");
  await db.query(
    `insert into sessions (token, user_id, expires_at, created_at, updated_at, auth_fp)
     values ($1, $2, now() + interval '2 hours', now(), now(), null)`,
    [token, userId]
  );
  return token;
}

async function chooseProducts(skladDb) {
  const result = await skladDb.query(
    `select id, name, article, production_barcode
     from products_s
     where coalesce(archived, false) = false
       and coalesce(article, '') <> ''
       and coalesce(production_barcode, '') <> ''
     order by updated_at desc nulls last, id asc
     limit 20`
  );
  const products = [];
  for (const row of result.rows || []) {
    if (products.some((item) => item.article === row.article || item.production_barcode === row.production_barcode)) continue;
    products.push(row);
    if (products.length === 2) break;
  }
  assert.equal(products.length, 2, "Two warehouse products with distinct production barcodes are required");
  return products;
}

async function chooseUnknownBarcode(skladDb) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = `299${Date.now().toString().slice(-9)}${attempt}`.slice(0, 13);
    const result = await skladDb.query(
      `select 1
       from products_s p
       where regexp_replace(coalesce(p.production_barcode, ''), '\\s+', '', 'g') = $1
          or exists (
            select 1 from regexp_split_to_table(coalesce(p.barcode_list, ''), ';') as value
            where regexp_replace(btrim(value), '\\s+', '', 'g') = $1
          )
       limit 1`,
      [candidate]
    );
    if (!result.rows.length) return candidate;
  }
  throw new Error("Unable to allocate an unknown barcode");
}

async function setupFixtures(mainDb, products) {
  const adminResult = await mainDb.query(
    "select id from users where role = 'admin' order by id asc limit 1"
  );
  const adminId = Number(adminResult.rows?.[0]?.id || 0);
  assert.ok(adminId > 0, "Admin user is required");

  const userResult = await mainDb.query(
    `insert into users (
       surname, name, role, position, password_hash, password_salt,
       auth_source, location_code, location_configured_at, created_at, updated_at
     ) values ($1, $2, 'employee', 'packer', $3, $4, 'legacy', 'moscow', now(), now(), now())
     returning id`,
    ["AUTOTEST", `SAFE PICK ${runKey}`, `autotest-${runKey}`, `autotest-${runKey}`]
  );
  const employeeId = Number(userResult.rows[0].id);
  const adminToken = await createSession(mainDb, adminId);
  const employeeToken = await createSession(mainDb, employeeId);

  await mainDb.query(
    `insert into supply_settings (
       supply_id, supply_name, access_mode, labels_status, labels_total, labels_loaded,
       employee_workflow_mode, employee_workflow_stage, product_picking_started_at,
       product_picking_started_by, stock_method_enabled, allow_no_scan,
       allow_stock_shortage, location_code, created_at, updated_at
     ) values ($1, $2, 'selected_split', 'ready', 4, 4,
               'picking', 'pick_active', now(), $3, false, false, false, 'moscow', now(), now())`,
    [wbSupplyId, `AUTOTEST WB ${runKey}`, adminId]
  );
  await mainDb.query(
    "insert into supply_access_users (supply_id, user_id, created_at) values ($1, $2, now())",
    [wbSupplyId, employeeId]
  );

  const wbOrderBase = 8900000000000000 + Math.floor(Math.random() * 500000);
  const wbOrders = [];
  for (let productIndex = 0; productIndex < products.length; productIndex += 1) {
    const product = products[productIndex];
    for (let itemIndex = 0; itemIndex < 2; itemIndex += 1) {
      const orderId = wbOrderBase + productIndex * 10 + itemIndex;
      const stickerBarcode = `WBTEST${runKey.replace(/\D/g, "").slice(-8)}${productIndex}${itemIndex}`;
      await mainDb.query(
        `insert into supply_orders (
           supply_id, wb_order_id, order_created_at, article, barcode, product_name,
           nm_id, quantity, warehouse_id, cargo_type, sticker_url, sticker_barcode,
           assigned_user_id, assigned_at, synced_at, updated_at
         ) values ($1, $2, now(), $3, $4, $5, $6, 1, 1, 1, $7, $8, $9, now(), now(), now())`,
        [
          wbSupplyId,
          orderId,
          product.article,
          product.production_barcode,
          product.name,
          Number(product.id),
          `/sborka/test-label/${orderId}.pdf`,
          stickerBarcode,
          employeeId,
        ]
      );
      wbOrders.push({ id: orderId, product, stickerBarcode });
    }
  }

  await mainDb.query(
    `insert into ozon_assemblies (
       id, name, created_by, access_mode, labels_status, labels_total, labels_loaded,
       employee_workflow_mode, employee_workflow_stage, product_picking_started_at,
       product_picking_started_by, stock_method_enabled, allow_no_scan,
       allow_stock_shortage, location_code, created_at, updated_at
     ) values ($1, $2, $3, 'selected_split', 'ready', 4, 4,
               'picking', 'pick_active', now(), $3, false, false, false, 'moscow', now(), now())`,
    [ozAssemblyId, `AUTOTEST OZ ${runKey}`, adminId]
  );
  await mainDb.query(
    "insert into ozon_assembly_access_users (assembly_id, user_id, created_at) values ($1, $2, now())",
    [ozAssemblyId, employeeId]
  );

  const ozOrders = [];
  for (let productIndex = 0; productIndex < products.length; productIndex += 1) {
    const product = products[productIndex];
    for (let itemIndex = 0; itemIndex < 2; itemIndex += 1) {
      const postingNumber = `OZTEST-${runKey}-${productIndex}-${itemIndex}`;
      const labelBarcode = `OZLABEL${runKey.replace(/\D/g, "").slice(-8)}${productIndex}${itemIndex}`;
      await mainDb.query(
        `insert into ozon_assembly_orders (
           assembly_id, posting_number, order_created_at, ozon_status, label_barcode,
           label_s3_key, label_loaded_at, assigned_user_id, assigned_at, created_at, updated_at
         ) values ($1, $2, now(), 'awaiting_deliver', $3, $4, now(), $5, now(), now(), now())`,
        [ozAssemblyId, postingNumber, labelBarcode, `autotest/${postingNumber}.pdf`, employeeId]
      );
      await mainDb.query(
        `insert into ozon_assembly_order_items (
           assembly_id, posting_number, line_no, offer_id, sku, name,
           quantity, scanned_qty, created_at, updated_at
         ) values ($1, $2, 1, $3, $4, $5, 1, 0, now(), now())`,
        [ozAssemblyId, postingNumber, product.article, Number(product.id), product.name]
      );
      ozOrders.push({ postingNumber, product, labelBarcode });
    }
  }

  return { adminId, employeeId, adminToken, employeeToken, wbOrders, ozOrders };
}

async function testMarketplace({ mp, entityId, employeeToken, adminToken, products, orders, unknownBarcode, mainDb }) {
  const isOzon = mp === "oz";
  const entityRoute = isOzon ? `/employee/assemblies/${encodeURIComponent(entityId)}` : `/employee/supplies/${encodeURIComponent(entityId)}`;
  const issueEntityKey = isOzon ? "assemblyId" : "supplyId";
  const result = { entityId, steps: [] };

  const start = await mpRequest(mp, employeeToken, `${entityRoute}/start`, { method: "POST", body: {} });
  assert.equal(start.payload?.workflow?.currentStage, "picking", `${mp}: picking stage must start`);
  result.steps.push("start_picking");

  const initialItems = (await mpRequest(mp, employeeToken, `${entityRoute}/pick-items`)).payload.items || [];
  assert.equal(initialItems.length, 2, `${mp}: two product rows expected`);
  const firstItem = initialItems.find((item) => String(item.article).toUpperCase() === String(products[0].article).toUpperCase());
  const secondItem = initialItems.find((item) => String(item.article).toUpperCase() === String(products[1].article).toUpperCase());
  assert.ok(firstItem && secondItem, `${mp}: both warehouse articles must map to pick rows`);
  assert.equal(Number(firstItem.requiredQty), 2, `${mp}: first item required quantity`);
  assert.equal(Number(secondItem.requiredQty), 2, `${mp}: second item required quantity`);

  const firstScan = await mpRequest(mp, employeeToken, `${entityRoute}/pick-scan`, {
    method: "POST",
    body: { barcode: products[0].production_barcode },
  });
  assert.equal(Number(firstScan.payload?.item?.pickedQty), 1, `${mp}: first scan must produce 1/2`);
  const afterFirstScan = (await mpRequest(mp, employeeToken, `${entityRoute}/pick-items`)).payload.items || [];
  assert.equal(Number(afterFirstScan.find((item) => Number(item.id) === Number(firstItem.id))?.pickedQty), 1, `${mp}: row must remain at 1/2`);

  const secondScan = await mpRequest(mp, employeeToken, `${entityRoute}/pick-scan`, {
    method: "POST",
    body: { barcode: products[0].production_barcode },
  });
  assert.equal(Number(secondScan.payload?.item?.pickedQty), 2, `${mp}: second scan must produce 2/2`);
  const afterSecondScan = (await mpRequest(mp, employeeToken, `${entityRoute}/pick-items`)).payload.items || [];
  assert.ok(!afterSecondScan.some((item) => Number(item.id) === Number(firstItem.id)), `${mp}: completed row must disappear`);
  result.steps.push("increment_0_2_to_2_2_and_hide");

  const unknown = await mpRequest(mp, employeeToken, `${entityRoute}/pick-scan`, {
    method: "POST",
    body: { barcode: unknownBarcode },
    expected: [404],
  });
  assert.match(String(unknown.payload?.error || ""), /не найден/i, `${mp}: unknown scan error message`);

  const createIssue = async () => {
    const response = await mpRequest(mp, employeeToken, `${entityRoute}/pick-issue`, {
      method: "POST",
      body: {
        pickItemId: Number(secondItem.id),
        originalBarcode: unknownBarcode,
        barcode: unknownBarcode,
      },
    });
    assert.equal(response.payload?.issue?.originalScannedBarcode, unknownBarcode, `${mp}: original barcode snapshot`);
    assert.equal(response.payload?.issue?.confirmationScannedBarcode, unknownBarcode, `${mp}: confirmation barcode snapshot`);
    return response.payload.issue;
  };

  const issueForResolve = await createIssue();
  const employeeStatuses = (await mpRequest(mp, employeeToken, `${entityRoute}/pick-issues`)).payload.issues || [];
  assert.ok(employeeStatuses.some((issue) => Number(issue.id) === Number(issueForResolve.id) && issue.status === "open"), `${mp}: employee sees open issue`);

  let ozStoreId = null;
  if (isOzon) {
    const storeResult = await mainDb.query(
      "select store_id from ozon_assemblies where store_id is not null and btrim(store_id) <> '' order by created_at desc limit 1"
    );
    ozStoreId = storeResult.rows?.[0]?.store_id || null;
    assert.ok(ozStoreId, "Ozon store is required for admin issue routes");
    await mainDb.query("update ozon_assemblies set store_id = $2 where id = $1", [entityId, ozStoreId]);
  }
  const adminHeaders = ozStoreId ? { "X-Store-Id": ozStoreId } : {};
  const adminIssues = (await mpRequest(mp, adminToken, "/settings/scan-issues", { headers: adminHeaders })).payload.issues || [];
  assert.ok(adminIssues.some((issue) => Number(issue.id) === Number(issueForResolve.id) && String(issue[issueEntityKey]) === entityId), `${mp}: admin sees issue details`);
  await mpRequest(mp, adminToken, `/settings/scan-issues/${issueForResolve.id}/resolve`, {
    method: "POST",
    body: {},
    headers: adminHeaders,
  });
  const resolvedStatuses = (await mpRequest(mp, employeeToken, `${entityRoute}/pick-issues`)).payload.issues || [];
  assert.ok(resolvedStatuses.some((issue) => Number(issue.id) === Number(issueForResolve.id) && issue.status === "resolved"), `${mp}: employee sees resolved status`);
  result.steps.push("issue_create_status_admin_resolve");

  const issueForFix = await createIssue();
  const fixWithoutConfirmation = await mpRequest(mp, adminToken, `/settings/scan-issues/${issueForFix.id}/fix`, {
    method: "POST",
    body: {},
    headers: adminHeaders,
    expected: [409],
  });
  assert.equal(fixWithoutConfirmation.payload?.code, "FIX_CONFIRM_REQUIRED", `${mp}: fix confirmation code`);
  assert.equal(Number(fixWithoutConfirmation.payload?.remainingQuantity), 2, `${mp}: fix confirmation quantity`);
  await mpRequest(mp, adminToken, `/settings/scan-issues/${issueForFix.id}/fix`, {
    method: "POST",
    body: { confirmedQuantity: 2 },
    headers: adminHeaders,
  });
  if (isOzon) {
    await mainDb.query("update ozon_assemblies set store_id = null where id = $1", [entityId]);
  }
  const noPendingItems = (await mpRequest(mp, employeeToken, `${entityRoute}/pick-items`)).payload.items || [];
  assert.equal(noPendingItems.length, 0, `${mp}: admin fix must complete only remaining product row`);
  result.steps.push("fix_requires_quantity_and_completes_row");

  await mpRequest(mp, employeeToken, `${entityRoute}/pick-finish`, { method: "POST", body: {} });
  const packingStart = await mpRequest(mp, employeeToken, `${entityRoute}/start`, { method: "POST", body: {} });
  assert.equal(packingStart.payload?.workflow?.currentStage, "packing", `${mp}: packing stage must start`);

  const listedOrders = (await mpRequest(mp, employeeToken, `${entityRoute}/orders`)).payload.orders || [];
  assert.equal(listedOrders.length, orders.length, `${mp}: all synthetic orders must be listed`);
  for (const order of orders) {
    const orderId = isOzon ? order.postingNumber : order.id;
    await mpRequest(mp, employeeToken, `${entityRoute}/orders/${encodeURIComponent(orderId)}/scan`, {
      method: "POST",
      body: { barcode: order.product.production_barcode },
    });
    await mpRequest(mp, employeeToken, `${entityRoute}/orders/${encodeURIComponent(orderId)}/label-scan`, {
      method: "POST",
      body: { barcode: isOzon ? order.labelBarcode : order.stickerBarcode },
    });
  }
  result.steps.push("pack_and_complete_all_orders");

  const collectedResult = isOzon
    ? await mainDb.query("select count(*)::int as total from ozon_assembly_orders where assembly_id = $1 and collected_at is not null", [entityId])
    : await mainDb.query("select count(*)::int as total from supply_orders where supply_id = $1 and collected_at is not null", [entityId]);
  assert.equal(Number(collectedResult.rows?.[0]?.total || 0), orders.length, `${mp}: all orders must be collected`);
  return result;
}

async function cleanup(mainDb, fixture = {}) {
  await mainDb.query("begin");
  try {
    await mainDb.query("delete from ozon_assemblies where id = $1", [ozAssemblyId]);
    await mainDb.query("delete from supply_settings where supply_id = $1", [wbSupplyId]);
    if (fixture.employeeId) {
      await mainDb.query("delete from employee_coin_events where user_id = $1", [fixture.employeeId]).catch(() => {});
      await mainDb.query("delete from employee_coin_balances where user_id = $1", [fixture.employeeId]).catch(() => {});
      await mainDb.query("delete from sessions where user_id = $1", [fixture.employeeId]);
      await mainDb.query("delete from users where id = $1", [fixture.employeeId]);
    }
    if (fixture.adminToken) await mainDb.query("delete from sessions where token = $1", [fixture.adminToken]);
    await mainDb.query(
      `delete from application_error_logs
       where event_id = $1
          or request_path like $2
          or request_path like $3
          or user_id = $4`,
      [markerEventId, `%${ozAssemblyId}%`, `%${wbSupplyId}%`, fixture.employeeId || -1]
    ).catch(() => {});
    await mainDb.query("commit");
  } catch (error) {
    await mainDb.query("rollback");
    throw error;
  }
}

async function main() {
  fs.mkdirSync(reportDir, { recursive: true });
  const mainDb = makeMainDb();
  const skladDb = makeSkladDb();
  const report = { runKey, startedAt: new Date().toISOString(), ozAssemblyId, wbSupplyId, success: false };
  let fixture = {};
  await mainDb.connect();
  await skladDb.connect();
  try {
    const products = await chooseProducts(skladDb);
    const unknownBarcode = await chooseUnknownBarcode(skladDb);
    fixture = await setupFixtures(mainDb, products);
    report.products = products.map((product) => ({ id: Number(product.id), name: product.name, article: product.article, barcode: product.production_barcode }));
    report.unknownBarcode = unknownBarcode;

    await rootRequest(fixture.employeeToken, "/client-errors", {
      method: "POST",
      body: {
        eventId: markerEventId,
        source: "autotest_client",
        severity: "error",
        marketplace: "wb",
        message: "Synthetic client error used to verify persistence",
        context: { entityId: wbSupplyId },
        request: { method: "POST", url: `/autotest/${wbSupplyId}`, status: 599 },
        clientCreatedAt: new Date().toISOString(),
      },
      expected: [202],
    });
    const logApi = await rootRequest(fixture.adminToken, `/client-errors?eventId=${encodeURIComponent(markerEventId)}`);
    assert.equal(logApi.payload?.logs?.length, 1, "Client error API must persist and return the marker event");
    report.clientLogging = { persisted: true, eventId: markerEventId };

    report.wb = await testMarketplace({
      mp: "wb",
      entityId: wbSupplyId,
      employeeToken: fixture.employeeToken,
      adminToken: fixture.adminToken,
      products,
      orders: fixture.wbOrders,
      unknownBarcode,
      mainDb,
    });
    report.oz = await testMarketplace({
      mp: "oz",
      entityId: ozAssemblyId,
      employeeToken: fixture.employeeToken,
      adminToken: fixture.adminToken,
      products,
      orders: fixture.ozOrders,
      unknownBarcode,
      mainDb,
    });

    await new Promise((resolve) => setTimeout(resolve, 750));
    const logCountResult = await mainDb.query(
      `select count(*)::int as total
       from application_error_logs
       where event_id = $1 or request_path like $2 or request_path like $3 or user_id = $4`,
      [markerEventId, `%${ozAssemblyId}%`, `%${wbSupplyId}%`, fixture.employeeId]
    );
    report.loggedEventsBeforeCleanup = Number(logCountResult.rows?.[0]?.total || 0);
    assert.ok(report.loggedEventsBeforeCleanup >= 3, "Expected client and failed-request logs were not persisted");
    report.success = true;
  } catch (error) {
    report.error = { message: error?.message || String(error), stack: error?.stack || null, status: error?.status || null, payload: error?.payload || null };
    throw error;
  } finally {
    report.cleanupStartedAt = new Date().toISOString();
    try {
      await cleanup(mainDb, fixture);
      report.cleanup = { ok: true };
    } catch (cleanupError) {
      report.cleanup = { ok: false, error: cleanupError?.message || String(cleanupError) };
    }
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    await skladDb.end().catch(() => {});
    await mainDb.end().catch(() => {});
    console.log(JSON.stringify({ success: report.success, reportPath, cleanup: report.cleanup, wb: report.wb?.steps, oz: report.oz?.steps, loggedEventsBeforeCleanup: report.loggedEventsBeforeCleanup }, null, 2));
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
