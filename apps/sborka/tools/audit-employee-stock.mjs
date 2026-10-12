import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
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
    if (!process.env[key]) process.env[key] = value;
  }
}

function usage() {
  console.log(
    [
      "Usage:",
      "  node tools/audit-employee-stock.mjs wb <SUPPLY_ID> [--json]",
      "  node tools/audit-employee-stock.mjs oz <ASSEMBLY_ID> [--json]",
      "",
      "Examples:",
      "  node tools/audit-employee-stock.mjs wb WB-GI-227837807",
      "  node tools/audit-employee-stock.mjs oz ozon-1775034942151-c51b21 --json",
    ].join("\n")
  );
}

function toInt(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeText(value) {
  return String(value || "").trim();
}

function unique(values = []) {
  return Array.from(new Set(values.filter(Boolean)));
}

function makeName(row) {
  return (
    normalizeText(row?.external_full_name) ||
    normalizeText(row?.full_name) ||
    normalizeText([row?.surname, row?.name].filter(Boolean).join(" ")) ||
    `user:${row?.user_id || row?.id || "?"}`
  );
}

function extractArticleFromNotes(notes) {
  const text = String(notes || "");
  const match = text.match(/(?:товар|item)\s+([^(),.]+?)(?=\s*(?:\(|,|\.|$))/iu);
  return normalizeText(match?.[1] || "");
}

function buildPgClient({ host, port, user, password, database, sslMode }) {
  const ssl = String(sslMode || "disable").toLowerCase() === "disable" ? false : { rejectUnauthorized: false };
  return new Client({ host, port: toInt(port, 5432), user, password, database, ssl });
}

async function query(client, sql, params = []) {
  const result = await client.query(sql, params);
  return result.rows || [];
}

async function loadConfig() {
  loadEnv(path.join(PROJECT_ROOT, ".env"));
  return {
    appDb: {
      host: process.env.DB_HOST || "<SERVER_HOST>",
      port: toInt(process.env.DB_PORT, 5432),
      user: process.env.DB_USER || "gen_user",
      password: process.env.DB_PASSWORD || "",
      database: process.env.DB_NAME || "default_db",
      sslMode: process.env.DB_SSL || "disable",
    },
    skladDb: {
      host: process.env.SKLAD_DB_HOST || process.env.AUTH_DB_HOST || "localhost",
      port: toInt(process.env.SKLAD_DB_PORT || process.env.AUTH_DB_PORT, 5432),
      user: process.env.SKLAD_DB_USER || process.env.AUTH_DB_USER || "danila",
      password: process.env.SKLAD_DB_PASSWORD || process.env.AUTH_DB_PASSWORD || "",
      database: process.env.SKLAD_DB_NAME || process.env.AUTH_DB_NAME || "bd2",
      sslMode: process.env.SKLAD_DB_SSL || process.env.AUTH_DB_SSL || "disable",
    },
    warehouseId: toInt(process.env.SKLAD_FBS_WAREHOUSE_ID, 1),
  };
}

async function loadWbData(appClient, entityId) {
  const [settings] = await query(
    appClient,
    `select supply_id, supply_name, store_id, store_name, access_mode, employee_workflow_mode, employee_workflow_stage, stock_method_enabled, created_at
     from supply_settings
     where supply_id = $1
     limit 1`,
    [entityId]
  );
  if (!settings) {
    throw new Error(`WB supply not found: ${entityId}`);
  }
  const sessions = await query(
    appClient,
    `select s.id, s.supply_id, s.user_id, s.status, s.assignment_mode, s.assigned_order_count, s.collected_order_count,
            s.picking_status, s.picking_required_qty, s.picking_collected_qty,
            s.assigned_at, s.started_at, s.finished_at, s.picking_started_at, s.picking_finished_at,
            u.external_employee_id, u.external_full_name, u.surname, u.name
     from employee_supply_sessions s
     join users u on u.id = s.user_id
     where s.supply_id = $1
     order by s.id asc`,
    [entityId]
  );
  const pickItems = await query(
    appClient,
    `select id, session_id, supply_id, user_id, item_key, article, barcode, product_name, required_qty, picked_qty,
            bypass_without_scan_allowed, bypass_authorized_at, bypass_authorized_by, updated_at
     from employee_supply_pick_items
     where supply_id = $1
     order by user_id asc, article asc, id asc`,
    [entityId]
  );
  const orders = await query(
    appClient,
    `select wb_order_id, assigned_user_id, article, barcode, product_name, quantity,
            scan_passed_at, label_scan_passed_at, collected_at, scan_barcode
     from supply_orders
     where supply_id = $1
     order by assigned_user_id asc nulls first, wb_order_id asc`,
    [entityId]
  );
  const issues = await query(
    appClient,
    `select id, employee_id, wb_order_id, pick_item_id, issue_stage, status, article, product_name,
            scanned_barcode, order_barcode, error_message, context_note, created_at, resolved_at, fixed_at
     from employee_scan_issues
     where supply_id = $1
     order by created_at asc, id asc`,
    [entityId]
  );
  return {
    marketplace: "wb",
    entityKind: "supply",
    entityId,
    settings,
    sessions,
    pickItems,
    orders,
    issues,
    movementSources: { in: "wb_pick_scan", out: "wb_collect" },
  };
}

async function loadOzData(appClient, entityId) {
  const [assembly] = await query(
    appClient,
    `select id, name, store_id, store_name, access_mode, employee_workflow_mode, employee_workflow_stage, stock_method_enabled, created_at
     from ozon_assemblies
     where id = $1
     limit 1`,
    [entityId]
  );
  if (!assembly) {
    throw new Error(`OZ assembly not found: ${entityId}`);
  }
  const sessions = await query(
    appClient,
    `select s.id, s.assembly_id as supply_id, s.user_id, s.status, s.assignment_mode, s.assigned_order_count, s.collected_order_count,
            s.picking_status, s.picking_required_qty, s.picking_collected_qty,
            s.assigned_at, s.started_at, s.finished_at, s.picking_started_at, s.picking_finished_at,
            u.external_employee_id, u.external_full_name, u.surname, u.name
     from ozon_employee_assembly_sessions s
     join users u on u.id = s.user_id
     where s.assembly_id = $1
     order by s.id asc`,
    [entityId]
  );
  const pickItems = await query(
    appClient,
    `select id, session_id, assembly_id as supply_id, user_id, item_key, article, barcode, product_name, required_qty, picked_qty,
            bypass_without_scan_allowed, bypass_authorized_at, bypass_authorized_by, updated_at
     from ozon_employee_assembly_pick_items
     where assembly_id = $1
     order by user_id asc, article asc, id asc`,
    [entityId]
  );
  const orders = await query(
    appClient,
    `select o.posting_number as wb_order_id, o.assigned_user_id, i.offer_id as article,
            coalesce(nullif(i.name, ''), '') as product_name,
            coalesce(i.quantity, 1) as quantity,
            o.scan_passed_at, o.label_scan_passed_at, o.collected_at, o.scan_barcode
     from ozon_assembly_orders o
     join ozon_assembly_order_items i
       on i.assembly_id = o.assembly_id and i.posting_number = o.posting_number
     where o.assembly_id = $1
     order by o.assigned_user_id asc nulls first, o.posting_number asc, i.line_no asc`,
    [entityId]
  );
  const issues = await query(
    appClient,
    `select id, employee_id, posting_number as wb_order_id, pick_item_id, issue_stage, status,
            coalesce(item_articles[1], null) as article,
            coalesce(item_names[1], null) as product_name,
            scanned_barcode, error_message, context_note, created_at, resolved_at, fixed_at
     from ozon_employee_scan_issues
     where assembly_id = $1
     order by created_at asc, id asc`,
    [entityId]
  );
  return {
    marketplace: "oz",
    entityKind: "assembly",
    entityId,
    settings: {
      supply_id: assembly.id,
      supply_name: assembly.name,
      store_id: assembly.store_id,
      store_name: assembly.store_name,
      access_mode: assembly.access_mode,
      employee_workflow_mode: assembly.employee_workflow_mode,
      employee_workflow_stage: assembly.employee_workflow_stage,
      stock_method_enabled: assembly.stock_method_enabled,
      created_at: assembly.created_at,
    },
    sessions,
    pickItems,
    orders,
    issues,
    movementSources: { in: "oz_pick_scan", out: "oz_collect" },
  };
}

async function loadSkladContext(skladClient, report, warehouseId) {
  const externalIds = unique(report.sessions.map((row) => toInt(row.external_employee_id, 0)).filter((value) => value > 0));
  const employees = externalIds.length
    ? await query(
        skladClient,
        `select id, external_employee_id, full_name
         from employees_s
         where external_employee_id = any($1::int[])`,
        [externalIds]
      )
    : [];

  const movementRows = await query(
    skladClient,
    `select m.id, m.source, m.product_id, p.code as product_code, p.name as product_name, m.quantity,
            m.from_employee_id, m.to_employee_id, m.created_at, m.notes
     from movements_s m
     join products_s p on p.id = m.product_id
     where m.source = any($2::text[])
       and m.notes ilike ('%' || $1 || '%')
     order by m.created_at asc, m.id asc`,
    [report.entityId, [report.movementSources.in, report.movementSources.out]]
  );

  const skladEmployeeIds = unique(employees.map((row) => toInt(row.id, 0)).filter((value) => value > 0));
  const inventoryRows = skladEmployeeIds.length
    ? await query(
        skladClient,
        `select i.employee_id, i.product_id, i.quantity, p.code as product_code, p.name as product_name
         from employee_inventory_s i
         join products_s p on p.id = i.product_id
         where i.employee_id = any($1::int[])
           and i.quantity <> 0
         order by i.employee_id asc, p.code asc`,
        [skladEmployeeIds]
      )
    : [];

  const negativeShelves = await query(
    skladClient,
    `select count(*)::int as count
     from shelf_items_s si
     join shelves_s s on s.id = si.shelf_id
     join racks_s r on r.id = s.rack_id
     where r.warehouse_id = $1
       and si.quantity < 0`,
    [warehouseId]
  );

  return {
    employees,
    movementRows,
    inventoryRows,
    negativeShelvesCount: toInt(negativeShelves[0]?.count, 0),
  };
}

function buildAuditReport(report, sklad) {
  const skladByExternalId = new Map();
  const skladById = new Map();
  for (const row of sklad.employees) {
    const externalEmployeeId = toInt(row.external_employee_id, 0);
    if (externalEmployeeId > 0) skladByExternalId.set(externalEmployeeId, row);
    skladById.set(toInt(row.id, 0), row);
  }

  const employees = report.sessions.map((session) => {
    const externalEmployeeId = toInt(session.external_employee_id, 0);
    const skladEmployee = skladByExternalId.get(externalEmployeeId) || null;
    return {
      userId: toInt(session.user_id, 0),
      appName: makeName(session),
      externalEmployeeId: externalEmployeeId || null,
      skladEmployeeId: skladEmployee ? toInt(skladEmployee.id, 0) : null,
      skladName: skladEmployee?.full_name || null,
      session: {
        id: toInt(session.id, 0),
        status: normalizeText(session.status),
        assignedOrderCount: toInt(session.assigned_order_count, 0),
        collectedOrderCount: toInt(session.collected_order_count, 0),
        pickingStatus: normalizeText(session.picking_status),
        pickingRequiredQty: toInt(session.picking_required_qty, 0),
        pickingCollectedQty: toInt(session.picking_collected_qty, 0),
        startedAt: session.started_at || null,
        finishedAt: session.finished_at || null,
        pickingStartedAt: session.picking_started_at || null,
        pickingFinishedAt: session.picking_finished_at || null,
      },
      pickItems: [],
      issues: [],
      movementByArticle: [],
      movementByProduct: [],
      currentInventory: [],
      anomalies: [],
      summary: {},
    };
  });

  const employeeByUserId = new Map(employees.map((row) => [row.userId, row]));
  const employeeBySkladId = new Map(
    employees.filter((row) => row.skladEmployeeId).map((row) => [row.skladEmployeeId, row])
  );

  for (const item of report.pickItems) {
    const employee = employeeByUserId.get(toInt(item.user_id, 0));
    if (!employee) continue;
    employee.pickItems.push({
      id: toInt(item.id, 0),
      article: normalizeText(item.article),
      barcode: normalizeText(item.barcode),
      productName: normalizeText(item.product_name),
      requiredQty: toInt(item.required_qty, 0),
      pickedQty: toInt(item.picked_qty, 0),
      bypassWithoutScanAllowed: item.bypass_without_scan_allowed === true,
      bypassAuthorizedAt: item.bypass_authorized_at || null,
      updatedAt: item.updated_at || null,
    });
  }

  for (const issue of report.issues) {
    const employee = employeeByUserId.get(toInt(issue.employee_id, 0));
    if (!employee) continue;
    employee.issues.push({
      id: toInt(issue.id, 0),
      stage: normalizeText(issue.issue_stage),
      status: normalizeText(issue.status),
      article: normalizeText(issue.article),
      productName: normalizeText(issue.product_name),
      orderId: normalizeText(issue.wb_order_id),
      scannedBarcode: normalizeText(issue.scanned_barcode),
      errorMessage: normalizeText(issue.error_message),
      createdAt: issue.created_at || null,
      fixedAt: issue.fixed_at || null,
      resolvedAt: issue.resolved_at || null,
    });
  }

  for (const row of sklad.inventoryRows) {
    const employee = employeeBySkladId.get(toInt(row.employee_id, 0));
    if (!employee) continue;
    employee.currentInventory.push({
      productId: toInt(row.product_id, 0),
      productCode: normalizeText(row.product_code),
      productName: normalizeText(row.product_name),
      quantity: Number(row.quantity || 0),
    });
  }

  for (const row of sklad.movementRows) {
    const source = normalizeText(row.source);
    const employeeId =
      source === report.movementSources.in ? toInt(row.to_employee_id, 0) : toInt(row.from_employee_id, 0);
    const employee = employeeBySkladId.get(employeeId);
    if (!employee) continue;
    const articleFromNotes = extractArticleFromNotes(row.notes) || normalizeText(row.product_code);
    const direction = source === report.movementSources.in ? "in" : "out";
    if (!employee.__articleMap) employee.__articleMap = new Map();
    if (!employee.__productMap) employee.__productMap = new Map();

    const articleKey = articleFromNotes || normalizeText(row.product_code) || `product:${row.product_id}`;
    const articleEntry =
      employee.__articleMap.get(articleKey) ||
      {
        article: articleKey,
        movementProductCodes: new Set(),
        inQty: 0,
        outQty: 0,
        movementIds: [],
      };
    articleEntry.movementProductCodes.add(normalizeText(row.product_code));
    articleEntry.movementIds.push(toInt(row.id, 0));
    articleEntry[direction === "in" ? "inQty" : "outQty"] += Number(row.quantity || 0);
    employee.__articleMap.set(articleKey, articleEntry);

    const productId = toInt(row.product_id, 0);
    const productEntry =
      employee.__productMap.get(productId) ||
      {
        productId,
        productCode: normalizeText(row.product_code),
        productName: normalizeText(row.product_name),
        sourceArticles: new Set(),
        inQty: 0,
        outQty: 0,
        currentQty: 0,
      };
    productEntry.sourceArticles.add(articleKey);
    productEntry[direction === "in" ? "inQty" : "outQty"] += Number(row.quantity || 0);
    employee.__productMap.set(productId, productEntry);
  }

  for (const employee of employees) {
    const inventoryByProduct = new Map(
      employee.currentInventory.map((row) => [row.productId, Number(row.quantity || 0)])
    );
    const articleMap = employee.__articleMap || new Map();
    const productMap = employee.__productMap || new Map();

    for (const [productId, entry] of productMap) {
      entry.currentQty = Number(inventoryByProduct.get(productId) || 0);
    }
    for (const row of employee.currentInventory) {
      if (productMap.has(row.productId)) continue;
      productMap.set(row.productId, {
        productId: row.productId,
        productCode: row.productCode,
        productName: row.productName,
        sourceArticles: new Set(),
        inQty: 0,
        outQty: 0,
        currentQty: Number(row.quantity || 0),
      });
    }

    employee.movementByArticle = Array.from(articleMap.values())
      .map((entry) => ({
        article: entry.article,
        movementProductCodes: Array.from(entry.movementProductCodes).filter(Boolean).sort(),
        inQty: entry.inQty,
        outQty: entry.outQty,
        netQty: entry.inQty - entry.outQty,
      }))
      .sort((left, right) => left.article.localeCompare(right.article, "ru"));

    employee.movementByProduct = Array.from(productMap.values())
      .map((entry) => ({
        productId: entry.productId,
        productCode: entry.productCode,
        productName: entry.productName,
        sourceArticles: Array.from(entry.sourceArticles).filter(Boolean).sort(),
        inQty: entry.inQty,
        outQty: entry.outQty,
        netQty: entry.inQty - entry.outQty,
        currentQty: entry.currentQty,
      }))
      .sort((left, right) => left.productCode.localeCompare(right.productCode, "ru"));

    const finished =
      employee.session.status === "finished" &&
      (!employee.session.pickingStatus || employee.session.pickingStatus === "finished");

    const anomalies = [];
    for (const pickItem of employee.pickItems) {
      const articleMovement =
        employee.movementByArticle.find((row) => row.article === pickItem.article) || null;
      if (pickItem.bypassWithoutScanAllowed && pickItem.pickedQty > 0 && (!articleMovement || articleMovement.inQty < pickItem.pickedQty)) {
        anomalies.push(
          `Bypass item ${pickItem.article}: picked ${pickItem.pickedQty}, but inbound movement is ${articleMovement?.inQty || 0}`
        );
      }
    }
    for (const row of employee.movementByArticle) {
      if (row.outQty > row.inQty) {
        anomalies.push(`Article ${row.article}: writeoff ${row.outQty} exceeds inbound ${row.inQty}`);
      }
      if (row.movementProductCodes.length && !row.movementProductCodes.includes(row.article)) {
        anomalies.push(
          `Article ${row.article}: movements were written to product code ${row.movementProductCodes.join(", ")}`
        );
      }
    }
    for (const row of employee.movementByProduct) {
      if (finished && row.netQty > 0) {
        anomalies.push(`Finished employee still has net ${row.netQty} from this entity on ${row.productCode}`);
      }
      if (finished && row.currentQty > 0 && row.netQty === 0 && row.sourceArticles.length) {
        anomalies.push(`Employee inventory still has ${row.currentQty} on ${row.productCode}, but entity net is already zero`);
      }
      if (row.currentQty < 0) {
        anomalies.push(`Employee inventory is negative on ${row.productCode}: ${row.currentQty}`);
      }
    }
    for (const issue of employee.issues) {
      if (issue.status === "fixed" && issue.stage === "pick_scan") {
        anomalies.push(`Fixed pick issue ${issue.id} for ${issue.article || "unknown article"} must be checked against inbound movement`);
      }
    }

    employee.anomalies = unique(anomalies);
    employee.summary = {
      finished,
      totalPickItems: employee.pickItems.length,
      totalIssues: employee.issues.length,
      inboundQty: employee.movementByProduct.reduce((sum, row) => sum + row.inQty, 0),
      writeoffQty: employee.movementByProduct.reduce((sum, row) => sum + row.outQty, 0),
      netQty: employee.movementByProduct.reduce((sum, row) => sum + row.netQty, 0),
      currentInventoryQty: employee.currentInventory.reduce((sum, row) => sum + Number(row.quantity || 0), 0),
      currentInventoryRows: employee.currentInventory.length,
      anomalyCount: employee.anomalies.length,
    };

    delete employee.__articleMap;
    delete employee.__productMap;
  }

  const summary = {
    marketplace: report.marketplace,
    entityKind: report.entityKind,
    entityId: report.entityId,
    entityName: normalizeText(report.settings.supply_name),
    storeId: normalizeText(report.settings.store_id),
    storeName: normalizeText(report.settings.store_name),
    workflowStage: normalizeText(report.settings.employee_workflow_stage),
    stockMethodEnabled: report.settings.stock_method_enabled === true,
    employees: employees.length,
    finishedEmployees: employees.filter((row) => row.summary.finished).length,
    inboundQty: employees.reduce((sum, row) => sum + row.summary.inboundQty, 0),
    writeoffQty: employees.reduce((sum, row) => sum + row.summary.writeoffQty, 0),
    netQty: employees.reduce((sum, row) => sum + row.summary.netQty, 0),
    currentInventoryRows: employees.reduce((sum, row) => sum + row.summary.currentInventoryRows, 0),
    currentInventoryQty: employees.reduce((sum, row) => sum + row.summary.currentInventoryQty, 0),
    anomalyCount: employees.reduce((sum, row) => sum + row.summary.anomalyCount, 0),
    openIssues: report.issues.filter((row) => normalizeText(row.status) === "open").length,
    fixedIssues: report.issues.filter((row) => normalizeText(row.status) === "fixed").length,
    negativeShelvesInWarehouse: sklad.negativeShelvesCount,
  };

  return { summary, employees };
}

function printHuman(report) {
  const lines = [];
  lines.push(`${report.summary.marketplace.toUpperCase()} ${report.summary.entityKind}: ${report.summary.entityId}`);
  lines.push(`Name: ${report.summary.entityName || "-"}`);
  lines.push(`Store: ${report.summary.storeName || "-"} (${report.summary.storeId || "-"})`);
  lines.push(
    `Totals: inbound=${report.summary.inboundQty}, writeoff=${report.summary.writeoffQty}, net=${report.summary.netQty}, anomalies=${report.summary.anomalyCount}`
  );
  lines.push(
    `Current employee inventory: rows=${report.summary.currentInventoryRows}, qty=${report.summary.currentInventoryQty}, negativeShelves=${report.summary.negativeShelvesInWarehouse}`
  );
  for (const employee of report.employees) {
    lines.push("");
    lines.push(
      `${employee.appName} | user=${employee.userId} | ext=${employee.externalEmployeeId || "-"} | sklad=${employee.skladEmployeeId || "-"}`
    );
    lines.push(
      `  session: status=${employee.session.status}, picking=${employee.session.pickingStatus}, assigned=${employee.session.assignedOrderCount}, collected=${employee.session.collectedOrderCount}, finished=${employee.summary.finished}`
    );
    lines.push(
      `  balance: inbound=${employee.summary.inboundQty}, writeoff=${employee.summary.writeoffQty}, net=${employee.summary.netQty}, currentQty=${employee.summary.currentInventoryQty}`
    );
    if (employee.anomalies.length) {
      lines.push(`  anomalies:`);
      for (const anomaly of employee.anomalies) {
        lines.push(`    - ${anomaly}`);
      }
    } else {
      lines.push(`  anomalies: none`);
    }
  }
  console.log(lines.join("\n"));
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    usage();
    process.exit(1);
  }
  const marketplace = normalizeText(args[0]).toLowerCase();
  const entityId = normalizeText(args[1]);
  const jsonOutput = args.includes("--json");
  if (!["wb", "oz"].includes(marketplace) || !entityId) {
    usage();
    process.exit(1);
  }

  const config = await loadConfig();
  const appClient = buildPgClient(config.appDb);
  const skladClient = buildPgClient(config.skladDb);
  await appClient.connect();
  await skladClient.connect();
  try {
    const reportBase =
      marketplace === "wb"
        ? await loadWbData(appClient, entityId)
        : await loadOzData(appClient, entityId);
    const sklad = await loadSkladContext(skladClient, reportBase, config.warehouseId);
    const report = buildAuditReport(reportBase, sklad);
    if (jsonOutput) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    printHuman(report);
  } finally {
    await Promise.allSettled([appClient.end(), skladClient.end()]);
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
