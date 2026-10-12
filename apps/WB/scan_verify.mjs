import fs from 'fs'; import crypto from 'crypto'; import pg from 'pg';
const raw = fs.readFileSync('/opt/grasklad-sborka/.env','utf8').replace(/^﻿/,'');
const env={}; for (const l of raw.split(/\r?\n/)){const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if(m)env[m[1]]=m[2].replace(/^"(.*)"$/,'$1').replace(/\r$/,'');}
const db=new pg.Pool({host:env.DB_HOST,port:+(env.DB_PORT||5432),user:env.DB_USER,password:env.DB_PASSWORD,database:env.DB_NAME,ssl:env.DB_SSL==='disable'?false:{rejectUnauthorized:false},max:2,connectionTimeoutMillis:15000});
const aid=process.argv[2]||'ozon-1789404249591-889e4e';
const uid=Number(process.argv[3]||131);
const bc=process.argv[4]||'100000035279';
const store=(await db.query(`select store_id from ozon_assemblies where id=$1`,[aid])).rows[0]?.store_id||'evgeny';
// синхронизируем partial с новой логикой
await db.query(`update ozon_assemblies set partial_safe_scan=true where id=$1 and employee_workflow_mode='instant'`,[aid]);
const tk=crypto.randomBytes(32).toString('hex');
await db.query("insert into sessions (token,user_id,expires_at,created_at,updated_at) values ($1,$2,now()+interval '1 hour',now(),now())",[tk,uid]);
async function req(method,path,body){const r=await fetch(`http://127.0.0.1:3008${path}`,{method,headers:{Cookie:`sid=${tk}`,'Content-Type':'application/json','x-store-id':store},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(60000)});const t=await r.text();let j=null;try{j=JSON.parse(t);}catch{}return{status:r.status,j,t};}
try{
  const sc=await req('POST',`/sborka/api/oz/employee/assemblies/${encodeURIComponent(aid)}/instant/scan`,{barcode:bc});
  console.log(`scan ШК=${bc} → HTTP ${sc.status}`);
  if(sc.status===200){
    const o=sc.j?.order; console.log(`  ✓ ЗАКАЗ ${o?.postingNumber}; товаров ${(o?.items||[]).length}; scanDone=${o?.scanDone}`);
    for(const it of (o?.items||[])) console.log(`     ${it.article} scanned ${it.scannedQty}/${it.quantity} bundle=${it.isBundle} яч=${it.cell||'—'}`);
    const cn=await req('POST',`/sborka/api/oz/employee/assemblies/${encodeURIComponent(aid)}/instant/cancel`,{postingNumber:o.postingNumber});
    console.log(`  откат scan → HTTP ${cn.status}`);
  } else {
    console.log(`  ошибка: ${(sc.j&&sc.j.error)||sc.t.slice(0,160)}`);
  }
} finally { await db.query("delete from sessions where token=$1",[tk]); }
await db.end(); process.exit(0);
