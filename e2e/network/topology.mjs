// glove network views browser check (topology; was phase-6 check6). Run via scripts/netobs-e2e.sh.
import { BASE, DATA, GLOVE, SHOTS, REPO, CONTAINER, ENGINE, launch, isForeign } from './env.mjs';
const results = [];
const check = (name, ok, detail = '') => results.push([ok ? 'PASS' : 'FAIL', name, String(detail).slice(0, 220)]);
const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
const foreign = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('request', (r) => { const u = r.url(); if (isForeign(u)) foreign.push(u); });
const waitFor = async (fn, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await page.waitForTimeout(250); } return false; };
const DIAG = 'svg[aria-label^="Routes from"]';
const nodeTitles = (kind) => page.$$eval(`${DIAG} g[data-node^="${kind}"] > text:first-of-type`, (ts) => ts.map((t) => t.textContent));

await page.goto(`${BASE}/?view=topology&glove=pi-search`);
await page.evaluate(() => localStorage.clear());
await page.reload();
check('diagram drawn', await waitFor(async () => (await page.$$(`${DIAG} g[data-node]`)).length > 10));
const cols = await page.$$eval(`${DIAG} > text`, (ts) => ts.map((t) => t.textContent));
check('six columns in order', cols.slice(0, 6).join('|') === 'SANDBOX|GATE SERVICES|POLICY|ROUTE|APPARENT ORIGIN|DESTINATIONS', cols.join('|'));
const svcs = await nodeTitles('svc:');
check('every declared service drawn, including the unobserved browser', ['llm', 'search', 'proxy', 'fanout', 'browser'].every((s) => svcs.includes(s)), svcs.join(','));
const browserText = await page.$eval(`${DIAG} g[data-node="svc:browser"]`, (g) => g.textContent);
check('browser: declared · not watched, dashed', browserText.includes('declared · not watched')
  && await page.$eval(`${DIAG} g[data-node="svc:browser"] rect`, (r) => !!r.getAttribute('stroke-dasharray')), browserText);
check('trigger link from search to fan-out', await page.$(`${DIAG} g[data-band="svc:search>svc:fanout:trigger"]`) !== null);
const fanCap = await page.$$eval(`${DIAG} > text`, (ts) => ts.map((t) => t.textContent).filter((x) => x.includes('via SearXNG')));
check('fan-out bytes captioned', fanCap.length === 1, fanCap);
const wall = await page.$eval(`${DIAG} g[data-wall]`, (g) => g.textContent);
check('policy wall: guard and your rule', /glove guard · /.test(wall) && /your rule “ads” · /.test(wall) && wall.includes('metadata, internal, malformed'), wall);
const routes = await nodeTitles('route:');
check('routes: Local, VPN tunnel, Direct', routes.join('|') === 'Local|VPN tunnel|Direct', routes.join('|'));
const exitText = await page.$eval(`${DIAG} g[data-node="origin:exit"]`, (g) => g.textContent);
check('exit verified, with its source', exitText.includes('Switzerland') && exitText.includes('exit verified') && exitText.includes('via am.i.mullvad.net'), exitText);
check('broken path glyph for duckduckgo.com', await page.$(`${DIAG} g[data-node="origin:broken:duckduckgo.com:443"]`) !== null);
const dests = await nodeTitles('dest:');
check('reached destinations only (no refused host in the last column)', dests.includes('arxiv.org') && !dests.some((d) => d.includes('tracker') || d.includes('169.254')), dests.join(','));
check('direct destination drawn from the Direct route', await page.$(`${DIAG} g[data-band^="route:direct>dest:"]`) !== null);

