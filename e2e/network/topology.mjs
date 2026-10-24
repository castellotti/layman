// glove network views browser check (topology; was phase-6 check6). Run via scripts/netobs-e2e.sh.
import { BASE, SHOTS, overflowX, startCheck, PI, sid } from './env.mjs';
const { page, check, waitFor, finish } = await startCheck();
const DIAG = 'svg[aria-label^="Routes from"]';
const nodeTitles = (kind) => page.$$eval(`${DIAG} g[data-node^="${kind}"] > text:first-of-type`, (ts) => ts.map((t) => t.textContent));

await page.goto(`${BASE}/?view=topology&glove=${PI}`);
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
check('hop list sandbox → service → policy → tunnel → exit → destination', hops.join('|') === `${PI} sandbox|proxy service|Policy|VPN tunnel|Exit · Switzerland|arxiv.org`, hops.join('|'));
const hopText = await page.$eval('ol[aria-label="Hops"]', (o) => o.innerText);
check('declared vs verified said per hop', hopText.includes('declared vpn') && hopText.includes('verified by exit identity'), hopText.replace(/\n/g, ' / '));
const dimmed = await page.$$eval(`${DIAG} g[data-band] > path:first-child`, (ps) => ps.filter((p) => Number(p.getAttribute('stroke-opacity')) < 0.2).length);
check('other paths dimmed', dimmed > 3, dimmed);
check('Block arxiv.org and Open in map offered', await page.$('button:has-text("Block arxiv.org")') !== null && await page.$('button:has-text("Open in map")') !== null);
// A refusal's path stops at the wall.
await page.goto(`${BASE}/?view=topology&glove=${PI}&dest=ads.tracker.example`);
await waitFor(async () => (await page.$$('ol[aria-label="Hops"] > li')).length > 0);
const refusedHops = await page.$$eval('ol[aria-label="Hops"] > li', (ls) => ls.map((l) => l.innerText.split('\n')[0]));
check('a refusal stops at the policy hop (deep link)', refusedHops.join('|') === `${PI} sandbox|proxy service|Policy`, refusedHops.join('|'));
// A band click picks that path.
await page.goto(`${BASE}/?view=topology&glove=${PI}`);
await waitFor(async () => (await page.$$(`${DIAG} g[data-node]`)).length > 10);
await page.evaluate(() => { const u = new URL(location.href); u.searchParams.delete('dest'); history.replaceState(null, '', u); });
const bandSel = `${DIAG} g[data-band^="origin:exit>dest:www.nature.com"] path[stroke="transparent"]`;
await page.$eval(bandSel, (p) => p.dispatchEvent(new MouseEvent('click', { bubbles: true })));
check('clicking a band selects its destination', await waitFor(async () => new URL(page.url()).searchParams.get('dest') === 'www.nature.com'), page.url());
// Open in map keeps the selection.
await page.goto(`${BASE}/?view=topology&glove=${PI}&dest=arxiv.org`);
await page.waitForSelector('button:has-text("Open in map")');
await page.click('button:has-text("Open in map")');
check('Open in map → Map tab, same destination', await waitFor(async () => { const u = new URL(page.url()); return u.searchParams.get('view') === 'map' && u.searchParams.get('dest') === 'arxiv.org'; }), page.url());
// Panels.
await page.goto(`${BASE}/?view=topology&glove=${PI}`);
await page.waitForSelector('button[aria-label="Hide Selected path panel"]');
await page.click('button[aria-label="Hide Selected path panel"]');
check('Selected path panel hides', await waitFor(async () => (await page.$('button[aria-label="Hide Selected path panel"]')) === null));
await page.reload();
await page.waitForSelector(DIAG);
check('hidden panel stays hidden after reload', await page.$('button[aria-label="Hide Selected path panel"]') === null);
await page.evaluate(() => localStorage.clear());
// Other sessions draw too.
for (const s of ['direct', 'gate-lost', 'stopped', 'exit-none', 'default-block', 'big']) {
  await page.goto(`${BASE}/?view=topology&glove=${sid(s)}`);
  const ok = await waitFor(async () => (await page.$$(`${DIAG} g[data-node]`)).length > 3, 8000);
  check(`session ${s} draws`, ok);
}
// Nothing is folded: rows past the window are counted by the stub the bands converge on.
const below = await page.$eval(`${DIAG} g[data-stub="below"]`, (g) => g.textContent).catch(() => '');
const allRows = (await page.$$(`${DIAG} g[data-node^="dest:"]`)).length;
check('big session: no folding, every row drawn, the rest counted below', !(await page.$(`${DIAG} g[data-node^="more:"]`)) && /↓ \d+ below/.test(below)
  && allRows === 300 && Number(below.match(/\d+/)[0]) > 100, `${allRows} rows · ${below}`);
