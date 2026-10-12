import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
const root="/opt/grasklad-sborka";
for(const raw of fs.readFileSync(path.join(root,".env"),"utf8").split(/\r?\n/)){const line=raw.trim();if(!line||line.startsWith("#"))continue;const i=line.indexOf("=");if(i<1)continue;const k=line.slice(0,i).trim();let v=line.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);if(!process.env[k])process.env[k]=v;}
const db=new Client({host:process.env.SKLAD_DB_HOST,port:Number(process.env.SKLAD_DB_PORT||5432),database:process.env.SKLAD_DB_NAME,user:process.env.SKLAD_DB_USER,password:process.env.SKLAD_DB_PASSWORD,ssl:String(process.env.SKLAD_DB_SSL||"disable").toLowerCase()==="disable"?false:{rejectUnauthorized:false}});
await db.connect();try{
 const columns=(await db.query(`select table_name,column_name,data_type,is_nullable,column_default
   from information_schema.columns where table_schema='public' and table_name=any($1::text[])
   order by table_name,ordinal_position`,[["racks_s","shelves_s","shelf_boxes_s"]])).rows;
 const constraints=(await db.query(`select conrelid::regclass::text table_name,conname,pg_get_constraintdef(oid) definition
   from pg_constraint where conrelid=any($1::regclass[]) order by conrelid::regclass::text,conname`,[["racks_s","shelves_s","shelf_boxes_s"]])).rows;
 const samples={
   rack:(await db.query(`select * from racks_s where warehouse_id=46 order by id limit 2`)).rows,
   shelves:(await db.query(`select s.* from shelves_s s join racks_s r on r.id=s.rack_id where r.warehouse_id=46 order by s.id limit 6`)).rows,
   boxes:(await db.query(`select b.* from shelf_boxes_s b join shelves_s s on s.id=b.shelf_id join racks_s r on r.id=s.rack_id where r.warehouse_id=46 order by b.id limit 12`)).rows
 };
 console.log(JSON.stringify({columns,constraints,samples},null,2));
}finally{await db.end();}
