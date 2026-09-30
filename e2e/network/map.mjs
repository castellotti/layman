// glove network views browser check (map; was phase-5 check5). Run via scripts/netobs-e2e.sh.
import { BASE, SHOTS, openGloveSettings, overflowX, startCheck, PI, sid } from './env.mjs';
const { page, check, waitFor, finish } = await startCheck();
await page.goto(`${BASE}/?view=map&glove=${PI}`);
await page.evaluate(() => localStorage.clear()); // once: a reload must keep what the page saved
await page.reload();
check('land drawn from the bundled atlas', await waitFor(async () => (await page.$$eval('svg[aria-label^="Map of where"] path', (ps) => Math.max(...ps.map((p) => (p.getAttribute('d') ?? '').length)))) > 5000));
const pins = await page.$$('svg[aria-label^="Map of where"] g[data-pin]');
check('city pins drawn', pins.length >= 6, pins.length);
check('exit pinned and labelled', await page.$('span:has-text("Exit · Switzerland")') !== null);
check('untunnelled banner, with Block direct egress, no dismiss', await page.$('[role=alert]:has-text("Untunnelled traffic") button:has-text("Block direct egress")') !== null
  && await page.$('[role=alert]:has-text("Untunnelled traffic") button[aria-label^="Hide"]') === null);
const unk = await page.$eval('section[aria-label="Unknown location"]', (s) => s.innerText);
check('unknown location lists the unplaced host', /duckduckgo\.com/.test(unk), unk.replace(/\n/g, ' | '));
const legend = () => page.$eval('section[aria-label="Legend"]', (s) => s.innerText);
check('legend never claims "no database" before Layman answers', !/No geolocation database/.test(await legend()));
check('legend credits the database', await waitFor(async () => /IP geolocation: Layman-Demo-City/.test(await legend())));
check('sandbox card: local links and unwatched', /LLM · local/.test(await page.$eval('section[aria-label="This sandbox"]', (s) => s.innerText)) && /browser · not watched/.test(await page.$eval('section[aria-label="This sandbox"]', (s) => s.innerText)));

// Select from a pin
await page.click('g[data-pin]:has(title:text-matches("Amsterdam"))');
check('clicking a pin selects it (URL dest=)', await waitFor(async () => page.url().includes('dest=en.wikipedia.org')), page.url());
const detail = await page.$eval('section[aria-label="Details"]', (s) => s.innerText);
check('detail card: totals, asked-for, connection', /SENT/.test(detail) && /AGENT ASKED FOR/.test(detail) && /CONNECTION/.test(detail) && /resolved inside the tunnel/.test(detail) && /Amsterdam, NL/.test(detail), detail.replace(/\n/g, ' | ').slice(0, 200));
check('detail card: policy with block buttons', /POLICY/.test(detail) && /Block this host/.test(detail));
// Section menu: show Flows, and it is remembered
await page.click('section[aria-label="Details"] button[aria-label="Choose sections"]');
await page.click('label[role=menuitemcheckbox]:has-text("Flows")');
check('Flows section on', /FLOWS ·/.test(await page.$eval('section[aria-label="Details"]', (s) => s.innerText)));
await page.reload();
await page.waitForSelector('section[aria-label="Details"]');
check('section choice remembered', /FLOWS ·/.test(await page.$eval('section[aria-label="Details"]', (s) => s.innerText)));

// Drag the legend to the top-left corner
const grip = await page.$('section[aria-label="Legend"] [aria-label^="Move Legend"]');
const gb = await grip.boundingBox();
await page.mouse.move(gb.x + 4, gb.y + 4);
await page.mouse.down();
await page.mouse.move(200, 300, { steps: 5 });
await page.mouse.up();
await page.waitForTimeout(300);
const lb = await (await page.$('section[aria-label="Legend"]')).boundingBox();
check('card dragged to another corner', lb.x < 400 && lb.y < 500, JSON.stringify(lb));
await page.reload();
await page.waitForSelector('section[aria-label="Legend"]');
const lb2 = await (await page.$('section[aria-label="Legend"]')).boundingBox();
check('corner remembered', lb2.x < 400 && lb2.y < 500);

// Hide a card from the Panels chips
await page.click('button[aria-pressed]:has-text("Talking now")');
check('card hidden from its chip', await page.$('section[aria-label="Talking now"]') === null);
await page.click('button[aria-pressed]:has-text("Talking now")');

// Zoom
const tr0 = await page.$eval('svg[aria-label^="Map of where"] > g', (g) => g.getAttribute('transform'));
await page.click('button[aria-label="Zoom in"]');
const tr1 = await page.$eval('svg[aria-label^="Map of where"] > g', (g) => g.getAttribute('transform'));
check('zoom in changes the view', tr0 !== tr1, `${tr0} → ${tr1}`);
const reset = await page.$('button[aria-label="Reset view"]'); check('reset appears once zoomed', reset !== null); if (reset) await reset.click();

// Reduced motion
await page.emulateMedia({ reducedMotion: 'reduce' });
const anim = await page.$$eval('.net-live-dash', (els) => els.map((e) => getComputedStyle(e).animationName));
check('reduced motion stops the moving dash', anim.length > 0 && anim.every((a) => a === 'none'), JSON.stringify(anim.slice(0, 3)));
await page.emulateMedia({ reducedMotion: 'no-preference' });
await page.screenshot({ path: `${SHOTS}/p5-map-final.png` });

// Network tab: live mini map, Details and Activity panels
await page.goto(`${BASE}/?view=network&glove=${PI}&dest=arxiv.org`);
await page.waitForSelector('[role=table][aria-label=Destinations] [role=row] >> nth=2');
check('mini map is the live renderer', await waitFor(async () => (await page.$$('[aria-label="Open the Map tab"] g[data-pin]')).length >= 6));
await page.click('button[aria-pressed]:has-text("Details")');
await page.click('button[aria-pressed]:has-text("Activity")');
await page.waitForTimeout(800);
const dp = await page.$eval('section:has(h2:text-is("Details"))', (s) => s.innerText);
check('Details panel docks the card for the selection', /arxiv\.org/.test(dp) && /CONNECTION/.test(dp), dp.slice(0, 120));
check('Activity chart draws, windows switch', await page.$('svg[aria-label^="Received"]') !== null);
await page.click('[role=group][aria-label=Window] button:has-text("Session")');
await page.waitForTimeout(800);
check('Session window loads from the API', await page.$('[role=group][aria-label=Window] button[aria-pressed=true]:has-text("Session")') !== null);
await page.screenshot({ path: `${SHOTS}/p5-network-panels.png` });
await page.click('[aria-label="Open the Map tab"]');
check('mini map opens the Map, keeping the selection', await waitFor(async () => page.url().includes('view=map') && page.url().includes('dest=arxiv.org')), page.url());

// Settings shows the database
await openGloveSettings(page);
const settingsText = await page.evaluate(() => document.body.innerText);
check('Settings shows the loaded database', await waitFor(async () => /Loaded Layman-Demo-City/.test(await page.evaluate(() => document.body.innerText)), 6000), settingsText.match(/Geolocation database[\s\S]{0,160}/)?.[0]);

// 1280×800
await page.setViewportSize({ width: 1280, height: 800 });
await page.goto(`${BASE}/?view=map&glove=${PI}`);
await page.waitForTimeout(2500);
const overflow = await overflowX(page);
check('no horizontal page scroll at 1280×800', overflow <= 0, overflow);
await page.screenshot({ path: `${SHOTS}/p5-map-1280.png` });

// finish() also checks every request went to Layman itself: no lookups, no tiles, no fonts from elsewhere.
await finish();
