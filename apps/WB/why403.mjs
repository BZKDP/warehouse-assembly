import fs from 'fs'; import pg from 'pg';
const raw = fs.readFileSync('/opt/grasklad-sborka/.env','utf8').replace(/^﻿/,'');
const env={}; for (const l of raw.split(/\r?\n/)){const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if(m)env[m[1]]=m[2].replace(/^"(.*)"$/,'$1').replace(/\r$/,'');}
const db=new pg.Pool({host:env.DB_HOST,port:+(env.DB_PORT||5432),user:env.DB_USER,password:env.DB_PASSWORD,database:env.DB_NAME,ssl:env.DB_SSL==='disable'?false:{rejectUnauthorized:false},max:2,connectionTimeoutMillis:15000});
const uid=131;
console.log('user131:',JSON.stringify((await db.query(`select id,surname,name,role,position,location_code from users where id=$1`,[uid])).rows[0]));
for(const aid of ['ozon-1789398939639-aa56f5','ozon-1789404249591-889e4e']){
  const a=(await db.query(`select access_mode,employee_workflow_mode,employee_workflow_stage,store_id from ozon_assemblies where id=$1`,[aid])).rows[0];
  const acc=(await db.query(`select user_id from ozon_assembly_access_users where assembly_id=$1`,[aid])).rows.map(r=>r.user_id);
  const ses=(await db.query(`select id,user_id,status,started_at,finished_at from ozon_employee_assembly_sessions where assembly_id=$1 order by id`,[aid])).rows;
  const my=(await db.query(`select count(*) c, count(assigned_user_id) filter (where assigned_user_id=$2) mine from ozon_assembly_orders where assembly_id=$1 and collected_at is null and sent_to_delivering_at is null`,[aid,uid])).rows[0];
  console.log(`\n${aid}: ${JSON.stringify(a)}`);
  console.log(`  access_users=[${acc.join(',')}] (131 в доступе: ${acc.includes(String(uid))||acc.includes(uid)})`);
  console.log(`  sessions=${JSON.stringify(ses)}`);
  console.log(`  несобранных заказов ${my.c}, назначено на 131: ${my.mine}`);
}
await db.end(); process.exit(0);
