// glove network views browser check: tooltips (NetTipHost). Run via scripts/netobs-e2e.sh, last:
// the trace check samples a looping replay, so a slower check before it changes what it sees.
import { BASE, SHOTS, startCheck, PI } from './env.mjs';
const { page, check, waitFor, finish } = await startCheck();
const DIAG = 'svg[aria-label^="Routes from"]';
const TIP = '[role="tooltip"]';
const tipText = () => page.$eval(TIP, (t) => t.textContent).catch(() => '');

await page.goto(`${BASE}/?view=topology&glove=${PI}`);
await waitFor(async () => (await page.$$(`${DIAG} g[data-node]`)).length > 10);

// On hover almost at once, in plain words, gone on Escape.
await page.hover('span[data-tip-heading="Hostnames looked up in the tunnel"]');
check('hovering a gate chip shows its tip', await waitFor(async () => (await page.$(TIP)) !== null, 2000));
check('…in plain words', /your own DNS provider never sees/.test(await tipText()), await tipText());
await page.screenshot({ path: `${SHOTS}/tip-resolver.png` });
await page.keyboard.press('Escape');
check('Escape hides it', await waitFor(async () => (await page.$(TIP)) === null, 2000));

// On keyboard focus too.
await page.mouse.move(0, 0);
await page.focus('span[data-tip-heading="No rules"], span[data-tip-heading$="in force"]');
check('keyboard focus shows a tip too', await waitFor(async () => (await page.$(TIP)) !== null, 2000));

// The Topology legend and a band explain themselves.
await page.hover('span[data-tip-heading="SearXNG fan-out"]');
check('the Topology legend explains itself', await waitFor(async () => /several search engines/.test(await tipText()), 2000));
await page.mouse.move(0, 0);
await page.hover(`${DIAG} g[data-node^="dest:"]`);
check('a destination node has a tip', await waitFor(async () => (await page.$(TIP)) !== null, 2000));

check('no native title left in the network views', await page.$$eval('.net-view [title]', (s) => s.length) === 0);
await finish();
