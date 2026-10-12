import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
const root="/opt/grasklad-sborka";
for(const raw of fs.readFileSync(path.join(root,".env"),"utf8").split(/\r?\n/)){const line=raw.trim();if(!line||line.startsWith("#"))continue;const i=line.indexOf("=");if(i<1)continue;const k=line.slice(0,i).trim();let v=line.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);if(!process.env[k])process.env[k]=v;}
const db=new Client({host:process.env.SKLAD_DB_HOST,port:Number(process.env.SKLAD_DB_PORT||5432),database:process.env.SKLAD_DB_NAME,user:process.env.SKLAD_DB_USER,password:process.env.SKLAD_DB_PASSWORD,ssl:String(process.env.SKLAD_DB_SSL||"disable").toLowerCase()==="disable"?false:{rejectUnauthorized:false}});
await db.connect();try{
 const users=(await db.query(`select u.id,u.employee_id,e.full_name from users_s u join employees_s e on e.id=u.employee_id where e.external_employee_id=286 and coalesce(u.active,true)=true order by u.id limit 1`)).rows;
 const moves=(await db.query(`select m.* from movements_s m left join shelves_s s on s.id=m.to_shelf_id left join racks_s r on r.id=s.rack_id where r.warehouse_id=46 and m.created_at between '2026-09-08T09:50:00Z' and '2026-09-08T11:00:00Z' order by m.id limit 12`)).rows;
 const shelfMoves=(await db.query(`select sm.* from shelf_movements_s sm join shelves_s s on s.id=sm.shelf_id join racks_s r on r.id=s.rack_id where r.warehouse_id=46 and sm.created_at between '2026-09-08T09:50:00Z' and '2026-09-08T11:00:00Z' order by sm.id limit 12`)).rows;
 const itemColumns=(await db.query(`select column_name,data_type,is_nullable,column_default from information_schema.columns where table_schema='public' and table_name='shelf_box_items_s' order by ordinal_position`)).rows;
 const largeBoxes=(await db.query(`select b.id,b.name,b.quantity,b.box_size,b.status,b.confirmed,p.article,p.name product_name,w.name warehouse_name from shelf_boxes_s b left join products_s p on p.id=b.product_id join shelves_s s on s.id=b.shelf_id join racks_s r on r.id=s.rack_id join warehouses_s w on w.id=r.warehouse_id where b.quantity>50 order by b.quantity desc limit 20`)).rows;
 console.log(JSON.stringify({users,moves,shelfMoves,itemColumns,largeBoxes},null,2));
}finally{await db.end();}
