// glove network views browser check: time ranges, through the URL and the range picker. Run via scripts/netobs-e2e.sh.
import { BASE, SHOTS, startCheck, PI } from './env.mjs';
const { page, check, waitFor, has, finish } = await startCheck();
const DIAG = 'svg[aria-label^="Routes from"]';
const RANGE = 'button[aria-label="Time range"]';
const ICON = 'button[data-range-button][aria-label$="the time range"]';
const PICKER = 'div[role="dialog"][aria-label="Time range"]';
const COVERAGE = 'div[role="status"][aria-label="Range coverage"]';
const iso = (t) => new Date(t).toISOString();
const url = () => new URL(page.url());
const tab = (label) => page.click(`nav[aria-label="Network"] button:has-text("${label}")`);
const rangeText = () => page.$eval(RANGE, (e) => e.textContent).catch(() => '');
const drawn = () => waitFor(async () => (await page.$$(`${DIAG} g[data-node]`)).length > 10, 20000);
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
await page.reload();
check('All records: the strip says so, and no panel is marked in range', await drawn()
  && (await rangeText()).includes('All records') && !(await page.$('[data-in-range]')));
check('…the routine chips are icons, the tips still say what they are', await waitFor(async () => (await page.$$('[data-chip-compact]')).length >= 3)
  && !!(await page.$('[data-chip-compact][data-tip-heading="Hostnames looked up in the tunnel"]')));

await page.goto(`${BASE}/?view=topology&glove=${PI}&${recent}`);
check('a range deep link draws the diagram from the server’s ranged snapshot', await drawn());
check('the strip says the span, local time, ending now', await waitFor(async () => /→ now \(1 h\)/.test(await rangeText())), await rangeText());
check('…and the panel is marked in range', await has('[data-in-range]')());
check('the URL keeps the range', url().searchParams.get('to') === 'now' && url().searchParams.get('from') === iso(now - 60 * 60_000), page.url());
await page.screenshot({ path: `${SHOTS}/range-topology.png` });

// Switching tabs keeps the range.
for (const label of ['Network', 'Map', 'Trace', 'Topology']) {
  await tab(label);
  await page.waitForTimeout(400);
  check(`${label}: the range survives switching tabs`, url().searchParams.get('to') === 'now' && /→ now/.test(await rangeText()), page.url());
}

// Trace counts the turns begun in the range.
await tab('Trace');
check('Trace counts only the turns in the range', await waitFor(async () => /IN RANGE|No turn began in this time range/.test(
  await page.$eval('.net-view', (m) => m.innerText).catch(() => '')), 10000));
await tab('Topology');

// A range before any record: nothing to show, and it says why.
const empty = `from=${iso(now - 48 * 3_600_000)}&to=${iso(now - 47 * 3_600_000)}`;
await page.goto(`${BASE}/?view=network&glove=${PI}&${empty}`);
check('a range before any record still loads', await waitFor(has(COVERAGE), 20000));
const gap = await page.$eval(COVERAGE, (e) => e.textContent).catch(() => '');
// glove kept everything here: the range simply starts before the session, which is not a gap.
check('…and says when the session began, without claiming traffic was lost', /The session began/.test(gap) && !/only reach back|not counted/.test(gap), gap);
check('…and shows no destinations', await waitFor(async () => (await destCount()) === 0), await destCount());
// From just after the session began (an hour back predates the fresh fixture, which the banner says).
const began = await page.evaluate(async (pi) => (await (await fetch(`/api/net/sessions/${pi}/segments`)).json()).runs[0]?.from, PI);
await page.goto(`${BASE}/?view=topology&glove=${PI}&from=${iso(began + 1000)}&to=now`);
await drawn();
check('a range glove covers in full has no coverage banner', typeof began === 'number' && !(await page.$(COVERAGE)),
  await page.$eval(COVERAGE, (e) => e.textContent).catch(() => 'none'));
await page.goto(`${BASE}/?view=topology&glove=${PI}&${recent}`);
await drawn();

// ✕ back to All records, then Back to the range.
await page.click('button[aria-label="Show All records"]');
check('✕ clears the range from the URL', await waitFor(async () => !url().searchParams.has('from')), page.url());
check('…and the strip says All records', await waitFor(async () => (await rangeText()).includes('All records')));
await page.goBack();
check('Back returns to the range', await waitFor(async () => url().searchParams.get('to') === 'now' && /→ now/.test(await rangeText()), 20000), page.url());

