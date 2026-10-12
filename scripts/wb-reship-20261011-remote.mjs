import fs from 'node:fs';
import { createRequire } from 'node:module';

const ids = ['WB-GI-290707387', 'WB-GI-289329542'];
const dir = '/opt/backups/wb-reship-20261011';
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
let found = false;
for (const pid of fs.readdirSync('/proc').filter(x => /^\d+$/.test(x))) {
  try {
    const command = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
    const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
    if (!command.includes('apps/WB/server.mjs') && !(cwd.endsWith('/apps/WB') && command.includes('server.mjs'))) continue;
    for (const item of fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
      const at = item.indexOf('=');
      if (at > 0) process.env[item.slice(0, at)] = item.slice(at + 1);
    }
    found = true;
    break;
  } catch {}
}
if (!found) throw new Error('Live WB process not found');
const cfg = await import('file:///opt/grasklad-sborka/apps/WB/server/config.mjs');
const require = createRequire('/opt/grasklad-sborka/apps/WB/package.json');
const { Pool } = require('pg');
const db = new Pool({ host: cfg.DB_HOST, port: cfg.DB_PORT, user: cfg.DB_USER,
  password: cfg.DB_PASSWORD, database: cfg.DB_NAME,
  ssl: cfg.DB_SSL === 'disable' ? false : { rejectUnauthorized: false }, connectionTimeoutMillis: 8000 });
