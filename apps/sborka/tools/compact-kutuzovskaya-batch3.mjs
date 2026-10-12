import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
const root="/opt/grasklad-sborka";
for(const raw of fs.readFileSync(path.join(root,".env"),"utf8").split(/\r?\n/)){const line=raw.trim();if(!line||line.startsWith("#"))continue;const i=line.indexOf("=");if(i<1)continue;const k=line.slice(0,i).trim();let v=line.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);if(!process.env[k])process.env[k]=v;}
const db=new Client({host:process.env.SKLAD_DB_HOST,port:Number(process.env.SKLAD_DB_PORT||5432),database:process.env.SKLAD_DB_NAME,user:process.env.SKLAD_DB_USER,password:process.env.SKLAD_DB_PASSWORD,ssl:String(process.env.SKLAD_DB_SSL||"disable").toLowerCase()==="disable"?false:{rejectUnauthorized:false}});
await db.connect();try{
 const rows=(await db.query(`select id,article,code,name,entity_type,coalesce(archived,false) archived from products_s
   where lower(name) similar to '%(гинкго|физетин|спермидин|наттокиназ|5-htp|5htp|желез|iron|ресвератрол|тримаг)%'
   order by article,id`)).rows;
 console.log(JSON.stringify(rows,null,2));
}finally{await db.end();}