// Selecting.
await page.click(`${DIAG} g[data-node="dest:arxiv.org:443"]`);
check('clicking a destination sets dest= in the URL', await waitFor(async () => new URL(page.url()).searchParams.get('dest') === 'arxiv.org'), page.url());
const hops = await page.$$eval('ol[aria-label="Hops"] > li', (ls) => ls.map((l) => l.innerText.split('\n')[0]));
check('hop list sandbox → service → policy → tunnel → exit → destination', hops.join('|') === 'pi-search sandbox|proxy service|Policy|VPN tunnel|Exit · Switzerland|arxiv.org', hops.join('|'));
const hopText = await page.$eval('ol[aria-label="Hops"]', (o) => o.innerText);
check('declared vs verified said per hop', hopText.includes('declared vpn') && hopText.includes('verified by exit identity'), hopText.replace(/\n/g, ' / '));
const dimmed = await page.$$eval(`${DIAG} g[data-band] > path:first-child`, (ps) => ps.filter((p) => Number(p.getAttribute('stroke-opacity')) < 0.2).length);
check('other paths dimmed', dimmed > 3, dimmed);
check('Block arxiv.org and Open in map offered', await page.$('button:has-text("Block arxiv.org")') !== null && await page.$('button:has-text("Open in map")') !== null);
// A refusal's path stops at the wall.
await page.goto(`${BASE}/?view=topology&glove=pi-search&dest=ads.tracker.example`);
await waitFor(async () => (await page.$$('ol[aria-label="Hops"] > li')).length > 0);
const refusedHops = await page.$$eval('ol[aria-label="Hops"] > li', (ls) => ls.map((l) => l.innerText.split('\n')[0]));
check('a refusal stops at the policy hop (deep link)', refusedHops.join('|') === 'pi-search sandbox|proxy service|Policy', refusedHops.join('|'));
// A band click picks that path.
await page.goto(`${BASE}/?view=topology&glove=pi-search`);
await waitFor(async () => (await page.$$(`${DIAG} g[data-node]`)).length > 10);
await page.evaluate(() => { const u = new URL(location.href); u.searchParams.delete('dest'); history.replaceState(null, '', u); });
const bandSel = `${DIAG} g[data-band^="origin:exit>dest:www.nature.com"] path[stroke="transparent"]`;
await page.$eval(bandSel, (p) => p.dispatchEvent(new MouseEvent('click', { bubbles: true })));
check('clicking a band selects its destination', await waitFor(async () => new URL(page.url()).searchParams.get('dest') === 'www.nature.com'), page.url());
// Open in map keeps the selection.
await page.goto(`${BASE}/?view=topology&glove=pi-search&dest=arxiv.org`);
await page.waitForSelector('button:has-text("Open in map")');
await page.click('button:has-text("Open in map")');
check('Open in map → Map tab, same destination', await waitFor(async () => { const u = new URL(page.url()); return u.searchParams.get('view') === 'map' && u.searchParams.get('dest') === 'arxiv.org'; }), page.url());
// Panels.
await page.goto(`${BASE}/?view=topology&glove=pi-search`);
await page.waitForSelector('button[aria-label="Hide Selected path panel"]');
await page.click('button[aria-label="Hide Selected path panel"]');
check('Selected path panel hides', await waitFor(async () => (await page.$('button[aria-label="Hide Selected path panel"]')) === null));
await page.reload();
await page.waitForSelector(DIAG);
check('hidden panel stays hidden after reload', await page.$('button[aria-label="Hide Selected path panel"]') === null);
await page.evaluate(() => localStorage.clear());
// Other sessions draw too.
for (const s of ['direct', 'gate-lost', 'stopped', 'exit-none', 'default-block', 'big']) {
  await page.goto(`${BASE}/?view=topology&glove=${s}`);
  const ok = await waitFor(async () => (await page.$$(`${DIAG} g[data-node]`)).length > 3, 8000);
  check(`session ${s} draws`, ok);
}
const bigFold = await page.$$eval(`${DIAG} g[data-node^="more:"]`, (gs) => gs.map((g) => g.textContent));
check('big session folds quiet destinations into "+N more"', bigFold.length > 0, bigFold.join(','));
// Sizes.
for (const [w, h] of [[1440, 900], [1280, 800]]) {
  await page.setViewportSize({ width: w, height: h });
  await page.goto(`${BASE}/?view=topology&glove=pi-search&dest=arxiv.org`);
  await waitFor(async () => (await page.$$(`${DIAG} g[data-node]`)).length > 10);
  await page.waitForTimeout(800);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(`no horizontal scroll at ${w}×${h}`, overflow <= 0, overflow);
  const clipped = await page.evaluate((sel) => { const s = document.querySelector(sel); const r = s.getBoundingClientRect(); const p = s.parentElement.getBoundingClientRect(); return r.right - p.right; }, DIAG);
  check(`diagram fits its panel at ${w}×${h}`, clipped <= 1, clipped);
  await page.screenshot({ path: `${SHOTS}/p6-topology-${w}.png` });
}
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
check('every request went to Layman itself', foreign.length === 0, foreign.slice(0, 5).join(' '));
for (const r of results) console.log(r.join('  '));
console.log(`${results.filter((r) => r[0] === 'PASS').length}/${results.length}`);
await browser.close();
process.exitCode = results.every((r) => r[0] === 'PASS') ? 0 : 1;