const token = cfg.WB_API_TOKEN_2 || cfg.WB_CLIENT_SECRET_2;
if (!token) throw new Error('Store2 token missing');
async function api(path, method = 'GET', body) {
  for (let attempt = 0; attempt < 6; attempt++) {
  await new Promise(resolve => setTimeout(resolve, 1000));
  const res = await fetch(cfg.API_BASE + path, { method, headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(25000) });
  const text = await res.text();
  if (res.status === 429 && attempt < 5) {
    const seconds = Math.max(3, Math.min(60, Number(res.headers.get('x-ratelimit-retry') || res.headers.get('retry-after') || 10)));
    console.log(JSON.stringify({ retry: path, seconds }));
    await new Promise(resolve => setTimeout(resolve, seconds * 1000));
    continue;
  }
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 1200)}`);
  return text ? JSON.parse(text) : null;
  }
}
function save(name, data) { fs.writeFileSync(`${dir}/${name}.json`, JSON.stringify(data, null, 2), { mode: 0o600 }); }
try {
  const settings = (await db.query('select * from supply_settings where supply_id=any($1)', [ids])).rows;
  if (settings.length !== 2 || settings.some(x => x.store_id !== cfg.WB_STORE_2_ID)) throw new Error('Unexpected supply store');
  const orders = (await db.query('select * from supply_orders where supply_id=any($1) order by supply_id,wb_order_id', [ids])).rows;
  const reship = await api('/api/v3/supplies/orders/reshipment');
  save('before', { settings, orders, reship });
  console.log(JSON.stringify({reshipKeys: Object.keys(reship), sample: (reship.orders || []).slice(0,3)}));
  const supplies = [];
  for (const id of ids) {
    const details = await api(`/api/v3/supplies/${id}`);
    const membership = await api(`/api/marketplace/v3/supplies/${id}/order-ids`);
    const orderIds = membership.orderIds;
    if (!Array.isArray(orderIds)) throw new Error('Invalid membership');
    const statuses = orderIds.length ? (await api('/api/v3/orders/status', 'POST', { orders: orderIds })).orders : [];
    const eligibleSet = new Set((reship.orders || []).filter(x => x.supplyID === id).map(x => String(x.orderID)));
    const eligible = statuses.filter(x => eligibleSet.has(String(x.id)) && x.wbStatus === 'waiting' && x.supplierStatus === 'complete').map(x => Number(x.id));
    const counts = {};
    for (const s of statuses) { const k = `${s.supplierStatus}/${s.wbStatus}`; counts[k] = (counts[k] || 0) + 1; }
    supplies.push({ id, details, orderIds, statuses, eligible });
    console.log(JSON.stringify({ id, name: details.name, total: orderIds.length, counts, reshipmentListed: eligibleSet.size, eligible: eligible.length,
      missingLocal: eligible.filter(x => !orders.some(o => String(o.wb_order_id) === String(x))) }));
  }
  save('audit', { at: new Date().toISOString(), settings, orders, reship, supplies });
  console.log('Backup: ' + dir + '/audit.json');
  if (process.env.WB_RESHIP_ACTION === 'reset') {
    const resultFile = `${dir}/reset-result.json`;
    if (fs.existsSync(resultFile)) throw new Error('Reset already applied; refusing to erase subsequent work');
    const selected = supplies.map(s => ({ supplyId: s.id, ids: s.statuses
      .filter(x => x.wbStatus === 'waiting' && x.supplierStatus === 'complete').map(x => Number(x.id)) }));
    if (selected.some(s => !s.ids.length)) throw new Error('A supply no longer has waiting orders');
    for (const item of selected) {
      const current = (await api('/api/v3/orders/status', 'POST', { orders: item.ids })).orders;
      if (current.length !== item.ids.length || current.some(x => x.wbStatus !== 'waiting' || x.supplierStatus !== 'complete')) {
        throw new Error('WB statuses changed; reset aborted');
      }
      if (item.ids.some(id => !orders.some(o => o.supply_id === item.supplyId && String(o.wb_order_id) === String(id)))) {
        throw new Error('Local order missing; reset aborted');
      }
    }
    const client = await db.connect();
    const backup = { at: new Date().toISOString(), supplies, selected, tables: {} };
    const backupFile = `${dir}/reset-before-${Date.now()}.json`;
    let committed = false;
    try {
      await client.query('begin');
      await client.query("set local lock_timeout='8s'");
      await client.query("select pg_advisory_xact_lock(hashtext('wb-reship-reset-20261011'))");
      await client.query('select supply_id from supply_settings where supply_id=any($1) for update', [ids]);
      await client.query('select wb_order_id from supply_orders where supply_id=any($1) for update', [ids]);
      const active = (await client.query("select id from employee_supply_sessions where supply_id=any($1) and status in ('assigned','started') and finished_at is null", [ids])).rows;
      if (active.length) throw new Error('There are active employee sessions; reset aborted');
      for (const table of ['supply_settings','supply_orders','supply_access_users','supply_assignment_parts',
        'employee_supply_sessions','employee_supply_pick_items','employee_scan_issues',
        'wb_instant_bundle_component_scans','collector_supply_sessions']) {
        backup.tables[table] = (await client.query(`select * from ${table} where supply_id=any($1)`, [ids])).rows;
      }
      for (const item of selected) {
        const local = backup.tables.supply_orders.filter(o => o.supply_id === item.supplyId && item.ids.includes(Number(o.wb_order_id)));
        if (local.length !== item.ids.length || local.some(o => !o.collected_at)) throw new Error('Collection state changed; refusing reset');
      }
      fs.writeFileSync(backupFile, JSON.stringify(backup, null, 2), { flag: 'wx', mode: 0o600 });
      await client.query('delete from supply_access_users where supply_id=any($1)', [ids]);
      await client.query('update supply_orders set assigned_user_id=null, assigned_at=null, assignment_part_id=null, updated_at=now() where supply_id=any($1)', [ids]);
      await client.query('delete from supply_assignment_parts where supply_id=any($1)', [ids]);
      await client.query('delete from employee_supply_pick_items where supply_id=any($1)', [ids]);
      for (const item of selected) {
        const reset = await client.query(`update supply_orders set collected_at=null, collected_by=null, collected_via=null,
          collected_session_id=null, scan_passed_at=null, scan_passed_by=null, scan_barcode=null, scan_error=null,
          label_scan_passed_at=null, label_scan_passed_by=null, label_scan_barcode=null, label_scan_error=null,
          flyer_scan_passed_at=null, flyer_scan_passed_by=null, flyer_scan_code=null, updated_at=now()
          where supply_id=$1 and wb_order_id=any($2::bigint[]) returning wb_order_id`, [item.supplyId, item.ids]);
        if (reset.rowCount !== item.ids.length) throw new Error('Wrong reset row count');
        await client.query('delete from wb_instant_bundle_component_scans where supply_id=$1 and wb_order_id=any($2::bigint[])', [item.supplyId,item.ids]);
        await client.query('delete from employee_scan_issues where supply_id=$1 and wb_order_id=any($2::bigint[]) and resolved_at is null', [item.supplyId,item.ids]);
      }
      await client.query(`update supply_settings set access_mode='selected_split', employee_workflow_mode='instant',
        employee_workflow_stage='orders_only', product_picking_started_at=null, product_picking_started_by=null,
        employee_close_completed_at=null, employee_close_completed_by=null, stock_method_enabled=false,
        allow_no_scan=false, partial_safe_scan=true, desktop_print=true, voice_cells=true, updated_at=now()
        where supply_id=any($1)`, [ids]);
      for (const item of selected) {
        const open = (await client.query('select wb_order_id from supply_orders where supply_id=$1 and collected_at is null order by wb_order_id', [item.supplyId])).rows;
        if (open.length !== item.ids.length || open.some(o => !item.ids.includes(Number(o.wb_order_id)))) throw new Error('Unexpected open orders after reset');
      }
      await client.query('commit'); committed = true;
      save('reset-result', { at: new Date().toISOString(), backupFile, selected, stockWriteOffDisabled: true });
    } catch (error) {
      if (!committed) await client.query('rollback');
      throw error;
    } finally { client.release(); }
    const verified = (await db.query(`select s.supply_id,s.supply_name,s.employee_workflow_mode,s.access_mode,
      s.stock_method_enabled,s.employee_close_completed_at,s.wb_supply_done,
      count(o.*)::int as historical_total,count(*) filter(where o.collected_at is null)::int as to_assemble,
      count(*) filter(where o.collected_at is null and o.assigned_user_id is not null)::int as assigned,
      count(*) filter(where o.collected_at is null and (o.scan_passed_at is not null or o.label_scan_passed_at is not null or o.flyer_scan_passed_at is not null))::int as touched,
      count(*) filter(where o.collected_at is null and o.sticker_url is null)::int as missing_labels
      from supply_settings s join supply_orders o using(supply_id) where s.supply_id=any($1) group by s.supply_id`, [ids])).rows;
    console.log(JSON.stringify({ resetVerified: verified, backupFile }));
  }
  if (process.env.WB_RESHIP_ACTION === 'transfer') {
    const journalFile = `${dir}/transfer.json`;
    const journal = fs.existsSync(journalFile) ? JSON.parse(fs.readFileSync(journalFile, 'utf8')) : [];
    for (const supply of supplies) {
      const candidates = supply.statuses.filter(x => x.wbStatus === 'waiting' && x.supplierStatus === 'complete').map(x => Number(x.id));
      if (!candidates.length) continue;
      if (journal.some(x => x.source === supply.id)) {
        console.log(JSON.stringify({source: supply.id, existingJournal: journal.find(x => x.source === supply.id)}));
        continue;
      }
      const current = (await api('/api/v3/orders/status', 'POST', { orders: candidates })).orders;
      const actual = current.filter(x => x.wbStatus === 'waiting' && x.supplierStatus === 'complete').map(x => Number(x.id));
      if (!actual.length) continue;
      const name = `\u041f\u043e\u0432\u0442\u043e\u0440\u043d\u0430\u044f \u0441\u0431\u043e\u0440\u043a\u0430 ${supply.id} - ${actual.length} \u0437\u0430\u043a\u0430\u0437\u043e\u0432`;
      const entry = { source: supply.id, name, ids: actual, stage: 'create-requested', at: new Date().toISOString() };
      journal.push(entry); save('transfer', journal);
      const created = await api('/api/v3/supplies', 'POST', { name });
      if (!created?.id) throw new Error('Supply creation returned no ID');
      entry.target = created.id; entry.stage = 'created'; save('transfer', journal);
      try {
        await api(`/api/marketplace/v3/supplies/${entry.target}/orders`, 'PATCH', { orders: [actual[0]] });
        entry.stage = 'probe-moved'; save('transfer', journal);
        if (actual.length > 1) await api(`/api/marketplace/v3/supplies/${entry.target}/orders`, 'PATCH', { orders: actual.slice(1) });
        entry.stage = 'moved'; save('transfer', journal);
      } catch (error) {
        entry.error = error.message;
        const membership = await api(`/api/marketplace/v3/supplies/${entry.target}/order-ids`);
        entry.actualIds = membership.orderIds;
        if (Array.isArray(entry.actualIds) && !entry.actualIds.length) {
          await api(`/api/v3/supplies/${entry.target}`, 'DELETE');
          entry.stage = 'blocked-empty-target-deleted';
        } else entry.stage = 'partial-or-uncertain';
        save('transfer', journal);
        console.log(JSON.stringify(entry));
        continue;
      }
      entry.actualIds = (await api(`/api/marketplace/v3/supplies/${entry.target}/order-ids`)).orderIds;
      entry.stage = 'verified-wb'; save('transfer', journal);
      console.log(JSON.stringify(entry));
    }
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await db.end(); }
