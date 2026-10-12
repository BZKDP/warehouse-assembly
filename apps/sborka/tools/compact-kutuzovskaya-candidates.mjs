import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
const root="/opt/grasklad-sborka";
for(const raw of fs.readFileSync(path.join(root,".env"),"utf8").split(/\r?\n/)){const line=raw.trim();if(!line||line.startsWith("#"))continue;const i=line.indexOf("=");if(i<1)continue;const k=line.slice(0,i).trim();let v=line.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);if(!process.env[k])process.env[k]=v;}
const db=new Client({host:process.env.SKLAD_DB_HOST,port:Number(process.env.SKLAD_DB_PORT||5432),database:process.env.SKLAD_DB_NAME,user:process.env.SKLAD_DB_USER,password:process.env.SKLAD_DB_PASSWORD,ssl:String(process.env.SKLAD_DB_SSL||"disable").toLowerCase()==="disable"?false:{rejectUnauthorized:false}});
const articles=["GRA-08150","GRA-08070","GRA-08160","GRA-07890","GRA-04630","GRA-04420","GRA-04730","GRA-11300","GRA-08300","GRA-08580","GRA-04500","GRA-07960","GRA-06983","GRA-00270","GRA-08340","GRA-08130","GRA-08350","GRA-08000","GRA-04550","GRA-07790","GRA-08260","GRA-07300","GRA-07400","GRA-08410","GRA-04620","GRA-04510","GRA-06710","GRA-08140"];
await db.connect();try{
 const mapped=(await db.query(`select id,article,code,name,entity_type from products_s where coalesce(archived,false)=false and upper(article)=any($1::text[]) order by article`,[articles])).rows;
 const ambiguous=(await db.query(`select id,article,code,name,entity_type,coalesce(archived,false) archived from products_s where (lower(name) like '%теанин%' or lower(name) like '%theanine%' or lower(name) like '%таурин%' or (lower(name) like '%калий%' and lower(name) like '%q10%') or (lower(name) like '%гинкго%' and lower(name) like '%холин%') or lower(name) like '%готу кола%') order by article,id`)).rows;
 console.log(JSON.stringify({mapped,ambiguous},null,2));
}finally{await db.end();}
