// glove network views browser check: time ranges set through the URL. Run via scripts/netobs-e2e.sh.
import { BASE, SHOTS, startCheck, PI } from './env.mjs';
const { page, check, waitFor, has, finish } = await startCheck();
const DIAG = 'svg[aria-label^="Routes from"]';
const BANNER = 'div[role="status"]:has-text("Only the traffic in this range")';
const iso = (t) => new Date(t).toISOString();
const url = () => new URL(page.url());
const tab = (label) => page.click(`nav[aria-label="Network"] button:has-text("${label}")`);
const destCount = async () => {
  // The Network tab's Destinations panel count, as the KPI row shows it.
  const t = await page.$eval('text=/^DESTINATIONS$/i >> xpath=..', (e) => e.textContent).catch(() => '');
  return Number((t.match(/\d+/) ?? ['NaN'])[0]);
};

// The fixture replays at the current time, so its records are in the last few minutes.
const now = Date.now();
const recent = `from=${iso(now - 60 * 60_000)}&to=now`;

await page.goto(`${BASE}/?view=topology&glove=${PI}`);
await page.evaluate(() => localStorage.clear());
check('All records draws with no range banner', await waitFor(async () => (await page.$$(`${DIAG} g[data-node]`)).length > 10) && !(await page.$(BANNER)));

await page.goto(`${BASE}/?view=topology&glove=${PI}&${recent}`);
check('a range deep link draws the diagram from the server’s ranged snapshot', await waitFor(async () => (await page.$$(`${DIAG} g[data-node]`)).length > 10, 20000));
const banner = await page.$eval(BANNER, (e) => e.textContent).catch(() => '');
check('the banner says the span, local time, ending now', /→ now \(1 h\)/.test(banner), banner);
check('the URL keeps the range', url().searchParams.get('to') === 'now' && url().searchParams.get('from') === iso(now - 60 * 60_000), page.url());
await page.screenshot({ path: `${SHOTS}/range-topology.png` });

// Switching tabs keeps the range.
for (const label of ['Network', 'Map', 'Trace', 'Topology']) {
  await tab(label);
  await page.waitForTimeout(400);
  check(`${label}: the range survives switching tabs`, url().searchParams.get('to') === 'now' && await has(BANNER)(), page.url());
}

// A range before any record: nothing to show, and it says why.
const empty = `from=${iso(now - 48 * 3_600_000)}&to=${iso(now - 47 * 3_600_000)}`;
await page.goto(`${BASE}/?view=network&glove=${PI}&${empty}`);
check('a range before any record still loads', await waitFor(has(BANNER), 20000));
const gap = await page.$eval(BANNER, (e) => e.textContent).catch(() => '');
check('…and says glove’s files do not reach it', /no records for this range|only reach back/.test(gap), gap);
check('…and shows no destinations', await waitFor(async () => (await destCount()) === 0), await destCount());

// All records, then Back to the range.
await page.goto(`${BASE}/?view=network&glove=${PI}&${recent}`);
await waitFor(has(BANNER), 20000);
await page.click(`${BANNER} >> button:has-text("All records")`);
check('All records clears the range from the URL', await waitFor(async () => !url().searchParams.has('from')), page.url());
check('…and the banner', await waitFor(async () => !(await page.$(BANNER))));
await page.goBack();
check('Back returns to the range', await waitFor(async () => url().searchParams.get('to') === 'now' && await has(BANNER)(), 20000), page.url());

// Another glove session clears the range.
await page.selectOption('select[aria-label="Glove session"]', { index: 1 }).catch(() => {});
check('choosing another glove session clears the range', await waitFor(async () => url().searchParams.get('glove') !== PI && !url().searchParams.has('from')), page.url());

// An unknown session's range is answered, not left loading.
await page.goto(`${BASE}/?view=topology&glove=${PI}&from=garbage&to=now`);
check('a malformed range is ignored: All records', await waitFor(async () => (await page.$$(`${DIAG} g[data-node]`)).length > 10) && !(await page.$(BANNER)));

await finish();
