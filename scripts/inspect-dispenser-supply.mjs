import {
  connectAuto,
  loadEnv,
  mainDbConfig,
  skladDbConfig,
} from "./db-common.mjs";

const supplyId = process.argv[2];
if (!supplyId) throw new Error("Usage: node scripts/inspect-dispenser-supply.mjs <supply-id>");

loadEnv();
const main = await connectAuto(mainDbConfig());
const sklad = await connectAuto(skladDbConfig());

try {
  const settings = await main.query(
    `select supply_id, supply_name, access_mode, employee_workflow_stage,
            allow_employee_close, employee_close_completed_at, employee_close_completed_by,
            dispenser_mode, dispenser_warehouse_id, updated_at
       from supply_settings
      where supply_id = $1`,
    [supplyId]
  );
  const orders = await main.query(
    `select wb_order_id, article, assigned_user_id, scan_passed_at, scan_barcode,
            label_scan_passed_at, label_scan_barcode, collected_at, collected_by,
            collected_via, collected_session_id
       from supply_orders
      where supply_id = $1
      order by order_created_at asc nulls last, wb_order_id asc`,
    [supplyId]
  );
  const sessions = await main.query(
    `select id, user_id, status, assigned_at, started_at, finished_at,
            assigned_order_count, collected_order_count, assignment_part_id,
            session_role, picking_status
       from employee_supply_sessions
      where supply_id = $1
      order by id`,
    [supplyId]
  );
  const access = await main.query(
    `select user_id from supply_access_users where supply_id = $1 order by user_id`,
    [supplyId]
  );
  const parts = await main.query(
    `select * from supply_assignment_parts where supply_id = $1 order by id`,
    [supplyId]
  ).catch(() => ({ rows: [] }));
  const operations = await main.query(
    `select id, operation_token, wb_order_id, employee_id, status, error_message,
            plan, started_at, finished_at, created_at, updated_at
       from wb_dispenser_operations
      where supply_id = $1
      order by id`,
    [supplyId]
  );
  const trbxes = await main.query(
    `select id, trbx_id, orders_count, wb_barcode, qr_loaded_at, qr_error, created_at
       from supply_trbxes
      where supply_id = $1
      order by id`,
    [supplyId]
  );
  const movementText = `%Поставка ${supplyId}, заказ%`;
  const movements = await sklad.query(
    `select id, movement_type, product_id, quantity, from_shelf_id,
            from_shelf_box_id, from_employee_id, to_employee_id,
            source, notes, created_at
       from movements_s
      where notes like $1
      order by id`,
    [movementText]
  );
  const shelfMovements = await sklad.query(
    `select id, shelf_id, product_id, quantity_before, quantity_after,
            quantity_delta, source, notes, created_at
       from shelf_movements_s
      where notes like $1
      order by id`,
    [movementText]
  );
  const boxIds = [...new Set([
    ...operations.rows.flatMap((row) => row.plan?.components || []).map((item) => Number(item.boxId)),
    ...movements.rows.map((row) => Number(row.from_shelf_box_id)),
  ].filter(Boolean))];
  const productIds = [...new Set([
    ...operations.rows.flatMap((row) => row.plan?.components || []).map((item) => Number(item.productId)),
    ...movements.rows.map((row) => Number(row.product_id)),
  ].filter(Boolean))];
  const boxes = boxIds.length
    ? await sklad.query(
        `select sb.id, sb.shelf_id, sb.product_id, sb.quantity,
                sbi.product_id as item_product_id, sbi.quantity as item_quantity
           from shelf_boxes_s sb
           left join shelf_box_items_s sbi on sbi.shelf_box_id = sb.id
          where sb.id = any($1::int[])
          order by sb.id, sbi.product_id`,
        [boxIds]
      )
    : { rows: [] };
  const employeeIds = [...new Set(movements.rows.flatMap((row) => [Number(row.from_employee_id), Number(row.to_employee_id)]).filter(Boolean))];
  const inventory = employeeIds.length && productIds.length
    ? await sklad.query(
        `select employee_id, product_id, quantity
           from employee_inventory_s
          where employee_id = any($1::int[]) and product_id = any($2::int[])
          order by employee_id, product_id`,
        [employeeIds, productIds]
      )
    : { rows: [] };
  const movementTypes = await sklad.query(
    `select movement_type, count(*)::int as count
       from movements_s
      group by movement_type
      order by movement_type`
  );

  console.log(JSON.stringify({
    settings: settings.rows,
    orders: orders.rows,
    sessions: sessions.rows,
    access: access.rows,
    parts: parts.rows,
    operations: operations.rows,
    trbxes: trbxes.rows,
    movements: movements.rows,
    shelfMovements: shelfMovements.rows,
    boxes: boxes.rows,
    inventory: inventory.rows,
    movementTypes: movementTypes.rows,
  }, null, 2));
} finally {
  await Promise.allSettled([main.end(), sklad.end()]);
}
