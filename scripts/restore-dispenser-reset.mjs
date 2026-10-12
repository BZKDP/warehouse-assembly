import fs from "node:fs";
import path from "node:path";
import {
  connectAuto,
  loadEnv,
  mainDbConfig,
  skladDbConfig,
} from "./db-common.mjs";

const backupPath = path.resolve(String(process.argv[2] || ""));
const execute = process.argv.includes("--execute");
if (!backupPath || !execute) {
  throw new Error("Usage: node scripts/restore-dispenser-reset.mjs <backup.json> --execute");
}

loadEnv();
const backup = JSON.parse(fs.readFileSync(backupPath, "utf8"));
const supplyId = String(backup.supplyId || "").trim();
if (!supplyId || !Array.isArray(backup.orders) || !backup.settings?.length) {
  throw new Error("Некорректная резервная копия сброса дозатора");
}

const main = await connectAuto(mainDbConfig());
const sklad = await connectAuto(skladDbConfig());
const quoteIdent = (value) => `"${String(value).replaceAll('"', '""')}"`;

async function restoreUpdates(client, table, rows, keyColumns) {
  for (const row of rows) {
    const columns = Object.keys(row).filter((column) => !keyColumns.includes(column));
    const setSql = columns.map((column, index) => `${quoteIdent(column)} = $${index + 1}`).join(", ");
    const whereSql = keyColumns
      .map((column, index) => `${quoteIdent(column)} = $${columns.length + index + 1}`)
      .join(" and ");
    const values = [
      ...columns.map((column) => row[column]),
      ...keyColumns.map((column) => row[column]),
    ];
    const result = await client.query(
      `update ${quoteIdent(table)} set ${setSql} where ${whereSql}`,
      values
    );
    if (result.rowCount !== 1) {
      throw new Error(`${table}: не удалось восстановить строку ${JSON.stringify(keyColumns.map((key) => row[key]))}`);
    }
  }
}

async function restoreInserts(client, table, rows) {
  if (!rows?.length) return;
  await client.query(
    `insert into ${quoteIdent(table)} overriding system value
     select * from json_populate_recordset(null::${quoteIdent(table)}, $1::json)`,
    [JSON.stringify(rows)]
  );
}

