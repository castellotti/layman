// glove network views browser check (ip-setting; was phase-9 check9). Run via scripts/netobs-e2e.sh.
import { BASE, SHOTS, openGloveSettings, startCheck } from './env.mjs';
// Phase-9 follow-up: glove.showIpAddresses. Turn it on in Settings, wait for a new replay pass,
// and require the cloud-metadata fetch to keep its IP and join the guard refusal in Trace.
const { page, check, finish } = await startCheck();
const cfg = async () => (await (await fetch(`${BASE}/api/config`)).json());
const TOGGLE = 'xpath=//span[text()="Show IP addresses in sandboxed sessions"]/ancestor::div[1]//button';
await openGloveSettings(page);
await page.waitForTimeout(500);
const row = page.locator(TOGGLE);
check('Settings shows the toggle under Glove', await row.count() > 0);
const before = (await cfg()).glove?.showIpAddresses;
if (before) { await row.click(); await page.waitForTimeout(800); }
check('off by default (or reset to off)', (await cfg()).glove?.showIpAddresses === false);
await row.click(); await page.waitForTimeout(800);
check('turned on from Settings', (await cfg()).glove?.showIpAddresses === true);
await page.screenshot({ path: `${SHOTS}/p9-ip-toggle.png` });
// Wait for a pass recorded after the change, then look at its trace.
const since = Date.now();
let hit = null;
for (let i = 0; i < 60 && !hit; i++) {
  await page.waitForTimeout(3000);
  const t = await (await fetch(`${BASE}/api/net/sessions/pi-search/trace`)).json();
  if (!t.turn || t.turn.startedAt < since) continue;
  const it = t.items.find((x) => x.kind === 'call' && /169\.254\.169\.254|\[REDACTED/.test(x.call.label));
  if (it) hit = { it, t };
}
check('a pass recorded after the change reached Trace', !!hit);
if (hit) {
  const { it, t } = hit;
  const f = t.flows.find((x) => it.flowIds.includes(x.id));
  check('the metadata fetch keeps its IP', it.call.label.startsWith('http://169.254.169.254/') && !it.call.redacted, it.call.label);
  check('and joins the guard refusal', f?.state === 'guard', JSON.stringify(f?.state));
  await page.goto(`${BASE}/?view=trace&glove=pi-search`);
  // A large database can take a few seconds to build the trace: wait for the turn bar.
  const body = () => page.evaluate(() => document.body.innerText);
  const turnLabel = async () => (await body()).match(/TURN (\d+) OF (\d+)/);
  for (let i = 0; i < 40 && !(await turnLabel()); i++) await page.waitForTimeout(500);
  // The replay may have started a newer pass, whose calls arrive at its end: step back to the checked turn.
  const want = t.nav.index + 1;
  for (let i = 0; i < 10; i++) {
    const m = await turnLabel();
    if (!m || Number(m[1]) <= want) break;
    await page.click('button[aria-label="Previous turn"]');
    for (let j = 0; j < 20 && (await turnLabel())?.[1] === m[1]; j++) await page.waitForTimeout(500);
  }
  await page.waitForTimeout(800);
  const txt = await body();
  check('the waterfall shows it under its call', /169\.254\.169\.254\/latest/.test(txt) && !/host redacted/.test(txt.split('Unattributed')[0]));
  await page.screenshot({ path: `${SHOTS}/p9-ip-trace.png` });
}
// Leave it as found.
await openGloveSettings(page);
await page.locator(TOGGLE).click(); await page.waitForTimeout(800);
check('turned back off', (await cfg()).glove?.showIpAddresses === false);
await finish();
