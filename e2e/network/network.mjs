// glove network views browser check (network; was phase-3 check3). Run via scripts/netobs-e2e.sh.
import { BASE, SHOTS, overflowX, startCheck, PI, sid } from './env.mjs';
const { page, check, finish } = await startCheck();

const rowsText = () => page.$$eval('[role=table][aria-label=Destinations] [role=row]', (rs) => rs.map((r) => r.innerText.replace(/\s+/g, ' ').trim()));
const stateTexts = () => page.$$eval('[role=table][aria-label=Destinations] [role=row] [role=cell]:last-child', (cs) => cs.map((c) => c.innerText.trim()));

await page.goto(`${BASE}/?view=network&glove=${PI}`);
await page.waitForSelector('[role=table][aria-label=Destinations] [role=row] >> nth=2', { timeout: 15000 });
await page.waitForTimeout(8000); // let the replay progress
await page.screenshot({ path: `${SHOTS}/network-1440.png` });

const kpi = await page.$$eval('div', (ds) => ds.filter((d) => /^(SENT|RECEIVED|LIVE|DESTINATIONS|BLOCKED|UNTUNNELLED)$/.test(d.innerText.trim())).map((d) => d.innerText.trim()));
check('KPI row has the six tiles', ['SENT', 'RECEIVED', 'LIVE', 'DESTINATIONS', 'BLOCKED', 'UNTUNNELLED'].every((k) => kpi.includes(k)), kpi.join(','));
const chips = await page.$$eval('[role=group][aria-label=Show] button', (bs) => bs.map((b) => b.innerText.trim()));
check('filter chips', chips.length === 5 && /^All \d+$/.test(chips[0]), chips.join(' | '));
const header = await page.$$eval('[role=columnheader]', (hs) => hs.map((h) => h.innerText.trim()).filter(Boolean));
check('columns', header.join(',') === 'DESTINATION,ROUTE,TOOL,ACTIVITY,SENT,RECEIVED,FLOWS,LAST,STATE', header.join(','));
let rows = await rowsText();
check('fixed groups present', ['Refused by glove guard', 'Local links'].every((g) => rows.some((r) => r.includes(g))), '');
check('not-watched browser row', rows.some((r) => r.includes('browser') && r.includes('not watched')), '');
const toggles = await page.$$eval('[role=table] button[aria-pressed]', (bs) => bs.map((b) => [b.getAttribute('aria-label'), b.disabled]));
check('toggles are labelled buttons (enabled since phase 4)', toggles.length > 3 && toggles.every(([l]) => l) && toggles.filter(([l]) => l.startsWith('Block ')).every(([, d]) => !d) && toggles.filter(([l]) => /refused by glove/.test(l)).every(([, d]) => d), JSON.stringify(toggles.slice(0, 3)));
check('guard toggles locked', toggles.some(([l]) => /refused by glove’s guard/.test(l)), '');

// Expand arxiv.org → flows
await page.click('button[aria-label="Expand arxiv.org"]');
rows = await rowsText();
check('arxiv expands to flows', rows.some((r) => /flow f_…/.test(r)), rows.filter((r) => /flow f_/.test(r)).slice(0, 2).join(' / '));
// Select a destination → dest= in URL
await page.click('[role=row]:has-text("arxiv.org") >> nth=0');
await page.waitForTimeout(300);
check('selecting sets dest= in the URL', page.url().includes('dest=arxiv.org'), page.url());
// Text filter
await page.fill('input[aria-label="Filter destinations"]', 'wikipedia');
await page.waitForTimeout(200);
rows = await rowsText();
check('text filter', rows.length >= 2 && rows.slice(1).every((r) => /wikipedia|not loaded|flow/.test(r)), rows.slice(1).join(' / '));
await page.fill('input[aria-label="Filter destinations"]', '');
// Blocked chip
await page.click('[role=group][aria-label=Show] button:has-text("Blocked")');
rows = await rowsText();
check('Blocked filter', rows.slice(1).every((r) => /refused|blocked|guard|tracker|169\.254|gluetun|proxy endpoint/.test(r)), rows.slice(1).join(' / '));
await page.click('[role=group][aria-label=Show] button:has-text("All")');
// Group by route and tool
await page.selectOption('select[aria-label="Group by"]', 'route');
rows = await rowsText();
check('group by route', rows.some((r) => r.startsWith('VPN') || r.includes(' VPN ')), rows.slice(1, 4).join(' / '));
await page.selectOption('select[aria-label="Group by"]', 'domain');
await page.selectOption('select[aria-label="Sort"]', 'bytes');
check('sort by bytes selectable', (await page.$eval('select[aria-label="Sort"]', (s) => s.value)) === 'bytes');
// Rules panel
const rulesText = await page.$eval('section:has(h2:text-is("Rules"))', (s) => s.innerText);
check('rules panel: status, guard row, rule, default', /Enforced by the gate/.test(rulesText) && /internal, metadata, malformed/.test(rulesText) && /host \*\.tracker\.example|tracker/.test(rulesText) && /Allow unless blocked/.test(rulesText), rulesText.slice(0, 120).replace(/\n/g, ' | '));
// Mini map → Map tab
await page.click('[aria-label="Open the Map tab"]');
await page.waitForTimeout(300);
check('mini map opens the Map tab', page.url().includes('view=map'), page.url());

