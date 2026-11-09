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
// Every box opens in Details, with what it is for (dismissable) and its traffic.
await page.goto(`${BASE}/?view=topology&glove=${PI}`);
await waitFor(async () => (await page.$$(`${DIAG} g[data-node]`)).length > 10);
await page.click(`${DIAG} g[data-node="svc:proxy"]`);
check('a service opens in Details', await waitFor(async () => (await page.$('[data-box-details="svc:proxy"]')) !== null));
check('…with what it is for', await page.$('[data-box-details="svc:proxy"] [data-box-explanation]') !== null);
check('…its bytes by route and its busiest destinations', await page.$('[data-route-mix]') !== null && await page.$('[data-top-dests]') !== null);
check('…and no destination selected', !new URL(page.url()).searchParams.get('dest'), page.url());
const lit = await page.$$eval(`${DIAG} g[data-band] > path:first-child`, (ps) => ps.filter((p) => Number(p.getAttribute('stroke-opacity')) < 0.2).length);
check('…dimming the paths not through it', lit > 3, lit);
await page.click('button[aria-label="Dismiss this explanation"]');
check('the explanation dismisses', await waitFor(async () => (await page.$('[data-box-explanation]')) === null));
await page.click(`${DIAG} g[data-node="route:tunnel"]`);
check('another box has its own explanation', await waitFor(async () => (await page.$('[data-box-details="route:tunnel"] [data-box-explanation]')) !== null));
await page.click(`${DIAG} g[data-node="svc:proxy"]`);
check('…and coming back brings the dismissed one back', await waitFor(async () => (await page.$('[data-box-details="svc:proxy"] [data-box-explanation]')) !== null));
await page.click(`${DIAG} g[data-node="origin:exit"]`);
check('the exit lists its checks', await waitFor(async () => (await page.$('[data-box-details="origin:exit"] [data-exit-history]')) !== null));
await page.click(`${DIAG} g[data-wall-label="wall:guard"]`);
check('a label on the policy wall opens in Details', await waitFor(async () => (await page.$('[data-box-details="wall:guard"]')) !== null));
await page.click(`${DIAG} g[data-node="sandbox"]`);
await waitFor(async () => (await page.$('[data-box-details="sandbox"]')) !== null);
await page.screenshot({ path: `${SHOTS}/topology-box-sandbox.png` });
await page.click(`${DIAG} g[data-node="sandbox"]`);
check('a second click on the box clears it', await waitFor(async () => (await page.$('[data-box-details]')) === null));
await page.click(`${DIAG} g[data-node="svc:proxy"]`);
await page.click('[data-top-dests] button >> nth=0');
check('a destination in its list follows that path', await waitFor(async () => (await page.$$('ol[aria-label="Hops"] > li')).length > 0) && !!new URL(page.url()).searchParams.get('dest'), page.url());
check('…which has its explanation too', await page.$('[data-box-explanation]') !== null);
await page.click('button[aria-label="Dismiss this explanation"]');
await page.click('button[aria-label="Hide Selected path panel"]');
await page.click('button[data-tip="Show or hide the Details panel"]');
check('closing and reopening the panel brings a dismissed explanation back', await waitFor(async () => (await page.$('[data-box-explanation]')) !== null));
// Every broken path has a row, in a column under the exit that scrolls like the destinations.
await page.goto(`${BASE}/?view=topology&glove=${sid('big')}`);
const BROKEN = `${DIAG} g[data-broken-scroll]`;
check('big session: every broken path drawn', await waitFor(async () => (await page.$$(`${BROKEN} g[data-node^="origin:broken:"]`)).length === 40, 8000),
  (await page.$$(`${BROKEN} g[data-node^="origin:broken:"]`)).length);
check('big session: the broken paths past the window counted below', /↓ \d+ below/.test(await page.$eval(`${DIAG} g[data-broken-stub="below"]`, (g) => g.textContent).catch(() => '')));
check('big session: a scrollbar beside the broken paths', await page.$(`${BROKEN} g[data-broken-scrollbar]`) !== null);
await page.click(`${DIAG} g[data-broken-stub="below"]`);
check('big session: its stub scrolls it, not the destinations', await waitFor(async () => (await page.$(`${DIAG} g[data-broken-stub="above"]`)) !== null)
  && (await page.$(`${DIAG} g[data-stub="above"]`)) === null);
