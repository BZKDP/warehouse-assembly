import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

const root = "/opt/grasklad-sborka";
const source = "recon_stag1_0908_w46_v4";

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

function latestPlan() {
  const files = fs.readdirSync(path.join(root, "backups"))
    .filter(name => name.startsWith("stag1-pick-reconcile-plan-") && name.endsWith(".json"))
    .sort();
  if (!files.length) throw new Error("Reconciliation plan not found");
  return path.join(root, "backups", files.at(-1));
}

loadEnv(path.join(root, ".env"));
const planPath = process.env.RECONCILE_PLAN || latestPlan();
const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
if (Number(plan?.targetWarehouse?.id) !== 46) throw new Error("Unexpected target warehouse");
if (!Number.isFinite(Number(plan?.summary?.pickedUnits)) || Number(plan.summary.pickedUnits) < 1) {
  throw new Error("Unexpected picked quantity; rebuild and review the plan");
}

const db = new Client(config("SKLAD"));
await db.connect();
let backupPath = "";
try {
  await db.query("begin");
  await db.query("select pg_advisory_xact_lock(hashtext($1))", [source]);
  const existing = await db.query("select count(*)::int count from movements_s where source=$1", [source]);
  if (Number(existing.rows[0]?.count || 0) > 0) {
    await db.query("rollback");
    console.log(JSON.stringify({ ok: true, idempotent: true, source, existingRows: Number(existing.rows[0].count) }, null, 2));
    process.exit(0);
  }

  const actor = (await db.query(
    `select e.id employee_id, u.id user_id, e.full_name
       from employees_s e join users_s u on u.employee_id=e.id and coalesce(u.active,true)=true
      where e.external_employee_id=$1 and coalesce(e.active,true)=true order by u.id limit 1`,
    [Number(plan.user.externalEmployeeId)]
  )).rows[0];
  if (!actor?.user_id) throw new Error("Warehouse actor not found");

  const requirements = plan.requirements.filter(row => Number(row.deductable || 0) > 0);
  const productIds = requirements.map(row => Number(row.productId));
  const beforeTarget = await db.query(
    `select p.id product_id,p.article,p.name,'box'::text location_type,sb.id location_id,sb.shelf_id,
            sbi.quantity,sb.quantity box_quantity,sb.name location_name,r.warehouse_id
       from products_s p join shelf_box_items_s sbi on sbi.product_id=p.id
       join shelf_boxes_s sb on sb.id=sbi.shelf_box_id join shelves_s s on s.id=sb.shelf_id join racks_s r on r.id=s.rack_id
      where p.id=any($1::int[]) and r.warehouse_id=46
     union all
     select p.id,p.article,p.name,'shelf'::text,si.shelf_id,si.shelf_id,si.quantity,null,s.name,r.warehouse_id
       from products_s p join shelf_items_s si on si.product_id=p.id
       join shelves_s s on s.id=si.shelf_id join racks_s r on r.id=s.rack_id
      where p.id=any($1::int[]) and r.warehouse_id=46
      order by product_id,location_type,location_name`, [productIds]
  );
  const oldLocationPairs = requirements.flatMap(row => row.previouslyMoved.rows
    .filter(move => Number(move.warehouse_id) === 38)
    .map(move => ({ shelfId: Number(move.from_shelf_id || 0), shelfBoxId: Number(move.from_shelf_box_id || 0), productId: Number(row.productId) })));
  const beforeOld = oldLocationPairs.length ? await db.query(
    `select p.id product_id,p.article,p.name,m.location_type,m.location_id,m.shelf_id,m.quantity,m.box_quantity,m.location_name,38 warehouse_id
       from products_s p
       join lateral (
         select 'box'::text location_type,sb.id location_id,sb.shelf_id,sbi.quantity,sb.quantity box_quantity,sb.name location_name
           from shelf_box_items_s sbi join shelf_boxes_s sb on sb.id=sbi.shelf_box_id
          where sbi.product_id=p.id and sb.id=any($2::int[])
         union all
         select 'shelf'::text,si.shelf_id,si.shelf_id,si.quantity,null,s.name
           from shelf_items_s si join shelves_s s on s.id=si.shelf_id
          where si.product_id=p.id and si.shelf_id=any($3::int[])
       ) m on true
      where p.id=any($1::int[]) order by p.id,m.location_type,m.location_id`,
    [productIds, oldLocationPairs.map(x=>x.shelfBoxId).filter(Boolean), oldLocationPairs.map(x=>x.shelfId).filter(Boolean)]
  ) : { rows: [] };
  const beforeInventory = await db.query(
    `select i.employee_id,i.product_id,p.article,p.name,i.quantity
       from employee_inventory_s i join products_s p on p.id=i.product_id
      where i.employee_id=$1 and i.product_id=any($2::int[]) order by p.article`,
    [Number(actor.employee_id), productIds]
  );
  const backup = {
    createdAt: new Date().toISOString(), source, planPath,
    planSha256: crypto.createHash("sha256").update(fs.readFileSync(planPath)).digest("hex"),
    actor: { employeeId: Number(actor.employee_id), userId: Number(actor.user_id), name: actor.full_name },
    targetRows: beforeTarget.rows, oldRows: beforeOld.rows, employeeInventory: beforeInventory.rows,
  };
  backupPath = path.join(root, "backups", `${source}-before-${new Date().toISOString().replace(/[:.]/g,"-")}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
  const backupCheck = crypto.createHash("sha256").update(fs.readFileSync(backupPath)).digest("hex");

  const result = [];
  for (const requirement of requirements) {
    const productId = Number(requirement.productId);
    let remaining = Number(requirement.deductable);
    let deducted = 0;
    const locations = await db.query(
      `select * from (
         select 'box'::text location_type,sb.id location_id,sb.shelf_id,sbi.quantity,sb.name location_name
           from shelf_box_items_s sbi join shelf_boxes_s sb on sb.id=sbi.shelf_box_id
           join shelves_s s on s.id=sb.shelf_id join racks_s r on r.id=s.rack_id
          where sbi.product_id=$1 and r.warehouse_id=46 and sbi.quantity>0
         union all
         select 'shelf'::text,si.shelf_id,si.shelf_id,si.quantity,s.name
           from shelf_items_s si join shelves_s s on s.id=si.shelf_id join racks_s r on r.id=s.rack_id
          where si.product_id=$1 and r.warehouse_id=46 and si.quantity>0
            and (coalesce(s.uses_boxes,false)=false or not exists(
              select 1 from shelf_box_items_s x join shelf_boxes_s b on b.id=x.shelf_box_id
               where b.shelf_id=si.shelf_id and x.product_id=si.product_id and x.quantity>0))
       ) q order by location_name,location_type,location_id`, [productId]
    );
    for (const location of locations.rows) {
      if (remaining <= 0) break;
      const currentLocation = location.location_type === "box"
        ? await db.query("select quantity from shelf_box_items_s where shelf_box_id=$1 and product_id=$2 for update", [Number(location.location_id), productId])
        : await db.query("select quantity from shelf_items_s where shelf_id=$1 and product_id=$2 for update", [Number(location.location_id), productId]);
      const before = Number(currentLocation.rows[0]?.quantity || 0);
      const delta = Math.min(remaining, before);
      if (delta <= 0) continue;
      const after = before - delta;
      if (location.location_type === "box") {
        await db.query("update shelf_box_items_s set quantity=$3,updated_at=now() where shelf_box_id=$1 and product_id=$2", [Number(location.location_id), productId, after]);
        await db.query("update shelf_boxes_s set quantity=greatest(0,coalesce(quantity,0)-$2) where id=$1 and product_id=$3", [Number(location.location_id), delta, productId]);
      } else {
        await db.query("update shelf_items_s set quantity=$3,updated_at=now(),updated_by=$4 where shelf_id=$1 and product_id=$2", [Number(location.location_id), productId, after, Number(actor.user_id)]);
      }
      const note = `Коррекция склада stag1 за 08-09.09.2026: списание с FBS МОСКВА вместо ошибочного склада Москва 2; ${requirement.article}.`;
      await db.query(
        `insert into shelf_movements_s(shelf_id,product_id,operation_type,quantity_before,quantity_after,quantity_delta,user_id,notes,source,created_at)
         values($1,$2,'stock_out',$3,$4,$5,$6,$7,$8,now())`,
        [Number(location.shelf_id),productId,before,after,-delta,Number(actor.user_id),note,source]
      );
      await db.query(
        `insert into movements_s(movement_type,product_id,quantity,from_shelf_id,from_shelf_box_id,performed_by,notes,source,quantity_before,quantity_after,created_at)
         values('manual_stock_out',$1,$2,$3,$4,$5,$6,$7,$8,$9,now())`,
        [productId,delta,Number(location.shelf_id),location.location_type==="box"?Number(location.location_id):null,Number(actor.user_id),note,source,before,after]
      );
      remaining -= delta;
      deducted += delta;
    }
    if (remaining !== 0) throw new Error(`Target stock changed during apply for ${requirement.article}: missing ${remaining}`);

    let restoreRemaining = Math.min(deducted, Number(requirement.restoreFromOld || 0));
    let restored = 0;
    const oldMoves = requirement.previouslyMoved.rows.filter(move => Number(move.warehouse_id)===38);
    for (const move of oldMoves) {
      if (restoreRemaining <= 0) break;
      const delta = Math.min(restoreRemaining, Number(move.quantity || 0));
      if (delta <= 0) continue;
      const shelfId = Number(move.from_shelf_id || 0);
      const shelfBoxId = Number(move.from_shelf_box_id || 0);
      let before, after;
      if (shelfBoxId) {
        const locked = await db.query("select quantity from shelf_box_items_s where shelf_box_id=$1 and product_id=$2 for update", [shelfBoxId,productId]);
        before=Number(locked.rows[0]?.quantity||0); after=before+delta;
        await db.query(`insert into shelf_box_items_s(shelf_box_id,product_id,quantity,updated_at) values($1,$2,$3,now())
          on conflict(shelf_box_id,product_id) do update set quantity=excluded.quantity,updated_at=now()`,[shelfBoxId,productId,after]);
        await db.query("update shelf_boxes_s set quantity=coalesce(quantity,0)+$2 where id=$1 and product_id=$3",[shelfBoxId,delta,productId]);
      } else {
        const locked=await db.query("select quantity from shelf_items_s where shelf_id=$1 and product_id=$2 for update",[shelfId,productId]);
        before=Number(locked.rows[0]?.quantity||0); after=before+delta;
        await db.query(`insert into shelf_items_s(shelf_id,product_id,quantity,updated_by,updated_at) values($1,$2,$3,$4,now())
          on conflict(shelf_id,product_id) do update set quantity=excluded.quantity,updated_by=$4,updated_at=now()`,[shelfId,productId,after,Number(actor.user_id)]);
      }
      const note=`Коррекция склада stag1 за 08-09.09.2026: возврат на Москва 2 после переноса списания на FBS МОСКВА; исходное движение ${move.id}; ${requirement.article}.`;
      await db.query(`insert into shelf_movements_s(shelf_id,product_id,operation_type,quantity_before,quantity_after,quantity_delta,user_id,notes,source,created_at)
        values($1,$2,'stock_in',$3,$4,$5,$6,$7,$8,now())`,[shelfId,productId,before,after,delta,Number(actor.user_id),note,source]);
      await db.query(`insert into movements_s(movement_type,product_id,quantity,to_shelf_id,to_shelf_box_id,performed_by,notes,source,quantity_before,quantity_after,created_at)
        values('manual_stock_restore',$1,$2,$3,$4,$5,$6,$7,$8,$9,now())`,[productId,delta,shelfId,shelfBoxId||null,Number(actor.user_id),note,source,before,after]);
      restoreRemaining-=delta; restored+=delta;
    }
    if (restoreRemaining !== 0) throw new Error(`Unable to restore old warehouse for ${requirement.article}: ${restoreRemaining}`);
    result.push({productId,article:requirement.article,name:requirement.name,deducted,restored});
  }
  await db.query("commit");
  const verification = await db.query(
    `select movement_type,count(*)::int rows,sum(quantity)::numeric quantity
       from movements_s where source=$1 group by movement_type order by movement_type`, [source]
  );
  console.log(JSON.stringify({ok:true,source,planPath,backupPath,backupSha256:backupCheck,
    totals:{deducted:result.reduce((s,r)=>s+r.deducted,0),restored:result.reduce((s,r)=>s+r.restored,0),products:result.length},
    verification:verification.rows,result},null,2));
} catch (error) {
  await db.query("rollback").catch(()=>{});
  throw error;
} finally { await db.end(); }