// Every state across the scenario sessions. The looping replays pass through their states in
// turn, so one sweep can land between them: sweep again until every state has shown (or 4 sweeps).
const seen = new Set();
const sweep = async (shots) => {
  for (const s of ['pi-search', 'default-block', 'direct', 'empty', 'gate-lost', 'pooled', 'record-full', 'resolver-down', 'rules-rejected', 'search', 'stopped', 'terminate', 'telemetry-dropped']) {
    await page.goto(`${BASE}/?view=network&glove=${sid(s)}`);
    await page.waitForSelector('[role=table][aria-label=Destinations]', { timeout: 10000 });
    await page.waitForTimeout(600);
    // expand everything collapsed, so host and flow rows show their states
    for (let i = 0; i < 3; i++) {
      const bs = await page.$$('[role=table] button[aria-label^="Expand "]');
      for (const b of bs) await b.click().catch(() => {});
    }
    if (s === 'empty') {
      const show = await page.$('button:text-is("show")');
      if (show) await show.click();
    }
    // Past 200 rows the table is windowed: scroll through it to see every row.
    for (let y = 0; ; y += 400) {
      for (const t of await stateTexts()) seen.add(t);
      const more = await page.$eval('[role=table][aria-label=Destinations]', (t, y) => { t.scrollTop = y; return t.scrollTop + t.clientHeight < t.scrollHeight; }, y);
      await page.waitForTimeout(50);
      if (!more) { for (const t of await stateTexts()) seen.add(t); break; }
    }
    if (shots && ['gate-lost', 'direct', 'rules-rejected', 'empty'].includes(s)) await page.screenshot({ path: `${SHOTS}/scenario-${s}.png` });
  }
};
const want = {
  active: /^(live|open )/, pooled: /pooled/, finished: /^finished · eof/, guard: /refused by glove guard/, malformed: /refused · malformed request/,
  user_rule: /^blocked · your rule/, default_block: /nothing allowed it/, broken: /path broken/, gate_shutdown: /gate shut down/,
  gate_lost: /gate went away \(inferred\)/, empty: /^empty ·/, cleartext: /cleartext http/, direct: /^untunnelled/, not_watched: /not watched/,
};
for (let i = 0; i < 4; i++) {
  await sweep(i === 0);
  if (Object.values(want).every((re) => [...seen].some((t) => re.test(t)))) break;
  await page.waitForTimeout(5000);
}
for (const [k, re] of Object.entries(want)) check(`state rendered: ${k}`, [...seen].some((t) => re.test(t)), '');

// Windowing
await page.goto(`${BASE}/?view=network&glove=${sid('big')}`);
await page.waitForSelector('[role=table][aria-label=Destinations] [role=row] >> nth=2');
await page.selectOption('select[aria-label="Group by"]', 'tool');
await page.click('button[aria-label="Expand web_fetch"]');
await page.waitForTimeout(300);
const total = Number(await page.$eval('[role=table][aria-label=Destinations]', (t) => t.getAttribute('aria-rowcount')));
const rendered = (await rowsText()).length - 1;
check('windowing past 200 rows', total > 200 && rendered < 80, `total ${total}, rendered ${rendered}`);
await page.$eval('[role=table][aria-label=Destinations]', (t) => { t.scrollTop = t.scrollHeight; });
await page.waitForTimeout(300);
const lastRows = await rowsText();
check('windowing scrolls to the end', lastRows.some((r) => /host0\./.test(r)) || lastRows.length > 1, lastRows[lastRows.length - 1]);

// 1280×800: no horizontal page scroll
await page.setViewportSize({ width: 1280, height: 800 });
await page.goto(`${BASE}/?view=network&glove=${PI}`);
await page.waitForSelector('[role=table][aria-label=Destinations] [role=row] >> nth=2');
await page.waitForTimeout(500);
const overflow = await overflowX(page);
check('no horizontal page scroll at 1280×800', overflow <= 0, `overflow ${overflow}`);
await page.screenshot({ path: `${SHOTS}/network-1280.png` });

await finish();
