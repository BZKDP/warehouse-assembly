import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
const root="/opt/grasklad-sborka";
for(const raw of fs.readFileSync(path.join(root,".env"),"utf8").split(/\r?\n/)){const line=raw.trim();if(!line||line.startsWith("#"))continue;const i=line.indexOf("=");if(i<1)continue;const k=line.slice(0,i).trim();let v=line.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);if(!process.env[k])process.env[k]=v;}
const db=new Client({host:process.env.DB_HOST,port:Number(process.env.DB_PORT||5432),database:process.env.DB_NAME,user:process.env.DB_USER,password:process.env.DB_PASSWORD,ssl:String(process.env.DB_SSL||"disable").toLowerCase()==="disable"?false:{rejectUnauthorized:false}});
await db.connect();
try{
 const oz=(await db.query(`select a.id,a.name,a.store_name,a.created_at,a.sklad_warehouse_id,a.sklad_warehouse_name,a.stock_method_enabled,a.allow_stock_shortage,a.product_picking_started_at,
   count(o.*)::int total,count(*) filter(where o.collected_at is not null)::int collected,
   count(*) filter(where o.collected_at is null)::int remaining,
   count(*) filter(where s.picking_started_at is not null and s.picking_finished_at is null)::int active_pick_sessions
   from ozon_assemblies a join ozon_assembly_orders o on o.assembly_id=a.id
   left join ozon_employee_assembly_sessions s on s.assembly_id=a.id
   where a.created_at>='2026-09-08T00:00:00+03:00'
   group by a.id order by a.created_at desc`)).rows;
 const wb=(await db.query(`select ss.supply_id,ss.supply_name,ss.store_name,ss.created_at,ss.sklad_warehouse_id,ss.sklad_warehouse_name,ss.stock_method_enabled,ss.allow_stock_shortage,ss.product_picking_started_at,
   count(so.*)::int total,count(*) filter(where so.collected_at is not null)::int collected,
   count(*) filter(where so.collected_at is null)::int remaining,
   count(*) filter(where s.picking_started_at is not null and s.picking_finished_at is null)::int active_pick_sessions
   from supply_settings ss join supply_orders so on so.supply_id=ss.supply_id
   left join employee_supply_sessions s on s.supply_id=ss.supply_id
   where ss.created_at>='2026-09-08T00:00:00+03:00'
   group by ss.supply_id order by ss.created_at desc`)).rows;
 console.log(JSON.stringify({oz,wb},null,2));
}finally{await db.end();}