await page.screenshot({ path: `${SHOTS}/topology-broken-scroll.png` });
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
/** Rows whose centre is in the window, and for each whether its bands end against its box. Runs in the page. */
function measureRows(col) {
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
}
const rowsInWindow = () => page.$eval(COL, measureRows);
const bandsAtRows = (rs) => rs.length > 5 && rs.every((r) => r.ends.length > 0 && r.ends.every(Boolean));
const ROWS_G = `${COL} g[clip-path] > g`;
await page.goto(`${BASE}/?view=topology&glove=${sid('big')}`);
await waitFor(async () => (await page.$$(`${DIAG} g[data-node^="dest:"]`)).length > 100);
const first = (await rowsInWindow())[0]?.id;
await page.hover(COL);
await page.mouse.wheel(0, 900);
const moved = await waitFor(async () => { const rs = await rowsInWindow(); return rs.length > 5 && !rs.some((r) => r.id === first); });
await page.waitForTimeout(700);
const after = await rowsInWindow();
check('big session: the wheel scrolls the destination column', moved, `${first} → ${after[0]?.id}`);
check('big session: every band into a row in the window ends at its row', bandsAtRows(after), after.filter((r) => !r.ends.every(Boolean)).map((r) => r.id).join(',') || after.length);
// Mid-animation, when only the frame-by-frame DOM path has moved them: three frames into an eased scroll.
const mid = await page.evaluate(async ({ col, rowsG, measure }) => {
  const c = document.querySelector(col);
  const g = document.querySelector(rowsG);
  const before = g.getAttribute('transform');
  // A wheel the column takes for itself: its listener prevents the page's scroll.
  const kept = !c.dispatchEvent(new WheelEvent('wheel', { deltaY: 600, bubbles: true, cancelable: true }));
  for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(r));
  const during = g.getAttribute('transform');
  const rows = (0, eval)(`(${measure})`)(c);
  await new Promise((r) => setTimeout(r, 900));
  return { kept, before, during, after: g.getAttribute('transform'), rows };
}, { col: COL, rowsG: ROWS_G, measure: measureRows.toString() });
check('big session: mid-scroll, the bands follow the rows frame by frame', mid.during !== mid.before && mid.during !== mid.after && bandsAtRows(mid.rows),
  `${mid.before} → ${mid.during} → ${mid.after}`);