try {
  const current = await main.query(
    `select
       count(*)::int as orders,
       count(*) filter (where assigned_user_id is not null)::int as assigned,
       count(*) filter (where collected_at is not null)::int as collected
     from supply_orders where supply_id = $1`,
    [supplyId]
  );
  const currentChildren = await main.query(
    `select
       (select count(*) from employee_supply_sessions where supply_id = $1)::int as sessions,
       (select count(*) from supply_access_users where supply_id = $1)::int as access,
       (select count(*) from supply_assignment_parts where supply_id = $1)::int as parts,
       (select count(*) from wb_dispenser_operations where supply_id = $1)::int as operations,
       (select count(*) from wb_dispenser_reworks where supply_id = $1)::int as reworks`,
    [supplyId]
  );
  const state = current.rows[0];
  const children = currentChildren.rows[0];
  if (Number(state.orders) !== backup.orders.length || Number(state.assigned) || Number(state.collected)) {
    throw new Error(`Текущее состояние уже изменилось; восстановление остановлено: ${JSON.stringify(state)}`);
  }
  if (Object.values(children).some((value) => Number(value) !== 0)) {
    throw new Error(`После сброса появились новые дочерние записи; восстановление остановлено: ${JSON.stringify(children)}`);
  }

  const resetRows = await sklad.query(
    `select * from movements_s
      where source = 'wb_dispenser_reset'
        and movement_type = 'manual_stock_restore'
        and notes like $1
        and created_at >= $2::timestamptz
      order by id`,
    [`%полном сбросе поставки ${supplyId}%`, backup.createdAt]
  );
  const resetShelfRows = await sklad.query(
    `select * from shelf_movements_s
      where source = 'wb_dispenser_reset'
        and operation_type = 'stock_in'
        and notes like $1
        and created_at >= $2::timestamptz
      order by id`,
    [`%полном сбросе поставки ${supplyId}%`, backup.createdAt]
  );
  const correctionRows = await sklad.query(
    `select * from movements_s
      where source = 'wb_dispenser_reset'
        and movement_type = 'employee_correction_out'
        and notes like $1
        and created_at >= $2::timestamptz`,
    [`%полном сбросе поставки ${supplyId}%`, backup.createdAt]
  );
  const restoredQuantity = resetRows.rows.reduce((sum, row) => sum + Number(row.quantity || 0), 0);
  if (resetRows.rows.length !== resetShelfRows.rows.length || restoredQuantity <= 0) {
    throw new Error(`Не найден полный набор складских записей последнего сброса: movements=${resetRows.rows.length}, shelf=${resetShelfRows.rows.length}`);
  }
  if (correctionRows.rows.length) {
    throw new Error(`Последний сброс менял остатки сотрудника (${correctionRows.rows.length}); автоматическое восстановление остановлено`);
  }

  const expectedIssueIds = new Set();
  const priorResetIds = new Set();
  for (const row of backup.movements || []) {
    if (row.source !== "wb_dispenser_reset") continue;
    const match = String(row.notes || "").match(/\[wb-dispenser-reset:[^:]+:(\d+)\]/);
    if (match) priorResetIds.add(Number(match[1]));
  }
  for (const row of backup.movements || []) {
    if (row.source === "wb_dispenser" && row.movement_type === "shelf_to_employee" && !priorResetIds.has(Number(row.id))) {
      expectedIssueIds.add(Number(row.id));
    }
  }
  const actualIssueIds = new Set(resetRows.rows.map((row) => {
    const match = String(row.notes || "").match(/\[wb-dispenser-reset:[^:]+:(\d+)\]/);
    return match ? Number(match[1]) : 0;
  }));
  if (expectedIssueIds.size !== actualIssueIds.size || [...expectedIssueIds].some((id) => !actualIssueIds.has(id))) {
    throw new Error(`Складские записи не соответствуют резервной копии: expected=${[...expectedIssueIds]}, actual=${[...actualIssueIds]}`);
  }

  const mainClient = await main.connect();
  const skladClient = await sklad.connect();
  let mainCommitted = false;
  let skladCommitted = false;
  try {
    await mainClient.query("begin");
    await skladClient.query("begin");

    for (const movement of resetRows.rows) {
      const boxId = Number(movement.from_shelf_box_id);
      const productId = Number(movement.product_id);
      const quantity = Number(movement.quantity);
      const item = await skladClient.query(
        `select quantity from shelf_box_items_s
          where shelf_box_id = $1 and product_id = $2 for update`,
        [boxId, productId]
      );
      if (!item.rows.length || Number(item.rows[0].quantity) < quantity) {
        throw new Error(`Недостаточный остаток для отмены сброса: коробка ${boxId}, товар ${productId}`);
      }
      await skladClient.query(
        `update shelf_box_items_s set quantity = quantity - $3, updated_at = now()
          where shelf_box_id = $1 and product_id = $2`,
        [boxId, productId, quantity]
      );
      await skladClient.query(
        `update shelf_boxes_s set quantity = quantity - $3
          where id = $1 and product_id = $2`,
        [boxId, productId, quantity]
      );
    }
    await skladClient.query(
      "delete from shelf_movements_s where id = any($1::bigint[])",
      [resetShelfRows.rows.map((row) => Number(row.id))]
    );
    await skladClient.query(
      "delete from movements_s where id = any($1::bigint[])",
      [resetRows.rows.map((row) => Number(row.id))]
    );

    await restoreUpdates(mainClient, "supply_settings", backup.settings, ["supply_id"]);
    await restoreUpdates(mainClient, "supply_orders", backup.orders, ["supply_id", "wb_order_id"]);
    await restoreInserts(mainClient, "supply_access_users", backup.access);
    await restoreInserts(mainClient, "supply_assignment_parts", backup.parts);
    await restoreInserts(mainClient, "employee_supply_sessions", backup.sessions);
    await restoreInserts(mainClient, "wb_dispenser_operations", backup.operations);
    await restoreInserts(mainClient, "wb_dispenser_reworks", backup.reworks);

    await skladClient.query("commit");
    skladCommitted = true;
    await mainClient.query("commit");
    mainCommitted = true;
  } catch (error) {
    if (!skladCommitted) await skladClient.query("rollback").catch(() => {});
    if (!mainCommitted) await mainClient.query("rollback").catch(() => {});
    throw error;
  } finally {
    mainClient.release();
    skladClient.release();
  }

  console.log(JSON.stringify({
    ok: true,
    supplyId,
    restoredOrders: backup.orders.length,
    restoredCollected: backup.orders.filter((row) => row.collected_at).length,
    removedResetMovements: resetRows.rows.length,
    inventoryQuantityReapplied: restoredQuantity,
    backupPath,
  }, null, 2));
} finally {
  await Promise.allSettled([main.end(), sklad.end()]);
}
