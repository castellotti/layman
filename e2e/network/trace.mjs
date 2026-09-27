// glove network views browser check (trace; was phase-7 check7). Run via scripts/netobs-e2e.sh.
import { BASE, overflowX, startCheck } from './env.mjs';
const { page, check, waitFor, finish } = await startCheck();
const prompt = () => page.$eval('[role=region][aria-label="Turn"]', (r) => r.innerText);
const rowText = () => page.$$eval('[role=table] [role=row]', (rs) => rs.map((r) => r.innerText.replace(/\s+/g, ' ')));
const details = () => page.$eval('section:has(h2:text-is("Details"))', (s) => s.innerText);

await page.goto(`${BASE}/?view=trace&glove=pi-search`);
await page.evaluate(() => localStorage.clear());
await page.reload();
check('turn bar shows a turn', await waitFor(async () => /TURN \d+ OF \d+/.test(await prompt().catch(() => ''))), await prompt().catch(() => ''));
// Go to the previous turn: the latest may still be in progress.
const before = await prompt();
await page.click('button[aria-label="Previous turn"]');
check('previous turn navigates', await waitFor(async () => (await prompt()) !== before), await prompt());
const bar = await prompt();
check('turn chips: calls, flows, refused, blocked, bytes', /10 tool calls/.test(bar) && /\d+ flows/.test(bar) && /3 refused/.test(bar) && /1 blocked/.test(bar) && /[KM]B/.test(bar), bar.replace(/\n/g, ' | '));
await waitFor(async () => (await rowText()).length > 10);
const rows = await rowText();
const idx = (re) => rows.findIndex((r) => re.test(r));
check('web_search with its fan-out', idx(/web_search .history of onion routing/) >= 0 && /4 fan-out/.test(rows[idx(/web_search/)]) && idx(/fan-out · 4 engines/) === idx(/web_search/) + 1, rows.slice(0, 3).join(' / '));
for (const [url, host] of [['en.wikipedia.org/wiki', 'en.wikipedia.org'], ['arxiv.org/abs', 'arxiv.org'], ['gluetun:8000', 'gluetun:8000'], ['ads.tracker.example', 'ads.tracker.example'], ['arxiv.org/pdf', 'arxiv.org']]) {
  const i = rows.findIndex((r) => r.includes('web_fetch') && r.includes(url));
  check(`fetch ${url} → ${host}`, i >= 0 && rows[i + 1]?.startsWith(host), `${rows[i]} / ${rows[i + 1]}`);
}
check('guard refusal worded', rows.some((r) => r.startsWith('gluetun:8000') && r.includes('refused by glove guard')));
check('rule block worded with the rule note', rows.some((r) => r.startsWith('ads.tracker.example') && r.includes('your rule “ads”')));
check('LLM request row between calls', rows.some((r) => /^llm request \d/.test(r)));
check('redacted fetch says so', rows.some((r) => r.includes('[REDACTED]') && r.includes('host redacted')));
const un = idx(/^Unattributed/);
check('Unattributed group holds the metadata refusal', un >= 0 && rows.slice(un).some((r) => r.startsWith('169.254.169.254')), rows.slice(un).join(' / '));
const d0 = await details();
check('guard refusal selected by default', /Refused by glove guard/.test(d0) && /The agent asked for/.test(d0) && /Can I allow it\?/i.test(d0) && /No\. The guard runs before your rules/.test(d0), d0.replace(/\n/g, ' | '));
check('default row marked selected', (await page.$$eval('[role=row][aria-selected=true]', (rs) => rs.map((r) => r.innerText))).some((t) => t.includes('gluetun')));
// Select another flow.
await page.click('[role=row][data-row^="flow:"]:has-text("ads.tracker.example")');
const d1 = await details();
check('clicking a flow shows its details', /Blocked by your rule/.test(d1) && /Unblock/.test(d1) && /ads\.tracker\.example\/p\.gif/.test(d1), d1.replace(/\n/g, ' | ').slice(0, 200));
await page.click('[role=row][data-row^="call:"]:has-text("arxiv.org/abs")');
const d2 = await details();
check('clicking a call shows its timing and join', /from the transcript/.test(d2) && /host and time/.test(d2), d2.replace(/\n/g, ' | ').slice(0, 200));
// Fan-out expands.
await page.click('[role=row]:has-text("fan-out · 4 engines") button[aria-label="Expand"]');
const r2 = await rowText();
check('fan-out expands to its engines', ['html.duckduckgo.com', 'search.brave.com', 'www.mojeek.com', 'api.qwant.com'].every((h) => r2.some((r) => r.startsWith(h))));
// Only calls with traffic.
await page.click('button:has-text("Only calls with traffic")');
const r3 = await rowText();
check('only calls with traffic hides the redacted fetch', !r3.some((r) => r.includes('[REDACTED]')) && r3.some((r) => r.startsWith('Unattributed')));
await page.click('button:has-text("Only calls with traffic")');
// Toggle opens the block popover.
await page.click('[role=row][data-row^="flow:"]:has-text("en.wikipedia.org") button[aria-pressed]');
check('a flow\'s toggle opens the block popover', await waitFor(async () => (await page.$('[role=dialog]')) !== null, 3000));
await page.keyboard.press('Escape');
await waitFor(async () => (await page.$('[role=dialog]')) === null, 2000);
// Bookmark and Open turn.
await page.click('[role=row][data-row^="flow:"]:has-text("gluetun")');
await page.click('button:has-text("Bookmark")');
check('Bookmark saves the turn as a highlight', await waitFor(async () => (await page.$('button:has-text("Bookmarked")')) !== null, 5000));
const href = await page.$eval('a:has-text("Open turn")', (a) => a.getAttribute('href'));
await page.click('a:has-text("Open turn")');
check('Open turn goes to /s/{session}/t/{prompt}', /^\/s\/[^/]+\/t\/[^/?]+/.test(href) && await waitFor(async () => new URL(page.url()).pathname === href.split('?')[0]), `${href} → ${page.url()}`);
// The detail card's "Agent asked for", and Open in Trace.
await page.goto(`${BASE}/?view=map&glove=pi-search&dest=en.wikipedia.org`);
const asked = async () => page.evaluate(() => {
  const h = [...document.querySelectorAll('div')].find((d) => d.textContent === 'Agent asked for');
  return h ? h.parentElement.innerText : '';
});
check('detail card: Agent asked for names the call', await waitFor(async () => /web_fetch · \d\d:\d\d:\d\d/.test(await asked()) && /en\.wikipedia\.org\/wiki\/Onion_routing/.test(await asked()), 15000), (await asked()).replace(/\n/g, ' | ').slice(0, 200));
await page.click('button:has-text("Open in Trace")');
check('Open in Trace: the Trace tab, that flow selected', await waitFor(async () => new URL(page.url()).searchParams.get('view') === 'trace'
  && (await page.$$eval('[role=row][aria-selected=true]', (rs) => rs.map((r) => r.innerText))).some((t) => t.includes('en.wikipedia.org'))), page.url());
