// glove network views browser check (persistence; was phase-8 check8). Run via scripts/netobs-e2e.sh.
import { BASE, DATA, GLOVE, SHOTS, REPO, CONTAINER, ENGINE, launch, isForeign } from './env.mjs';
// Phase 8: rollups keep totals across restarts, never double count, and a glove
// session whose files are gone stays listed, history only.
import { execSync } from 'child_process';
import { cpSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
const ENVS = `${GLOVE}/envs`;
const DB = `${DATA}/layman.db`;
const results = [];
const check = (name, ok, detail = '') => results.push([ok ? 'PASS' : 'FAIL', name, String(detail).slice(0, 240)]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Docker Desktop's port forwarder can drop a connection or two while a restarted container settles.
const get = async (p) => { for (let i = 0; ; i++) { try { return await (await fetch(BASE + p)).json(); } catch (e) { if (i > 20) throw e; await sleep(1000); } } };
const up = async () => { let ok = 0; for (let i = 0; i < 90 && ok < 3; i++) { try { ok = (await fetch(BASE + '/api/net/sessions')).ok ? ok + 1 : 0; } catch { ok = 0; } await sleep(1000); } };
const restart = async () => { execSync(`${ENGINE} restart ${CONTAINER}`, { stdio: 'ignore' }); await up(); await sleep(4000); };
const view = async (token) => {
  const s = await get(`/api/net/sessions/${token}`);
  const d = Object.fromEntries(s.destinations.map((x) => [x.key, [x.bytesUp, x.bytesDown, x.flows, x.blocked]]).sort((a, b) => a[0].localeCompare(b[0])));
  const { bytesUp, bytesDown, flows, destinations, blocked, directFlows } = s.totals;
  return { historyOnly: s.historyOnly, key: JSON.stringify({ bytesUp, bytesDown, flows, destinations, blocked, directFlows, d }) };
};
const sql = (q) => execSync(`sqlite3 -readonly ${DB} "${q}"`).toString().trim();

// A glove session of our own, copied from a finished scenario, that we can later delete.
const TOKEN = 'history-demo';
rmSync(join(ENVS, TOKEN), { recursive: true, force: true });
cpSync(join(ENVS, 'direct'), join(ENVS, TOKEN), { recursive: true });
const net = join(ENVS, TOKEN, 'sessions', TOKEN);
execSync(`mv ${join(ENVS, TOKEN, 'sessions', 'direct')} ${net}`);
for (const f of readdirSync(join(net, 'net'))) {
  const p = join(net, 'net', f);
  writeFileSync(p, readFileSync(p, 'utf8').replaceAll('"env": "direct"', `"env": "${TOKEN}"`).replaceAll('"env":"direct"', `"env":"${TOKEN}"`)
    .replaceAll('"session": "direct"', `"session": "${TOKEN}"`).replaceAll('"session":"direct"', `"session":"${TOKEN}"`));
}
await up();
for (let i = 0; i < 20 && !(await get('/api/net/sessions')).sessions.some((s) => s.token === TOKEN); i++) await sleep(1000);
const before = await view(TOKEN);
const beforeStopped = await view('stopped');
check('the copied session is read', JSON.parse(before.key).flows > 0, before.key);
// Rollups are written every 30 s and on shutdown.
await sleep(33_000);
const rows = sql(`SELECT token || ':' || flows FROM net_sessions WHERE token IN ('${TOKEN}','stopped') ORDER BY token`);
check('rollups written to net_sessions (recording is on)', rows.split('\n').length === 2, rows);
check('destinations kept per session', Number(sql(`SELECT COUNT(*) FROM net_destinations WHERE token = '${TOKEN}'`)) === JSON.parse(before.key).destinations);
check('never synced: no triggers on the net tables', sql("SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND tbl_name LIKE 'net_%'") === '0');
await restart();
const after1 = await view(TOKEN);
check('restart keeps totals and destinations exactly (no double counting)', after1.key === before.key, `${before.key} → ${after1.key}`);
check('…for a finished scenario too', (await view('stopped')).key === beforeStopped.key);
await restart();
check('…and after a second restart', (await view(TOKEN)).key === before.key);
// Files gone: history only.
rmSync(join(ENVS, TOKEN), { recursive: true, force: true });
await restart();
const summary = (await get('/api/net/sessions')).sessions.find((s) => s.token === TOKEN);
check('a session whose files are gone is still listed, history only', summary?.historyOnly === true && summary.live === false, JSON.stringify(summary));
const hist = await view(TOKEN);
check('…with the same totals and destinations', hist.historyOnly && hist.key === before.key, hist.key);

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
const foreign = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('request', (r) => { const u = r.url(); if (isForeign(u)) foreign.push(u); });
await page.goto(`${BASE}/?view=network&glove=${TOKEN}`);
await page.waitForTimeout(3000);
check('History only chip in the gate strip', await page.$('text=History only') !== null);
const picker = await page.$eval('select[aria-label="Glove session"]', (s) => [...s.options].map((o) => o.textContent).find((t) => t.includes('history-demo')));
check('the picker says history', /history/.test(picker ?? ''), picker);
check('Network tab: the kept destinations in the table', await page.$('[role=table] >> text=wikipedia.org') !== null);
await page.screenshot({ path: `${SHOTS}/p8-history.png` });
const toggles = await page.$$eval('[role=table] button[aria-pressed]', (bs) => bs.map((b) => [b.disabled || b.getAttribute('aria-disabled') === 'true', b.getAttribute('title') ?? '']));
check('toggles are disabled, saying why', toggles.length > 0 && toggles.every(([d]) => d), JSON.stringify(toggles).slice(0, 200));
check('no Cut all traffic for a history-only session', (await page.$('button:has-text("Cut all traffic now")')) === null);
await page.goto(`${BASE}/?view=map&glove=${TOKEN}`);
await page.waitForTimeout(2000);
check('Map says history only', await page.$('h3:has-text("History only"), div:text-is("History only")') !== null || (await page.content()).includes('files for this session are gone'));
await page.goto(`${BASE}/?view=trace&glove=${TOKEN}`);
await page.waitForTimeout(2000);
check('Trace says history only', (await page.content()).includes('files for this session are gone'));
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
check('every request went to Layman itself', foreign.length === 0, foreign.slice(0, 5).join(' '));
await browser.close();
for (const r of results) console.log(r.join('  '));
console.log(`${results.filter((r) => r[0] === 'PASS').length}/${results.length}`);
process.exitCode = results.every((r) => r[0] === 'PASS') ? 0 : 1;
