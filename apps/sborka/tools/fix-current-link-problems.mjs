import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
const root="/opt/grasklad-sborka";
const mappings=[
  {article:"GRA-00190",barcodes:["2049054334097"]},
  {article:"GRA-07300",barcodes:["4191164759531"]},
  {article:"GRA-08320",barcodes:["5964325303770","7687021268331"]},
  {article:"GRA-00050",barcodes:["1831204005386","1881204005386"]},
  {article:"GRA-09400",barcodes:["9114007547107"]}
];
for(const raw of fs.readFileSync(path.join(root,".env"),"utf8").split(/\r?\n/)){const line=raw.trim();if(!line||line.startsWith("#"))continue;const i=line.indexOf("=");if(i<1)continue;const k=line.slice(0,i).trim();let v=line.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);if(!process.env[k])process.env[k]=v;}
const db=new Client({host:process.env.SKLAD_DB_HOST,port:Number(process.env.SKLAD_DB_PORT||5432),database:process.env.SKLAD_DB_NAME,user:process.env.SKLAD_DB_USER,password:process.env.SKLAD_DB_PASSWORD,ssl:String(process.env.SKLAD_DB_SSL||"disable").toLowerCase()==="disable"?false:{rejectUnauthorized:false}});
await db.connect();let backupPath="";try{
 await db.query("begin");await db.query("select pg_advisory_xact_lock(hashtext('fix-current-link-problems-20260909'))");
 const articles=mappings.map(row=>row.article);const products=(await db.query("select id,article,code,name,barcode_list,marketplace_barcodes_json,coalesce(archived,false) archived from products_s where upper(trim(article))=any($1::text[]) order by article,id for update",[articles])).rows;
 const byArticle=new Map();for(const row of products){const key=String(row.article).trim().toUpperCase(),list=byArticle.get(key)||[];list.push(row);byArticle.set(key,list);}for(const mapping of mappings){const rows=byArticle.get(mapping.article)||[];if(rows.length!==1)throw new Error(`${mapping.article}: найдено карточек ${rows.length}`);if(rows[0].archived)throw new Error(`${mapping.article}: карточка архивная`);}
 const body=JSON.stringify({createdAt:new Date().toISOString(),mappings,products},null,2);backupPath=path.join(root,"backups",`link-fix-before-${new Date().toISOString().replace(/[:.]/g,"-")}.json`);fs.writeFileSync(backupPath,body,{mode:0o600});
 const changed=[];for(const mapping of mappings){const product=byArticle.get(mapping.article)[0];const values=String(product.barcode_list||"").split(/[;,\r\n]+/).map(v=>v.trim()).filter(Boolean);const normalized=new Set(values.map(v=>v.replace(/\s+/g,"").toUpperCase()));const added=[];for(const barcode of mapping.barcodes){const key=barcode.replace(/\s+/g,"").toUpperCase();if(!normalized.has(key)){values.push(barcode);normalized.add(key);added.push(barcode);}}if(added.length)await db.query("update products_s set barcode_list=$2,updated_at=now() where id=$1",[Number(product.id),values.join(";")]);changed.push({productId:Number(product.id),article:mapping.article,name:product.name,added,barcodes:mapping.barcodes});}
 await db.query("commit");
 const {resolveWarehouseProductMeta}=await import(path.join(root,"apps/OZ/server/services/sklad-movements.mjs"));const lookup=await resolveWarehouseProductMeta(mappings.flatMap(row=>row.barcodes));const verification=mappings.flatMap(row=>row.barcodes.map(barcode=>{const hit=lookup.get(barcode.toUpperCase());const expectedProductId=Number(byArticle.get(row.article)[0].id);return{barcode,expected:row.article,expectedProductId,productId:hit?.id?Number(hit.id):null,ok:Number(hit?.id)===expectedProductId};}));if(verification.some(row=>!row.ok))throw new Error("Проверка связи после сохранения не прошла");
 console.log(JSON.stringify({ok:true,backupPath,backupSha256:crypto.createHash("sha256").update(body).digest("hex"),changed,verification},null,2));
}catch(e){await db.query("rollback").catch(()=>{});throw e;}finally{await db.end();}
