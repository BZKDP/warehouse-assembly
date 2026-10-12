import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

const root="/opt/grasklad-sborka";
const source="ai_kutuz_fill_v1";
const planPath=process.env.PLAN_FILE||path.join(root,"apps/sborka/tools/kutuzovskaya-batch-01-plan.json");
for(const raw of fs.readFileSync(path.join(root,".env"),"utf8").split(/\r?\n/)){const line=raw.trim();if(!line||line.startsWith("#"))continue;const i=line.indexOf("=");if(i<1)continue;const k=line.slice(0,i).trim();let v=line.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);if(!process.env[k])process.env[k]=v;}
const plan=JSON.parse(fs.readFileSync(planPath,"utf8"));
const db=new Client({host:process.env.SKLAD_DB_HOST,port:Number(process.env.SKLAD_DB_PORT||5432),database:process.env.SKLAD_DB_NAME,user:process.env.SKLAD_DB_USER,password:process.env.SKLAD_DB_PASSWORD,ssl:String(process.env.SKLAD_DB_SSL||"disable").toLowerCase()==="disable"?false:{rejectUnauthorized:false}});

await db.connect();
let backupPath="";
try{
  await db.query("begin");
  await db.query("select pg_advisory_xact_lock(hashtext($1))",[source]);
  const warehouse=(await db.query("select id,name from warehouses_s where id=$1 for update",[Number(plan.warehouseId)])).rows[0];
  if(!warehouse||warehouse.name!==plan.warehouseName)throw new Error("Целевой склад не найден или изменён");
  if(plan.items.length!==41||new Set(plan.items.map(row=>row.article)).size!==41)throw new Error("План должен содержать 41 уникальный артикул");
  if(plan.items.some(row=>!row.article||!Number.isInteger(Number(row.quantity))||Number(row.quantity)<=0))throw new Error("План содержит некорректный артикул или количество");

  const existingSource=await db.query("select count(*)::int count,coalesce(sum(quantity_delta),0)::numeric quantity from shelf_movements_s where source=$1",[source]);
  if(Number(existingSource.rows[0].count)>0){
    await db.query("rollback");
    console.log(JSON.stringify({ok:true,idempotent:true,source,existing:existingSource.rows[0]},null,2));
    process.exit(0);
  }

  const articles=plan.items.map(row=>String(row.article).toUpperCase());
  const products=(await db.query(`select id,article,name,coalesce(archived,false) archived from products_s where upper(article)=any($1::text[]) order by article for update`,[articles])).rows;
  const byArticle=new Map(products.map(row=>[String(row.article).toUpperCase(),row]));
  const missing=articles.filter(article=>!byArticle.has(article));
  if(missing.length)throw new Error(`Не найдены карточки: ${missing.join(", ")}`);
  if(products.some(row=>row.archived))throw new Error("В плане обнаружена архивная складская карточка");

  const boxes=(await db.query(`select b.*,s.number shelf_number,s.name shelf_name,r.id rack_id,r.number rack_number
    from shelf_boxes_s b join shelves_s s on s.id=b.shelf_id join racks_s r on r.id=s.rack_id
    where r.warehouse_id=$1 order by r.number,s.number,b.position for update`,[Number(plan.warehouseId)])).rows;
  if(boxes.length!==41)throw new Error(`Ожидалось 41 коробка, найдено ${boxes.length}`);
  const boxIds=boxes.map(row=>Number(row.id));
  const existingItems=(await db.query("select * from shelf_box_items_s where shelf_box_id=any($1::int[]) order by shelf_box_id,product_id for update",[boxIds])).rows;
  if(existingItems.length||boxes.some(row=>row.product_id!==null||Number(row.quantity)!==0))throw new Error("Некоторые коробки уже заняты; заполнение остановлено");

  const backup={createdAt:new Date().toISOString(),source,planPath,planSha256:crypto.createHash("sha256").update(fs.readFileSync(planPath)).digest("hex"),warehouse,boxes,existingItems,products};
  const backupBody=JSON.stringify(backup,null,2);
  backupPath=path.join(root,"backups",`kutuzovskaya-fill-before-${new Date().toISOString().replace(/[:.]/g,"-")}.json`);
  fs.writeFileSync(backupPath,backupBody,{mode:0o600});

  const assignments=[];
  for(let index=0;index<plan.items.length;index++){
    const item=plan.items[index];
    const product=byArticle.get(String(item.article).toUpperCase());
    const box=boxes[index];
    const quantity=Number(item.quantity);
    await db.query(`insert into shelf_box_items_s(shelf_box_id,product_id,quantity,updated_at) values($1,$2,$3,now())`,[Number(box.id),Number(product.id),quantity]);
    await db.query(`update shelf_boxes_s set product_id=$2,quantity=$3,box_size=$3,status='closed',confirmed=true,closed_at=now() where id=$1`,[Number(box.id),Number(product.id),quantity]);
    const notes=`Кутузовская 31, начальное заполнение: ${product.article} -> ${box.name}`;
    await db.query(`insert into shelf_movements_s(shelf_id,product_id,operation_type,quantity_before,quantity_after,quantity_delta,user_id,notes,source,created_at)
      values($1,$2,'stock_in',0,$3,$3,null,$4,$5,now())`,[Number(box.shelf_id),Number(product.id),quantity,notes,source]);
    assignments.push({boxId:Number(box.id),box:box.name,shelf:box.shelf_name,productId:Number(product.id),article:product.article,name:product.name,quantity});
  }
  await db.query("commit");

  const verification=(await db.query(`select count(distinct b.id)::int boxes,count(distinct b.product_id)::int products,
    coalesce(sum(b.quantity),0)::numeric box_quantity,coalesce(sum(i.quantity),0)::numeric item_quantity,
    count(*) filter(where b.quantity<0 or i.quantity<0)::int negative_rows
    from shelf_boxes_s b join shelves_s s on s.id=b.shelf_id join racks_s r on r.id=s.rack_id
    join shelf_box_items_s i on i.shelf_box_id=b.id and i.product_id=b.product_id where r.warehouse_id=$1`,[Number(plan.warehouseId)])).rows[0];
  const movementVerification=(await db.query("select count(*)::int rows,coalesce(sum(quantity_delta),0)::numeric quantity from shelf_movements_s where source=$1",[source])).rows[0];
  console.log(JSON.stringify({ok:true,source,backupPath,backupSha256:crypto.createHash("sha256").update(backupBody).digest("hex"),verification,movementVerification,assignments},null,2));
}catch(error){await db.query("rollback").catch(()=>{});throw error;}finally{await db.end();}
