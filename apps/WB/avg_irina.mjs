import fs from 'fs';
const raw = fs.readFileSync('/opt/grasklad-sborka/.env','utf8').replace(/^﻿/,'');
const env={}; for (const l of raw.split(/\r?\n/)){const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if(m)env[m[1]]=m[2].replace(/^"(.*)"$/,'$1');}
const ST='https://statistics-api.wildberries.ru';
async function ordersAvg(TOKEN,days){
  const dateFrom=new Date(Date.now()-days*864e5).toISOString().slice(0,19); const map={};
  for(let attempt=0; attempt<6; attempt++){
    const r=await fetch(`${ST}/api/v1/supplier/orders?dateFrom=${encodeURIComponent(dateFrom)}&flag=0`,{headers:{Authorization:TOKEN},signal:AbortSignal.timeout(90000)});
    if(r.status===429){ console.log('429, жду 65с...'); await new Promise(x=>setTimeout(x,65000)); continue; }
    if(!r.ok){ console.error('err',r.status,(await r.text()).slice(0,80)); return {}; }
    const arr=await r.json();
    for(const o of (Array.isArray(arr)?arr:[])){ const k=String(o.nmId); const m=map[k]||(map[k]={pw:0,fin:0,cnt:0}); m.pw+=Number(o.priceWithDisc||0); m.fin+=Number(o.finishedPrice||0); m.cnt++; }
    break;
  }
  const out={}; for(const [k,m] of Object.entries(map)) out[k]={avgPW:Math.round(m.pw/m.cnt), avgFin:Math.round(m.fin/m.cnt), cnt:m.cnt};
  return out;
}
const data=JSON.parse(fs.readFileSync('/opt/grasklad-sborka/apps/WB/util_priced.json','utf8'));
const ir=await ordersAvg(env.WB_API_TOKEN,400);
console.log('Ирина nmID с ценой:', Object.keys(ir).length);
for(const [num,rep] of Object.entries(data)){ if(!rep.store.includes('Ирина'))continue; let hit=0;
  for(const r of rep.rows){ const p=ir[String(r.nmid).trim()]; if(p){ r.avgPW=p.avgPW; r.avgFin=p.avgFin; r.ordCnt=p.cnt; hit++; } }
  console.log(`${num} ${rep.store}: цена найдена ${hit}/${rep.rows.length}`);
}
fs.writeFileSync('/opt/grasklad-sborka/apps/WB/util_priced.json', JSON.stringify(data,null,1));
console.log('OK');
