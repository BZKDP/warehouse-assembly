import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

const root = "/opt/grasklad-sborka";
const startAt = process.env.RECONCILE_START || "2026-09-08T00:00:00+03:00";
const endAt = process.env.RECONCILE_END || new Date().toISOString();
const targetWarehouseId = Number(process.env.RECONCILE_WAREHOUSE_ID || 46);

function loadEnv(filePath) {
  for (const raw of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx < 1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!process.env[key]) process.env[key] = value;
  }
}

function config(prefix = "") {
  const k = (name) => prefix ? `${prefix}_${name}` : name;
  return {
    host: process.env[k("DB_HOST")], port: Number(process.env[k("DB_PORT")] || 5432), database: process.env[k("DB_NAME")],
    user: process.env[k("DB_USER")], password: process.env[k("DB_PASSWORD")],
    ssl: String(process.env[k("DB_SSL")] || "disable").toLowerCase() === "disable" ? false : { rejectUnauthorized: false },
  };
}

const norm = (value) => String(value ?? "").replace(/\s+/g, "").trim().toUpperCase();
loadEnv(path.join(root, ".env"));
process.env.SKLAD_FBS_WAREHOUSE_ID = String(targetWarehouseId);
const app = new Client(config());
const sklad = new Client(config("SKLAD"));
await Promise.all([app.connect(), sklad.connect()]);
try {
  const user = (await app.query("select id, external_employee_id, external_full_name from users where lower(external_login)='stag1' limit 1")).rows[0];
  if (!user) throw new Error("stag1 not found");
  const userId = Number(user.id), externalEmployeeId = Number(user.external_employee_id);
  const employee = (await sklad.query("select id, full_name from employees_s where external_employee_id=$1 limit 1", [externalEmployeeId])).rows[0];
  if (!employee) throw new Error("Warehouse employee mapping not found");
  const skladEmployeeId = Number(employee.id);

  const ozRows = (await app.query(
    `select 'oz'::text marketplace, pi.assembly_id entity_id, pi.id pick_item_id, pi.article, pi.barcode, pi.product_name,
            pi.picked_qty::int quantity, s.picking_started_at activity_at
       from ozon_employee_assembly_pick_items pi
       join ozon_employee_assembly_sessions s on s.id=pi.session_id
      where pi.user_id=$1 and pi.picked_qty>0
        and coalesce(s.picking_started_at,pi.updated_at)>=$2::timestamptz
        and coalesce(s.picking_started_at,pi.updated_at)<$3::timestamptz`,
    [userId, startAt, endAt]
  )).rows;
  const wbRows = (await app.query(
    `select 'wb'::text marketplace, pi.supply_id entity_id, pi.id pick_item_id, pi.article, pi.barcode, pi.product_name,
            pi.picked_qty::int quantity, s.picking_started_at activity_at
       from employee_supply_pick_items pi
       join employee_supply_sessions s on s.id=pi.session_id
      where pi.user_id=$1 and pi.picked_qty>0
        and coalesce(s.picking_started_at,pi.updated_at)>=$2::timestamptz
        and coalesce(s.picking_started_at,pi.updated_at)<$3::timestamptz`,
    [userId, startAt, endAt]
  )).rows;
  const rows = [...ozRows, ...wbRows];
  const tokens = [...new Set(rows.flatMap(row => [row.barcode, row.article]).map(norm).filter(Boolean))];
  const { resolveWarehouseProductMeta } = await import(path.join(root, "apps/OZ/server/services/sklad-movements.mjs"));
  const metaMap = await resolveWarehouseProductMeta(tokens);

  const requirements = new Map();
  const unresolved = [];
  for (const row of rows) {
    const barcodeMeta = metaMap.get(norm(row.barcode));
    const articleMeta = metaMap.get(norm(row.article));
    const meta = barcodeMeta || articleMeta;
    if (!meta?.id) {
      unresolved.push({ ...row, reason: "Нет точной связи со складской карточкой" });
      continue;
    }
    const productId = Number(meta.id);
    const current = requirements.get(productId) || {
      productId, article: null, name: meta.name || row.product_name, required: 0, pickedRows: [],
    };
    current.required += Number(row.quantity || 0);
    current.pickedRows.push({ marketplace: row.marketplace, entityId: row.entity_id, pickItemId: Number(row.pick_item_id),
      article: row.article, barcode: row.barcode, quantity: Number(row.quantity), matchedBy: barcodeMeta ? "barcode" : "article" });
    requirements.set(productId, current);
  }

  const productIds = [...requirements.keys()];
  const products = productIds.length ? (await sklad.query(
    "select id, article, code, name, entity_type from products_s where id=any($1::int[]) order by article,id", [productIds]
  )).rows : [];
  const productMap = new Map(products.map(row => [Number(row.id), row]));

  const stockRows = productIds.length ? (await sklad.query(
    `select p.id product_id, 'box'::text location_type, sb.id location_id, sb.shelf_id, sbi.quantity,
            sb.name location_name, r.warehouse_id
       from products_s p join shelf_box_items_s sbi on sbi.product_id=p.id
       join shelf_boxes_s sb on sb.id=sbi.shelf_box_id join shelves_s s on s.id=sb.shelf_id join racks_s r on r.id=s.rack_id
      where p.id=any($1::int[]) and r.warehouse_id=$2
     union all
     select p.id, 'shelf'::text, si.shelf_id, si.shelf_id, si.quantity, s.name, r.warehouse_id
       from products_s p join shelf_items_s si on si.product_id=p.id
       join shelves_s s on s.id=si.shelf_id join racks_s r on r.id=s.rack_id
      where p.id=any($1::int[]) and r.warehouse_id=$2
        and (coalesce(s.uses_boxes,false)=false or not exists(
          select 1 from shelf_box_items_s x join shelf_boxes_s b on b.id=x.shelf_box_id
           where b.shelf_id=si.shelf_id and x.product_id=si.product_id and x.quantity>0))
      order by product_id, location_type, location_name`, [productIds, targetWarehouseId]
  )).rows : [];
  const targetLocations = new Map();
  for (const row of stockRows) {
    const list = targetLocations.get(Number(row.product_id)) || [];
    list.push({ ...row, product_id: Number(row.product_id), location_id: Number(row.location_id), shelf_id: Number(row.shelf_id), quantity: Number(row.quantity || 0) });
    targetLocations.set(Number(row.product_id), list);
  }

  const entityIds = [...new Set(rows.map(row => String(row.entity_id)))];
  const oldMoves = entityIds.length ? (await sklad.query(
    `select m.id, m.product_id, m.quantity, m.from_shelf_id, m.from_shelf_box_id, m.source, m.notes, m.created_at,
            coalesce(r.warehouse_id,rb.warehouse_id) warehouse_id
       from movements_s m
       left join shelves_s s on s.id=m.from_shelf_id left join racks_s r on r.id=s.rack_id
       left join shelf_boxes_s sb on sb.id=m.from_shelf_box_id left join shelves_s ss on ss.id=sb.shelf_id left join racks_s rb on rb.id=ss.rack_id
      where m.to_employee_id=$1 and m.movement_type='shelf_to_employee'
        and m.created_at>=$2::timestamptz and m.created_at<$3::timestamptz
        and m.notes ~ $4
      order by m.created_at,m.id`, [skladEmployeeId, startAt, endAt, entityIds.map(id => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")]
  )).rows : [];
  const movedByProduct = new Map();
  for (const move of oldMoves) {
    const id = Number(move.product_id);
    const entry = movedByProduct.get(id) || { total: 0, byWarehouse: {}, rows: [] };
    entry.total += Number(move.quantity || 0);
    const wid = String(move.warehouse_id || "unknown");
    entry.byWarehouse[wid] = (entry.byWarehouse[wid] || 0) + Number(move.quantity || 0);
    entry.rows.push({ ...move, id: Number(move.id), product_id: id, quantity: Number(move.quantity), warehouse_id: move.warehouse_id == null ? null : Number(move.warehouse_id) });
    movedByProduct.set(id, entry);
  }
  const previousCorrections = productIds.length ? (await sklad.query(
    `select product_id,movement_type,sum(quantity)::numeric quantity
       from movements_s
      where product_id=any($1::int[])
        and source like 'recon_stag1_0908_w46_v%'
        and movement_type in ('manual_stock_out','manual_stock_restore')
      group by product_id,movement_type`,
    [productIds]
  )).rows : [];
  const correctedByProduct = new Map();
  for (const row of previousCorrections) {
    const productId = Number(row.product_id);
    const current = correctedByProduct.get(productId) || { deducted: 0, restored: 0 };
    if (row.movement_type === "manual_stock_out") current.deducted += Number(row.quantity || 0);
    if (row.movement_type === "manual_stock_restore") current.restored += Number(row.quantity || 0);
    correctedByProduct.set(productId, current);
  }

  for (const requirement of requirements.values()) {
    const product = productMap.get(requirement.productId);
    requirement.article = product?.article || product?.code || null;
    requirement.name = product?.name || requirement.name;
    requirement.entityType = product?.entity_type || null;
    requirement.targetLocations = targetLocations.get(requirement.productId) || [];
    requirement.available = requirement.targetLocations.reduce((sum,row)=>sum+Math.max(0,Number(row.quantity||0)),0);
    requirement.previouslyMoved = movedByProduct.get(requirement.productId) || { total: 0, byWarehouse: {}, rows: [] };
    requirement.previouslyCorrected = correctedByProduct.get(requirement.productId) || { deducted: 0, restored: 0 };
    requirement.directTargetMoved = Number(requirement.previouslyMoved?.byWarehouse?.[String(targetWarehouseId)] || 0);
    requirement.targetAccounted = requirement.previouslyCorrected.deducted + requirement.directTargetMoved;
    requirement.remainingRequired = Math.max(0, requirement.required - requirement.targetAccounted);
    requirement.deductable = Math.min(requirement.remainingRequired, requirement.available);
    requirement.shortage = requirement.remainingRequired - requirement.deductable;
    requirement.remainingOldToRestore = Math.max(
      0,
      Number(requirement.previouslyMoved.byWarehouse["38"] || 0) - requirement.previouslyCorrected.restored
    );
    requirement.restoreFromOld = Math.min(requirement.deductable, requirement.remainingOldToRestore);
  }

  const report = {
    generatedAt: new Date().toISOString(), period:{startAt,endAt}, targetWarehouse:{id:targetWarehouseId,name:"FBS МОСКВА"},
    user:{userId,externalEmployeeId,skladEmployeeId,name:user.external_full_name||employee.full_name}, entityIds,
    summary:{
      pickedRows:rows.length, pickedUnits:rows.reduce((sum,row)=>sum+Number(row.quantity||0),0),
      resolvedUnits:[...requirements.values()].reduce((sum,row)=>sum+row.required,0),
      unresolvedUnits:unresolved.reduce((sum,row)=>sum+Number(row.quantity||0),0),
      targetDeductable:[...requirements.values()].reduce((sum,row)=>sum+row.deductable,0),
      targetShortage:[...requirements.values()].reduce((sum,row)=>sum+row.shortage,0),
      alreadyCorrected:[...requirements.values()].reduce((sum,row)=>sum+row.previouslyCorrected.deducted,0),
      directlyMovedFromTarget:[...requirements.values()].reduce((sum,row)=>sum+row.directTargetMoved,0),
      restoreFromOld:[...requirements.values()].reduce((sum,row)=>sum+row.restoreFromOld,0),
      existingOldMoves:oldMoves.reduce((sum,row)=>sum+Number(row.quantity||0),0),
    },
    requirements:[...requirements.values()].sort((a,b)=>String(a.article).localeCompare(String(b.article),"ru")), unresolved,
  };
  const outputPath=path.join(root,"backups",`stag1-pick-reconcile-plan-${new Date().toISOString().replace(/[:.]/g,"-")}.json`);
  fs.writeFileSync(outputPath,JSON.stringify(report,null,2));
  console.log(JSON.stringify({outputPath,summary:report.summary,
    deduct:report.requirements.filter(r=>r.deductable>0).map(r=>({productId:r.productId,article:r.article,name:r.name,required:r.required,alreadyCorrected:r.previouslyCorrected.deducted,remaining:r.remainingRequired,available:r.available,deduct:r.deductable,restore:r.restoreFromOld,shortage:r.shortage})),
    shortages:report.requirements.filter(r=>r.shortage>0).map(r=>({productId:r.productId,article:r.article,name:r.name,required:r.required,alreadyCorrected:r.previouslyCorrected.deducted,remaining:r.remainingRequired,available:r.available,shortage:r.shortage})),
    unresolved:report.unresolved.map(r=>({marketplace:r.marketplace,entityId:r.entity_id,article:r.article,barcode:r.barcode,name:r.product_name,quantity:Number(r.quantity)}))},null,2));
} finally { await Promise.allSettled([app.end(),sklad.end()]); }