// The picker: a run, a preset, a brush, All records.
await page.click(RANGE);
check('the range button opens the picker', await waitFor(has(PICKER)));
const runs = `${PICKER} [role="list"] button`;
check('…listing the session’s runs', await waitFor(async () => (await page.$$(runs)).length > 0, 10000));
await page.screenshot({ path: `${SHOTS}/range-picker-runs.png` });
const runTitle = await page.$eval(runs, (b) => b.querySelector('span span')?.textContent ?? '');
await page.click(runs);
check('a run sets the range, named in the strip', await waitFor(async () => url().searchParams.has('from') && (await rangeText()).startsWith(runTitle), 10000),
  `${runTitle} | ${await rangeText()}`);
await page.click(`${PICKER} button[role="tab"]:has-text("Calendar")`);
check('the calendar draws the month', (await page.$$(`${PICKER} [role="gridcell"]`)).length >= 28);
await page.screenshot({ path: `${SHOTS}/range-picker-calendar.png` });
await page.click(`${PICKER} button:has-text("Last hour")`);
check('a preset sets an open range', await waitFor(async () => url().searchParams.get('to') === 'now'
  && Math.abs(Date.parse(url().searchParams.get('from')) - (Date.now() - 3_600_000)) < 120_000), page.url());
await page.fill(`${PICKER} input[aria-label="Range start"]`, '2026-01-01T00:00');
await page.fill(`${PICKER} input[aria-label="Range end"]`, '2026-01-01T01:00');
await page.click(`${PICKER} button:has-text("Apply")`);
check('the fields set a closed range, in local time', await waitFor(async () =>
  Date.parse(url().searchParams.get('from')) === new Date(2026, 0, 1).getTime() && Date.parse(url().searchParams.get('to')) === new Date(2026, 0, 1, 1).getTime()), page.url());
await page.click(`${PICKER} button[role="tab"]:has-text("Timeline")`);
const tl = await page.$(`${PICKER} svg[aria-label="Timeline"]`);
const box = tl ? await tl.boundingBox() : null;
if (box) {
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
}
check('dragging the timeline sets a range', await waitFor(async () => {
  const f = Date.parse(url().searchParams.get('from') ?? '');
  return Number.isFinite(f) && f > new Date(2026, 0, 2).getTime();
}), page.url());
await page.screenshot({ path: `${SHOTS}/range-picker-timeline.png` });
await page.click(`${PICKER} button:has-text("All records")`);
check('All records in the picker clears the range', await waitFor(async () => !url().searchParams.has('from')), page.url());
await page.keyboard.press('Escape');
check('Escape closes the picker', await waitFor(async () => !(await page.$(PICKER))));

// The calendar icon hides the display; with a range set it stays lit, and the setting is kept.
await page.goto(`${BASE}/?view=topology&glove=${PI}&${recent}`);
await drawn();
await page.click(ICON);
check('the calendar icon hides the range display and gives the chips back', await waitFor(async () => !(await page.$(RANGE)) && (await page.$$('[data-chip-compact]')).length === 0));
check('…while it stays lit, its tip giving the range', await page.$eval(ICON, (b) => b.getAttribute('data-tip-heading')) === 'A time range is set');
await page.reload();
await drawn();
check('…and the display stays hidden after a reload', !(await page.$(RANGE)));
await page.click(ICON);
check('the icon shows it again', await waitFor(has(RANGE)));

// Another glove session clears the range.
// Any session but this one: the picker's order follows activity, so its second entry may be this one.
const other = await page.$$eval('select[aria-label="Glove session"] option:not([disabled])', (os, pi) =>
  os.map((o) => o.value).find((v) => v && v !== pi), PI);
await page.selectOption('select[aria-label="Glove session"]', other).catch(() => {});
check('choosing another glove session clears the range', await waitFor(async () => url().searchParams.get('glove') !== PI && !url().searchParams.has('from')), page.url());

// A malformed range is not a range: All records, never a view left loading.
await page.goto(`${BASE}/?view=topology&glove=${PI}&from=garbage&to=now`);
check('a malformed range is ignored: All records', await drawn() && (await rangeText()).includes('All records'));

// A range with no glove session: the default is filled in, and the range kept.
await page.goto(`${BASE}/?view=network&${recent}`);
check('a range link with no glove session keeps its range once the default is chosen',
  await waitFor(async () => url().searchParams.has('glove') && url().searchParams.get('to') === 'now' && /→ now/.test(await rangeText()), 20000), page.url());

await finish();
