import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
const root="/opt/grasklad-sborka";
for(const raw of fs.readFileSync(path.join(root,".env"),"utf8").split(/\r?\n/)){const line=raw.trim();if(!line||line.startsWith("#"))continue;const i=line.indexOf("=");if(i<1)continue;const k=line.slice(0,i).trim();let v=line.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);if(!process.env[k])process.env[k]=v;}
const planPath=process.env.PLAN_FILE||path.join(root,"apps/sborka/tools/kutuzovskaya-batch-01-plan.json");
const plan=JSON.parse(fs.readFileSync(planPath,"utf8"));
const db=new Client({host:process.env.SKLAD_DB_HOST,port:Number(process.env.SKLAD_DB_PORT||5432),database:process.env.SKLAD_DB_NAME,user:process.env.SKLAD_DB_USER,password:process.env.SKLAD_DB_PASSWORD,ssl:String(process.env.SKLAD_DB_SSL||"disable").toLowerCase()==="disable"?false:{rejectUnauthorized:false}});
await db.connect();try{
 const articles=plan.items.map(row=>String(row.article||"").toUpperCase()).filter(Boolean);
 const products=(await db.query(`select id,article,name,entity_type,coalesce(archived,false) archived from products_s where upper(article)=any($1::text[]) order by article,id`,[articles])).rows;
 const byArticle=new Map();for(const row of products){const key=String(row.article).toUpperCase();const list=byArticle.get(key)||[];list.push(row);byArticle.set(key,list);}
 const missing=articles.filter(article=>!byArticle.has(article));
 const ambiguous=articles.filter(article=>(byArticle.get(article)||[]).length!==1);
 const structure=(await db.query(`select r.id rack_id,r.name rack_name,s.id shelf_id,s.name shelf_name,count(distinct b.id)::int boxes,
   count(distinct bi.product_id)::int occupied_products,coalesce(sum(bi.quantity),0)::numeric quantity
   from racks_s r left join shelves_s s on s.rack_id=r.id left join shelf_boxes_s b on b.shelf_id=s.id
   left join shelf_box_items_s bi on bi.shelf_box_id=b.id where r.warehouse_id=$1
   group by r.id,r.name,s.id,s.name order by r.id,s.id`,[Number(plan.warehouseId)])).rows;
 const inventory=(await db.query(`select p.article,p.name,count(distinct b.id)::int boxes,coalesce(sum(i.quantity),0)::numeric quantity
   from shelf_box_items_s i join shelf_boxes_s b on b.id=i.shelf_box_id join shelves_s s on s.id=b.shelf_id
   join racks_s r on r.id=s.rack_id join products_s p on p.id=i.product_id where r.warehouse_id=$1
   group by p.article,p.name order by p.article`,[Number(plan.warehouseId)])).rows;
 const inventoryMap=new Map(inventory.map(row=>[String(row.article).toUpperCase(),Number(row.quantity)]));
 const quantityMismatches=plan.items.filter(row=>inventoryMap.get(String(row.article).toUpperCase())!==Number(row.quantity)).map(row=>({article:row.article,expected:Number(row.quantity),actual:inventoryMap.get(String(row.article).toUpperCase())??null}));
 const extras=inventory.filter(row=>!articles.includes(String(row.article).toUpperCase()));
 const totals={items:plan.items.length,uniqueArticles:new Set(articles).size,quantity:plan.items.reduce((sum,row)=>sum+Number(row.quantity||0),0),boxes:structure.reduce((sum,row)=>sum+Number(row.boxes||0),0)};
 console.log(JSON.stringify({ok:missing.length===0&&ambiguous.length===0&&quantityMismatches.length===0&&extras.length===0,planPath,totals,missing,ambiguous,quantityMismatches,extras,inventory,products,structure},null,2));
}finally{await db.end();}
