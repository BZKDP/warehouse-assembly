import fs from 'node:fs';
const source = fs.readFileSync(new URL('./wb-reship-20261011-remote.mjs', import.meta.url), 'utf8');
const bootstrap = `
import fs from 'node:fs';
const { loadEnv, connectAuto, mainDbConfig } = await import('file:///./scripts/db-common.mjs');
loadEnv('./.env');
const ids = ['WB-GI-290707387', 'WB-GI-289329542'];
const dir = './investigations/wb-reship-reset-20261011';
fs.mkdirSync(dir, { recursive: true });
const cfg = { API_BASE: 'https://marketplace-api.wildberries.ru', WB_STORE_2_ID: process.env.WB_STORE_2_ID || 'store2' };
const db = await connectAuto(mainDbConfig());
const token = process.env.WB_API_TOKEN_2 || process.env.WB_CLIENT_SECRET_2;
if (!token) throw new Error('WB token missing');
`;
process.env.WB_RESHIP_ACTION = process.argv[2] === 'reset' ? 'reset' : 'audit';
try {
  await import(`data:text/javascript;base64,${Buffer.from(bootstrap + source.slice(source.indexOf('async function api('))).toString('base64')}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