check('big session: the column keeps its wheel from the page (default prevented)', mid.kept);
check('big session: a scrollbar beside the column', await page.$(`${COL} g[data-dest-scrollbar]`) !== null);
const tabStops = await page.$$eval(`${COL} g[data-node^="dest:"][tabindex="0"]`, (gs) => gs.length);
check('big session: only rows in the window are Tab stops', tabStops > 5 && tabStops < 40, tabStops);
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
/** The rows' transform just before and just after a stub click, in the same task: no frame in between. */
const clickNow = () => page.evaluate(({ stub, rowsG }) => {
  const g = document.querySelector(rowsG);
  const before = g.getAttribute('transform');
  document.querySelector(stub).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return [before, g.getAttribute('transform')];
}, { stub: `${DIAG} g[data-stub="below"]`, rowsG: ROWS_G });
const [rb, ra] = await clickNow();
check('reduced motion: a stub click scrolls at once', rb !== ra, `${rb} → ${ra}`);
await page.emulateMedia({ reducedMotion: null });
await page.goto(`${BASE}/?view=topology&glove=${sid('big')}`);
await waitFor(async () => (await page.$(`${DIAG} g[data-stub="below"]`)) !== null);
const [eb, ea] = await clickNow();
check('…and without it, the same click eases (nothing has moved yet in that task)', eb === ea, `${eb} → ${ea}`);
// The model's path along the top, on a session shaped like the one whose diagram overlapped:
// llm → llm-auth → llm-upstream to a LAN host, Playwright's egress, broken paths and guard refusals.
await page.setViewportSize({ width: 1440, height: 900 });
await page.goto(`${BASE}/?view=topology&glove=${sid('llm-lan')}`);
check('llm-lan draws', await waitFor(async () => (await page.$$(`${DIAG} g[data-node]`)).length > 10, 8000));
await page.waitForTimeout(500);
/** Each box's on-screen rectangle, by node id (and the wall label boxes by theirs). */
const boxes = await page.$$eval(`${DIAG} g[data-node], ${DIAG} g[data-wall-label]`, (gs) => Object.fromEntries(gs.map((g) => {
  const r = (g.querySelector('rect') ?? g).getBoundingClientRect();
  return [g.dataset.node ?? g.dataset.wallLabel, { top: r.top, bottom: r.bottom, left: r.left, right: r.right }];
})));
const svcOrder = Object.keys(boxes).filter((id) => id.startsWith('svc:')).sort((a, b) => boxes[a].top - boxes[b].top);
check('llm-lan: each egress gate sits above the hop into it', svcOrder.join(',') === 'svc:llm-upstream,svc:llm,svc:browser-egress,svc:browser', svcOrder.join(','));
const routeIds = Object.keys(boxes).filter((id) => id.startsWith('route:')).sort((a, b) => boxes[a].top - boxes[b].top);
check('llm-lan: the LLM link first, and no unused Local or Direct', routeIds.join(',') === 'route:llm,route:tunnel', routeIds.join(','));
const pinnedRow = boxes['dest:gpu.lan:8080'];
const inScroll = await page.$(`${DIAG} g[data-dest-scroll] g[data-node="dest:gpu.lan:8080"]`);
check('llm-lan: the model\'s destination is pinned, outside the scrolling column', !!pinnedRow && !inScroll);
const centreY = (b) => (b.top + b.bottom) / 2;
check('llm-lan: …level with its route', !!pinnedRow && Math.abs(centreY(pinnedRow) - centreY(boxes['route:llm'])) < 2, pinnedRow && `${centreY(pinnedRow)} vs ${centreY(boxes['route:llm'])}`);
check('llm-lan: …and with llm-upstream, so the path runs straight across', Math.abs(centreY(boxes['svc:llm-upstream']) - centreY(boxes['route:llm'])) < 2,
  `${centreY(boxes['svc:llm-upstream'])} vs ${centreY(boxes['route:llm'])}`);
const exitBox = boxes['origin:exit'];
check('llm-lan: the exit is under the model\'s path', exitBox.top > Math.max(pinnedRow.bottom, boxes['route:llm'].bottom), `${exitBox.top}`);
check('llm-lan: the exit is no lower than the tunnel route', exitBox.top <= boxes['route:tunnel'].top + 1, `${exitBox.top} / ${boxes['route:tunnel'].top}`);
const brokenTop = await page.$eval(`${DIAG} g[data-broken-scroll] > g[clip-path]`, (g) => g.getBoundingClientRect().top);
check('llm-lan: the broken paths start under the exit and their route', brokenTop > exitBox.bottom && brokenTop >= boxes['route:tunnel'].top - 1, `${brokenTop}`);
const wallBottom = Math.max(...Object.entries(boxes).filter(([id]) => id.startsWith('wall:')).map(([, b]) => b.bottom));
const under = Object.entries(boxes).filter(([id]) => /^(svc|route|origin|sandbox)/.test(id) && boxes[id].top < wallBottom).map(([id]) => id);
check('llm-lan: no box sits beside the policy wall\'s labels', under.length === 0, under.join(','));
await page.click(`${DIAG} g[data-node="dest:gpu.lan:8080"]`);
const explainedLast = await waitFor(() => page.evaluate(() => {
  const n = document.querySelector('[data-box-explanation]');
  return !!n && !n.nextElementSibling;
}));
check('llm-lan: a path\'s note comes last in Details', explainedLast);
await page.screenshot({ path: `${SHOTS}/topology-llm-lan.png` });
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