await page.click(`${DIAG} g[data-stub="below"]`);
const above = await waitFor(async () => /↑ \d+ above/.test(await page.$eval(`${DIAG} g[data-stub="above"]`, (g) => g.textContent).catch(() => '')));
check('big session: clicking the stub scrolls the next rows in', above);
// The column scrolls on its own, and the bands follow the rows.
const COL = `${DIAG} g[data-dest-scroll]`;
/** Rows whose centre is in the window, and for each the screen y where its bands end against its box. */
const rowsInWindow = () => page.$eval(COL, (col) => {
  const win = col.querySelector(':scope > rect').getBoundingClientRect();
  const svg = col.ownerSVGElement;
  return [...col.querySelectorAll('g[data-node^="dest:"]')].map((g) => {
    const r = g.querySelector('rect').getBoundingClientRect();
    const c = (r.top + r.bottom) / 2;
    if (c < win.top || c > win.bottom) return null;
    const ends = [...svg.querySelectorAll(`g[data-band$=">${g.dataset.node}"] > path:first-child`)].map((p) => {
      const pt = p.getPointAtLength(p.getTotalLength()).matrixTransform(p.getScreenCTM());
      return pt.y >= r.top - 1 && pt.y <= r.bottom + 1;
    });
    return { id: g.dataset.node, ends };
  }).filter(Boolean);
});
await page.goto(`${BASE}/?view=topology&glove=${sid('big')}`);
await waitFor(async () => (await page.$$(`${DIAG} g[data-node^="dest:"]`)).length > 100);
const first = (await rowsInWindow())[0]?.id;
await page.hover(COL);
await page.mouse.wheel(0, 900);
const moved = await waitFor(async () => { const rs = await rowsInWindow(); return rs.length > 5 && !rs.some((r) => r.id === first); });
await page.waitForTimeout(700);
const after = await rowsInWindow();
check('big session: the wheel scrolls the destination column', moved, `${first} → ${after[0]?.id}`);
check('big session: every band into a row in the window ends at its row', after.length > 5 && after.every((r) => r.ends.length > 0 && r.ends.every(Boolean)),
  after.filter((r) => !r.ends.every(Boolean)).map((r) => r.id).join(',') || after.length);
check('big session: the wheel scrolled the column, not the page', await page.evaluate(() => window.scrollY === 0 && document.scrollingElement.scrollTop === 0));
check('big session: a scrollbar beside the column', await page.$(`${COL} g[data-dest-scrollbar]`) !== null);
await page.focus(COL);
await page.keyboard.press('End');
check('big session: End scrolls to the last row', await waitFor(async () => (await page.$(`${DIAG} g[data-stub="below"]`)) === null));
await page.keyboard.press('Home');
check('big session: Home scrolls back to the first', await waitFor(async () => (await page.$(`${DIAG} g[data-stub="above"]`)) === null && (await rowsInWindow())[0]?.id === first));
// A destination chosen in the Network tab is scrolled into view on the Topology tab.
const lastId = await page.$$eval(`${COL} g[data-node^="dest:"]`, (gs) => gs.at(-1).dataset.node);
const lastHost = lastId.replace(/^dest:/, '').replace(/:\d+$/, '');
await page.goto(`${BASE}/?view=network&glove=${sid('big')}&dest=${encodeURIComponent(lastHost)}`);
await page.waitForTimeout(800);
await page.click('nav >> text=Topology').catch(() => page.click('text=Topology'));
check('big session: a destination chosen in the Network tab is scrolled into view', await waitFor(async () => (await rowsInWindow()).some((r) => r.id === lastId), 8000), lastId);
// Sorting, on a session whose destinations differ in bytes and name.
await page.goto(`${BASE}/?view=topology&glove=${PI}`);
await page.waitForSelector(`${DIAG} text[data-dest-sort="bytes"]`);
const titles = () => page.$$eval(`${COL} g[data-node^="dest:"]`, (gs) => gs.map((g) => g.dataset.node));
const byBytes = await titles();
await page.click(`${DIAG} text[data-dest-sort]`);
check('the sort toggles to name, and is kept', await waitFor(async () => (await page.$(`${DIAG} text[data-dest-sort="name"]`)) !== null)
  && await page.evaluate(() => localStorage.getItem('layman.topology.destSort')) === 'name');
const byName = await titles();
check('sorting by name reorders the rows', byName.join() !== byBytes.join() && [...byName].sort().join() === [...byBytes].sort().join(), byName.slice(0, 6).join(','));
await page.evaluate(() => localStorage.removeItem('layman.topology.destSort'));
// Reduced motion: a stub click lands at once.
await page.emulateMedia({ reducedMotion: 'reduce' });
await page.goto(`${BASE}/?view=topology&glove=${sid('big')}`);
await waitFor(async () => (await page.$(`${DIAG} g[data-stub="below"]`)) !== null);
await page.click(`${DIAG} g[data-stub="below"]`);
check('reduced motion: a stub click scrolls at once', await page.$(`${DIAG} g[data-stub="above"]`) !== null);
await page.emulateMedia({ reducedMotion: null });
// Sizes.
for (const [w, h] of [[1440, 900], [1280, 800]]) {
  await page.setViewportSize({ width: w, height: h });
  await page.goto(`${BASE}/?view=topology&glove=${PI}&dest=arxiv.org`);
  await waitFor(async () => (await page.$$(`${DIAG} g[data-node]`)).length > 10);
  await page.waitForTimeout(800);
  const overflow = await overflowX(page);
  check(`no horizontal scroll at ${w}×${h}`, overflow <= 0, overflow);
  const clipped = await page.evaluate((sel) => { const s = document.querySelector(sel); const r = s.getBoundingClientRect(); const p = s.parentElement.getBoundingClientRect(); return r.right - p.right; }, DIAG);
  check(`diagram fits its panel at ${w}×${h}`, clipped <= 1, clipped);
  await page.screenshot({ path: `${SHOTS}/p6-topology-${w}.png` });
}
await finish();
