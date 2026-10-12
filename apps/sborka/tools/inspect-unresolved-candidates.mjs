import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
const root="/opt/grasklad-sborka";
for(const raw of fs.readFileSync(path.join(root,".env"),"utf8").split(/\r?\n/)){const l=raw.trim();if(!l||l.startsWith("#"))continue;const i=l.indexOf("=");if(i<1)continue;const k=l.slice(0,i).trim();let v=l.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);if(!process.env[k])process.env[k]=v;}
const db=new Client({host:process.env.SKLAD_DB_HOST,port:Number(process.env.SKLAD_DB_PORT||5432),database:process.env.SKLAD_DB_NAME,user:process.env.SKLAD_DB_USER,password:process.env.SKLAD_DB_PASSWORD,ssl:String(process.env.SKLAD_DB_SSL||"disable").toLowerCase()==="disable"?false:{rejectUnauthorized:false}});
await db.connect();try{
const rows=(await db.query(`select p.id,p.article,p.code,p.name,p.entity_type,p.barcode_list,p.marketplace_barcodes_json,
coalesce((select sum(sbi.quantity) from shelf_box_items_s sbi join shelf_boxes_s sb on sb.id=sbi.shelf_box_id join shelves_s s on s.id=sb.shelf_id join racks_s r on r.id=s.rack_id where r.warehouse_id=46 and sbi.product_id=p.id),0)::numeric as box_qty
from products_s p where coalesce(p.archived,false)=false and (
upper(coalesce(p.article,'')) similar to '%(00401|04610|04620|07400|08040|08110)%'
or lower(coalesce(p.name,'')) similar to '%(серрапептаз|треонат|куркумин|лютеин|рибофлавин|d3|д3)%')
order by p.article,p.id`)).rows;
console.log(JSON.stringify(rows.map(r=>({id:Number(r.id),article:r.article,code:r.code,name:r.name,entityType:r.entity_type,boxQty:Number(r.box_qty),barcodes:String(r.barcode_list||"").split(";").filter(Boolean),marketplace:r.marketplace_barcodes_json})),null,2));
}finally{await db.end();}
