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

// A click dismisses: the focus it gives must not bring the tip back.
await page.click('span[data-tip-heading="Hostnames looked up in the tunnel"]');
await page.waitForTimeout(400);
check('a click dismisses a tip, and its focus does not bring it back', (await page.$(TIP)) === null);

// On keyboard focus too: Tab from the chip before.
await page.mouse.move(0, 0);
await page.focus('span[data-tip-heading="Hostnames looked up in the tunnel"]');
await page.keyboard.press('Tab');
check('keyboard focus shows a tip too', await waitFor(async () => (await page.$(TIP)) !== null, 2000));
await page.keyboard.press('Escape');

// A disabled control's reason reaches the keyboard: its wrapper is focusable and carries it.
await page.goto(`${BASE}/?view=network&glove=${PI}`);
await waitFor(async () => (await page.$$('[role=table] button[aria-pressed]')).length > 0, 8000);
const locked = await page.$$eval('[role=table] button[aria-pressed][disabled]', (bs) => bs.map((b) => {
  const w = b.closest('[data-tip]');
  return w && w !== b && w.getAttribute('tabindex') === '0' ? w.getAttribute('data-tip') : null;
}));
check('a disabled toggle’s reason is on a focusable wrapper', locked.length > 0 && locked.every(Boolean), locked.slice(0, 2).join(' | '));
await page.goto(`${BASE}/?view=topology&glove=${PI}`);
await waitFor(async () => (await page.$$(`${DIAG} g[data-node]`)).length > 10);

// The Topology legend and a band explain themselves.
await page.hover('span[data-tip-heading="SearXNG fan-out"]');
check('the Topology legend explains itself', await waitFor(async () => /several search engines/.test(await tipText()), 2000));
await page.mouse.move(0, 0);
await page.hover(`${DIAG} g[data-node^="dest:"]`);
check('a destination node has a tip', await waitFor(async () => (await page.$(TIP)) !== null, 2000));

check('no native title left in the network views', await page.$$eval('.net-view [title]', (s) => s.length) === 0);
await finish();
