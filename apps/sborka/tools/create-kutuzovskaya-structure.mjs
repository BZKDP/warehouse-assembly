import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

const root="/opt/grasklad-sborka";
const warehouseId=47;
const boxCounts=[9,9,9,9,5];
for(const raw of fs.readFileSync(path.join(root,".env"),"utf8").split(/\r?\n/)){const line=raw.trim();if(!line||line.startsWith("#"))continue;const i=line.indexOf("=");if(i<1)continue;const k=line.slice(0,i).trim();let v=line.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);if(!process.env[k])process.env[k]=v;}
const db=new Client({host:process.env.SKLAD_DB_HOST,port:Number(process.env.SKLAD_DB_PORT||5432),database:process.env.SKLAD_DB_NAME,user:process.env.SKLAD_DB_USER,password:process.env.SKLAD_DB_PASSWORD,ssl:String(process.env.SKLAD_DB_SSL||"disable").toLowerCase()==="disable"?false:{rejectUnauthorized:false}});

async function uniqueBarcode(){
  for(let attempt=0;attempt<100;attempt++){
    const value=String(crypto.randomInt(100000000,1000000000));
    const found=await db.query(`select 1 from racks_s where barcode_value=$1 union all select 1 from shelves_s where barcode_value=$1 union all select 1 from shelf_boxes_s where barcode_value=$1 limit 1`,[value]);
    if(found.rowCount===0)return value;
  }
  throw new Error("Не удалось создать уникальный штрихкод");
}

await db.connect();
let backupPath="";
try{
  await db.query("begin");
  await db.query("select pg_advisory_xact_lock(hashtext($1))",[`warehouse-structure:${warehouseId}`]);
  const warehouse=(await db.query("select id,name from warehouses_s where id=$1 for update",[warehouseId])).rows[0];
  if(!warehouse||warehouse.name!=="Кутузовская 31")throw new Error("Склад Кутузовская 31 не найден или изменён");
  const before={
    createdAt:new Date().toISOString(),warehouse,
    racks:(await db.query("select * from racks_s where warehouse_id=$1 order by id",[warehouseId])).rows,
    shelves:(await db.query("select s.* from shelves_s s join racks_s r on r.id=s.rack_id where r.warehouse_id=$1 order by s.id",[warehouseId])).rows,
    boxes:(await db.query("select b.* from shelf_boxes_s b join shelves_s s on s.id=b.shelf_id join racks_s r on r.id=s.rack_id where r.warehouse_id=$1 order by b.id",[warehouseId])).rows
  };
  const body=JSON.stringify(before,null,2);
  backupPath=path.join(root,"backups",`kutuzovskaya-structure-before-${new Date().toISOString().replace(/[:.]/g,"-")}.json`);
  fs.writeFileSync(backupPath,body,{mode:0o600});
  if(before.racks.length||before.shelves.length||before.boxes.length){
    const exact=before.racks.length===1&&before.shelves.length===5&&before.boxes.length===41;
    if(!exact)throw new Error(`На складе уже есть неполная структура: ${before.racks.length} стеллажей, ${before.shelves.length} полок, ${before.boxes.length} коробок`);
    await db.query("rollback");
    console.log(JSON.stringify({ok:true,idempotent:true,warehouse,counts:{racks:1,shelves:5,boxes:41},backupPath},null,2));
    process.exit(0);
  }
  const rackBarcode=await uniqueBarcode();
  const rack=(await db.query(`insert into racks_s(warehouse_id,name,number,code,barcode_value,created_at,updated_at) values($1,$2,1,$3,$4,now(),now()) returning *`,[warehouseId,"Стеллаж 1","С1",rackBarcode])).rows[0];
  const shelves=[];const boxes=[];
  for(let shelfNumber=1;shelfNumber<=boxCounts.length;shelfNumber++){
    const shelfBarcode=await uniqueBarcode();
    const shelf=(await db.query(`insert into shelves_s(rack_id,name,number,code,barcode_value,uses_boxes,uses_loose,created_at,updated_at) values($1,$2,$3,$4,$5,true,false,now(),now()) returning *`,[rack.id,`Полка ${shelfNumber}`,shelfNumber,`С1П${shelfNumber}`,shelfBarcode])).rows[0];
    shelves.push(shelf);
    for(let position=1;position<=boxCounts[shelfNumber-1];position++){
      const barcode=await uniqueBarcode();
      const box=(await db.query(`insert into shelf_boxes_s(shelf_id,position,name,barcode_value,quantity,box_size,status,confirmed,created_at) values($1,$2,$3,$4,0,50,'closed',false,now()) returning *`,[shelf.id,position,`С1П${shelfNumber}К${position}`,barcode])).rows[0];
      boxes.push(box);
    }
  }
  await db.query("commit");
  const verify=(await db.query(`select count(distinct r.id)::int racks,count(distinct s.id)::int shelves,count(distinct b.id)::int boxes from racks_s r left join shelves_s s on s.rack_id=r.id left join shelf_boxes_s b on b.shelf_id=s.id where r.warehouse_id=$1`,[warehouseId])).rows[0];
  console.log(JSON.stringify({ok:true,warehouse,backupPath,backupSha256:crypto.createHash("sha256").update(body).digest("hex"),counts:verify,rack:{id:rack.id,code:rack.code},shelves:shelves.map(s=>({id:s.id,code:s.code})),boxDistribution:boxCounts},null,2));
}catch(error){await db.query("rollback").catch(()=>{});throw error;}finally{await db.end();}