// The ribbon's tool-call markers.
await page.goto(`${BASE}/?view=map&glove=pi-search`);
check('ribbon draws tool-call markers', await waitFor(async () => (await page.$$('g[data-call-marker]')).length > 0, 40000),
  (await page.$$('g[data-call-marker]')).length);
// Switching tabs in place keeps each tab's own panels (a Phase 2 bug showed "Every panel is hidden").
await page.goto(`${BASE}/?view=network&glove=pi-search`);
await page.evaluate(() => localStorage.clear());
await page.reload();
await waitFor(async () => (await page.$('[role=table]')) !== null);
const tabResults = [];
for (const [t, expect] of [['Topology', 'Routes'], ['Trace', 'Agent trace'], ['Map', null], ['Network', 'Destinations'], ['Trace', 'Details']]) {
  await page.click(`button:text-is("${t}")`);
  await page.waitForTimeout(1200);
  const hidden = (await page.$('text=Every panel is hidden')) !== null;
  const ok = !hidden && (expect === null || (await page.$(`section h2:text-is("${expect}")`)) !== null);
  tabResults.push(`${t}:${ok ? 'ok' : hidden ? 'hidden' : 'missing ' + expect}`);
}
check('switching tabs in place shows each tab\'s own panels', tabResults.every((r) => r.endsWith(':ok')), tabResults.join(' '));
const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('layman.net.panels.topology') ?? 'null'));
check('and never saves one tab\'s panels under another', !stored || stored.order.includes('routes'), JSON.stringify(stored));
// A glove session no Layman session is named after.
await page.goto(`${BASE}/?view=trace&glove=direct`);
check('empty state when no Layman session is named after the glove session', await waitFor(async () => (await page.$('text=No Layman session is named')) !== null));
// Sizes.
for (const [w, h] of [[1440, 900], [1280, 800]]) {
  await page.setViewportSize({ width: w, height: h });
  await page.goto(`${BASE}/?view=trace&glove=pi-search`);
  await waitFor(async () => (await page.$$('[role=table] [role=row]')).length > 5);
  const overflow = await overflowX(page);
  check(`no horizontal scroll at ${w}×${h}`, overflow <= 0, overflow);
}
await finish();
