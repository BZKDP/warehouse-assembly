import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const remoteScript = `
import fs from 'node:fs';
let found = false;
for (const pid of fs.readdirSync('/proc').filter(v => /^\\d+$/.test(v))) {
  try {
    const command = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8');
    const cwd = fs.readlinkSync('/proc/' + pid + '/cwd');
    if (!command.includes('apps/OZ/server.mjs') && !(cwd.endsWith('/apps/OZ') && command.includes('server.mjs'))) continue;
    for (const item of fs.readFileSync('/proc/' + pid + '/environ', 'utf8').split('\\0')) {
      const i = item.indexOf('=');
      if (i > 0) process.env[item.slice(0,i)] = item.slice(i+1);
    }
    found = true;
    break;
  } catch {}
}
if (!found) throw new Error('Running Ozon backend not found');
const config = await import('file:///opt/grasklad-sborka/apps/OZ/server/config.mjs');
const stores = [1,2].map(n => ({ id:config['OZON_STORE_' + n + '_ID'], name:config['OZON_STORE_' + n + '_NAME'], clientId:config['OZON_STORE_' + n + '_CLIENT_ID'], apiKey:config['OZON_STORE_' + n + '_API_KEY'] }));
const store = stores.find(s => s.id === 'evgeny');
if (!store?.clientId || !store?.apiKey) throw new Error('Evgeny credentials missing');
process.stdout.write(JSON.stringify(store));
`;
const remoteCommand = `node --input-type=module -e 'await import("data:text/javascript;base64,${Buffer.from(remoteScript).toString('base64')}")'`;
const result = spawnSync('ssh', [
  '-i', '<SSH_KEY>',
  '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', 'root@<SERVER_HOST>', remoteCommand,
], { encoding: 'utf8', timeout: 20000, windowsHide: true });
if (result.status !== 0) {
  const detail = result.stderr?.match(/(?:Error|SyntaxError): ([^\r\n]+)/)?.[1] || result.error?.code || result.status;
  throw new Error(`Could not read Ozon credentials: ${detail}`);
}
const store = JSON.parse(result.stdout);
const directory = '.';
let target = path.join(directory, 'Ozon-Evgeny-API.txt');
if (fs.existsSync(target)) target = path.join(directory, `Ozon-Evgeny-API-${Date.now()}.txt`);
const content = `Ozon: ${store.name}\r\nClient-Id: ${store.clientId}\r\nApi-Key: ${store.apiKey}\r\n`;
fs.writeFileSync(target, '\ufeff' + content, { encoding: 'utf8', flag: 'wx' });
if (fs.readFileSync(target, 'utf8') !== '\ufeff' + content) throw new Error('Export verification failed');
console.log(JSON.stringify({ saved: true, file: target }));
