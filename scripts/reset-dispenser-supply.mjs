import fs from "node:fs";
import path from "node:path";
import {
  connectAuto,
  loadEnv,
  mainDbConfig,
  rootDir,
  skladDbConfig,
} from "./db-common.mjs";

const supplyId = String(process.argv[2] || "").trim();
const execute = process.argv.includes("--execute");
if (!supplyId || !execute) {
  throw new Error("Usage: node scripts/reset-dispenser-supply.mjs <supply-id> --execute");
}

loadEnv();
const main = await connectAuto(mainDbConfig());
const sklad = await connectAuto(skladDbConfig());
const resetMarkerPrefix = `[wb-dispenser-reset:${supplyId}:`;

async function mainRows(text, params = []) {
  return (await main.query(text, params)).rows || [];
}

async function skladRows(text, params = []) {
  return (await sklad.query(text, params)).rows || [];
}

try {
  const [settings, orders, sessions, access, parts, operations, reworks] = await Promise.all([
    mainRows("select * from supply_settings where supply_id = $1", [supplyId]),
    mainRows("select * from supply_orders where supply_id = $1 order by wb_order_id", [supplyId]),
    mainRows("select * from employee_supply_sessions where supply_id = $1 order by id", [supplyId]),
    mainRows("select * from supply_access_users where supply_id = $1 order by user_id", [supplyId]),
    mainRows("select * from supply_assignment_parts where supply_id = $1 order by id", [supplyId]),
    mainRows("select * from wb_dispenser_operations where supply_id = $1 order by id", [supplyId]),
    mainRows("select * from wb_dispenser_reworks where supply_id = $1 order by id", [supplyId]),
  ]);
  if (!settings.length || settings[0].dispenser_mode !== true) {
    throw new Error(`Поставка ${supplyId} не найдена или не является поставкой дозатора`);
  }
  if (!orders.length) throw new Error(`В поставке ${supplyId} нет заказов`);

  const movementPattern = `%Поставка ${supplyId}, заказ%`;
  const movements = await skladRows(
    `select * from movements_s where notes like $1 order by id`,
    [movementPattern]
  );
  const shelfMovements = await skladRows(
    `select * from shelf_movements_s where notes like $1 order by id`,
    [movementPattern]
  );
  const resetMovements = await skladRows(
    `select * from movements_s
      where source = 'wb_dispenser_reset'
        and notes like $1
      order by id`,
    [`%полном сбросе поставки ${supplyId}%`]
  );
  const resetMovementIds = new Set();
  for (const row of resetMovements) {
    const match = String(row.notes || "").match(/\[wb-dispenser-reset:[^:]+:(\d+)\]/);
    if (match) resetMovementIds.add(Number(match[1]));
  }
  const issueMovements = movements.filter(
    (row) => row.source === "wb_dispenser"
      && row.movement_type === "shelf_to_employee"
      && !resetMovementIds.has(Number(row.id))
  );
  const activeOrderIssuedAt = new Map();
  for (const row of issueMovements) {
    const match = String(row.notes || "").match(/заказ\s+(\d+)/i);
    if (match) activeOrderIssuedAt.set(match[1], new Date(row.created_at).getTime());
  }
  const writeoffs = movements.filter((row) => {
    if (row.source !== "wb_collect_bundle_components" || row.movement_type !== "employee_writeoff") return false;
    const match = String(row.notes || "").match(/заказ\s+(\d+)/i);
    const issuedAt = match ? activeOrderIssuedAt.get(match[1]) : null;
    return Number.isFinite(issuedAt) && new Date(row.created_at).getTime() >= issuedAt;
  });
  if (issueMovements.length !== operations.filter((row) => row.status === "dispensed").length) {
    throw new Error(`Движения выдачи не совпадают с операциями: движений ${issueMovements.length}, операций ${operations.length}`);
  }
  const issuedByProduct = new Map();
  const writtenByProduct = new Map();
  for (const row of issueMovements) {
    issuedByProduct.set(Number(row.product_id), Number(issuedByProduct.get(Number(row.product_id)) || 0) + Number(row.quantity || 0));
  }
  for (const row of writeoffs) {
    writtenByProduct.set(Number(row.product_id), Number(writtenByProduct.get(Number(row.product_id)) || 0) + Number(row.quantity || 0));
  }
  for (const [productId, quantity] of issuedByProduct) {
    if (Number(writtenByProduct.get(productId) || 0) > quantity) {
      throw new Error(`Товар ${productId}: выдано ${quantity}, но списано у сотрудника ${Number(writtenByProduct.get(productId) || 0)}. Автосброс остановлен.`);
    }
  }
  const outstandingInventory = new Map();
  for (const row of issueMovements) {
    const key = `${Number(row.to_employee_id)}:${Number(row.product_id)}`;
    const current = outstandingInventory.get(key) || {
      employeeId: Number(row.to_employee_id),
      productId: Number(row.product_id),
      quantity: 0,
    };
    current.quantity += Number(row.quantity || 0);
    outstandingInventory.set(key, current);
  }
  for (const row of writeoffs) {
    const key = `${Number(row.from_employee_id)}:${Number(row.product_id)}`;
    const current = outstandingInventory.get(key);
    if (!current) throw new Error(`Списание ${row.id} не соответствует активной выдаче дозатора`);
    current.quantity -= Number(row.quantity || 0);
    if (current.quantity < 0) throw new Error(`Отрицательный остаток сброса для сотрудника ${current.employeeId}, товар ${current.productId}`);
  }

  const backup = {
    createdAt: new Date().toISOString(),
    supplyId,
    settings,
    orders,
    sessions,
    access,
    parts,
    operations,
    reworks,
    movements,
    shelfMovements,
  };
  const backupDir = path.join(rootDir, "backups", "dispenser-resets");
  fs.mkdirSync(backupDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDir, `${supplyId}-${timestamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2), "utf8");

  const skladClient = await sklad.connect();
  try {
    await skladClient.query("begin");
    for (const item of outstandingInventory.values()) {
      if (!(item.quantity > 0)) continue;
      const inventory = await skladClient.query(
        `select quantity from employee_inventory_s
          where employee_id = $1 and product_id = $2
          for update`,
        [item.employeeId, item.productId]
      );
      const before = Number(inventory.rows?.[0]?.quantity || 0);
      if (before < item.quantity) {
        throw new Error(`У сотрудника ${item.employeeId} недостаточно товара ${item.productId}: ${before} вместо ${item.quantity}`);
      }
      await skladClient.query(
        `update employee_inventory_s
            set quantity = quantity - $3, updated_at = now()
          where employee_id = $1 and product_id = $2`,
        [item.employeeId, item.productId, item.quantity]
      );
      await skladClient.query(
        `insert into movements_s
          (movement_type, product_id, quantity, from_shelf_id, from_shelf_box_id,
           from_employee_id, to_employee_id, performed_by, notes, source, created_at)
         values ('employee_correction_out', $1, $2, null, null, $3, null, null, $4, 'wb_dispenser_reset', now())`,
        [
          item.productId,
          item.quantity,
          item.employeeId,
          `WB: очистка незавершённой выдачи при полном сбросе поставки ${supplyId}.`,
        ]
      );
    }
    for (const movement of [...issueMovements].sort((a, b) => Number(a.from_shelf_box_id) - Number(b.from_shelf_box_id) || Number(a.product_id) - Number(b.product_id))) {
      const marker = `${resetMarkerPrefix}${movement.id}]`;
      const existing = await skladClient.query(
        "select 1 from movements_s where source = 'wb_dispenser_reset' and notes like $1 limit 1",
        [`%${marker}%`]
      );
      if (existing.rows.length) continue;
      const quantity = Number(movement.quantity || 0);
      const boxId = Number(movement.from_shelf_box_id || 0);
      const shelfId = Number(movement.from_shelf_id || 0);
      const productId = Number(movement.product_id || 0);
      if (!(quantity > 0 && boxId > 0 && shelfId > 0 && productId > 0)) {
        throw new Error(`Некорректное складское движение ${movement.id}`);
      }
      const itemResult = await skladClient.query(
        `select quantity from shelf_box_items_s
          where shelf_box_id = $1 and product_id = $2
          for update`,
        [boxId, productId]
      );
      if (!itemResult.rows.length) throw new Error(`Не найдена позиция товара ${productId} в коробке ${boxId}`);
      const before = Number(itemResult.rows[0].quantity || 0);
      const after = before + quantity;
      await skladClient.query(
        `update shelf_box_items_s set quantity = $3, updated_at = now()
          where shelf_box_id = $1 and product_id = $2`,
        [boxId, productId, after]
      );
      await skladClient.query(
        `update shelf_boxes_s set quantity = $3
          where id = $1 and product_id = $2`,
        [boxId, productId, after]
      );
      const notes = `WB: возврат банки в дозатор при полном сбросе поставки ${supplyId}. Исходное движение ${movement.id}. ${marker}`;
      await skladClient.query(
        `insert into shelf_movements_s
          (shelf_id, product_id, operation_type, quantity_before, quantity_after,
           quantity_delta, user_id, notes, source, created_at)
         values ($1, $2, 'stock_in', $3, $4, $5, $6, $7, 'wb_dispenser_reset', now())`,
        [shelfId, productId, before, after, quantity, movement.performed_by, notes]
      );
      await skladClient.query(
        `insert into movements_s
          (movement_type, product_id, quantity, from_shelf_id, from_shelf_box_id,
           from_employee_id, to_employee_id, performed_by, notes, source, created_at)
         values ('manual_stock_restore', $1, $2, $3, $4, null, null, $5, $6, 'wb_dispenser_reset', now())`,
        [productId, quantity, shelfId, boxId, movement.performed_by, notes]
      );
    }
    await skladClient.query("commit");
  } catch (error) {
    await skladClient.query("rollback").catch(() => {});
    throw error;
  } finally {
    skladClient.release();
  }

  const mainClient = await main.connect();
  try {
    await mainClient.query("begin");
    await mainClient.query("delete from wb_dispenser_reworks where supply_id = $1", [supplyId]);
    await mainClient.query("delete from wb_dispenser_operations where supply_id = $1", [supplyId]);
    await mainClient.query("delete from wb_instant_bundle_component_scans where supply_id = $1", [supplyId]);
    await mainClient.query(
      `update supply_orders
          set assigned_user_id = null,
              assignment_part_id = null,
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
    await mainClient.query("delete from employee_supply_sessions where supply_id = $1", [supplyId]);
    await mainClient.query("delete from supply_assignment_parts where supply_id = $1", [supplyId]);
    await mainClient.query("delete from supply_access_users where supply_id = $1", [supplyId]);
    await mainClient.query(
      `update supply_settings
          set access_mode = 'hidden',
              employee_workflow_stage = 'orders_only',
              product_picking_started_at = null,
              product_picking_started_by = null,
              employee_close_completed_at = null,
              employee_close_completed_by = null,
              updated_at = now()
        where supply_id = $1`,
      [supplyId]
    );
    await mainClient.query("commit");
  } catch (error) {
    await mainClient.query("rollback").catch(() => {});
    throw error;
  } finally {
    mainClient.release();
  }

  console.log(JSON.stringify({
    ok: true,
    supplyId,
    resetOrders: orders.length,
    restoredJars: issueMovements.reduce((sum, row) => sum + Number(row.quantity || 0), 0),
    removedPerformerIds: [...new Set(orders.map((row) => Number(row.assigned_user_id)).filter(Boolean))],
    backupPath,
  }, null, 2));
} finally {
  await Promise.allSettled([main.end(), sklad.end()]);
}
