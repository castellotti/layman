// glove network views browser check (control; was phase-4 check4). Run via scripts/netobs-e2e.sh.
import { BASE, GLOVE, SHOTS, REPO, startCheck, PI, sid } from './env.mjs';
import { readFileSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
const RULES = `${GLOVE}/control/${PI}/rules.json`;
const { page, check, waitFor, has, finish } = await startCheck();
const rulesText = () => page.$eval('section:has(h2:text-is("Rules"))', (s) => s.innerText);

// Start from the fixtures' rules (the fake glove home is ours; this stands in for the user's own edit).
const SCEN = `${REPO}/packages/server/src/netobs`;
const reset = (session, src) => {
  const text = readFileSync(src, 'utf8').replace(/"env": *"[^"]*"/, `"env": "${session}"`).replace(/"session": *"[^"]*"/, `"session": "${session}"`);
  writeFileSync(`${GLOVE}/control/${session}/rules.json`, text, { mode: 0o644 });
  return createHash('sha256').update(text).digest('hex');
};
/** The gate reports enforcing exactly this file. */
const gateEnforces = (session, sha) => waitFor(async () => {
  const r = (await (await fetch(`${BASE}/api/net/sessions/${session}/rules`)).json()).rules;
  return r.sha256 === sha && r.enforcement === 'enforced';
}, 15000);
const resets = { [PI]: reset(PI, `${SCEN}/__fixtures__/rules.json`), [sid('default-block')]: reset(sid('default-block'), `${SCEN}/__scenarios__/default-block/rules.json`) };
for (const [session, sha] of Object.entries(resets)) {
  check(`reset ${session} to its fixture rules`, await gateEnforces(session, sha));
}

await page.goto(`${BASE}/?view=network&glove=${PI}`);
await page.waitForSelector('[role=table][aria-label=Destinations] [role=row] >> nth=2', { timeout: 15000 });
await page.waitForTimeout(1500);

// 1. Block from a row
const t0 = await page.$('button[aria-label="Block wikipedia.org"]');
check('toggle is enabled', t0 && !(await t0.isDisabled()));
await t0.click();
await page.waitForSelector('[role=dialog][aria-label^="Rules for"]');
const pop = await page.$eval('[role=dialog][aria-label^="Rules for"]', (d) => d.innerText);
check('block popover: host, domain, IP choices and preview', /This host only/.test(pop) && /wikipedia\.org and every subdomain/.test(pop) && /This IP address/.test(pop) && /Shared CDN/.test(pop), pop.replace(/\n/g, ' | '));
await page.click('[role=dialog] label:has-text("and every subdomain")');
const preview = await page.$eval('[aria-label="Rule preview"]', (p) => p.innerText);
check('preview shows both domain rules', /"host": "wikipedia\.org"/.test(preview) && /"\*\.wikipedia\.org"/.test(preview), preview);
await page.fill('[role=dialog] input[aria-label=Note]', 'ui test');
await page.screenshot({ path: `${SHOTS}/p4-block-popover.png` });
await page.click('[role=dialog] button:has-text("Block")');
const pending = await waitFor(async () => /Waiting for the gate/.test(await rulesText()), 4000);
check('pending shown after writing', pending);
await page.screenshot({ path: `${SHOTS}/p4-pending.png` });
const enforced = await waitFor(has('button[aria-label="Unblock wikipedia.org"]'), 15000);
check('toggle turns to "your rule" once the gate confirms', enforced);
const onDisk = JSON.parse(readFileSync(RULES, 'utf8'));
check('file has the two rules on top, noted', onDisk.rules[0].match.host === 'wikipedia.org' && onDisk.rules[1].match.host === '*.wikipedia.org' && onDisk.rules[0].note === 'ui test' && onDisk.updated_by === 'layman', JSON.stringify(onDisk.rules.slice(0, 2)));

// 2. Unblock from the same row
await page.click('button[aria-label="Unblock wikipedia.org"]');
await page.waitForSelector('[role=dialog]');
const un = await page.$eval('[role=dialog]', (d) => d.innerText);
check('unblock popover names the rule pair', /Blocked by your rule “ui test”/.test(un) && /Remove the rule pair/.test(un), un.replace(/\n/g, ' | '));
await page.screenshot({ path: `${SHOTS}/p4-unblock.png` });
await page.click('[role=dialog] button:has-text("Unblock")');
check('unblocked once confirmed', await waitFor(has('button[aria-label="Block wikipedia.org"]:not([disabled])'), 15000));

// 3. Rules panel draft: add, save
await page.click('section:has(h2:text-is("Rules")) button:has-text("Add rule")');
await page.fill('input[aria-label="Match value"]', '*.doubleclick.net');
await page.fill('input[aria-label="Rule note"]', 'ads');
await page.click('button:has-text("Add to draft")');
check('added rule is marked unsaved', /UNSAVED/.test(await rulesText()));
await page.click('button:has-text("Save to gate")');
check('draft saved and enforced', await waitFor(async () => { const t = await rulesText(); return /\*\.doubleclick\.net/.test(t) && !/UNSAVED/.test(t) && /Enforced by the gate|Your change is in force/.test(t); }, 15000), (await rulesText()).slice(0, 200));

// 4. Kill switch
await page.click('button:has-text("Cut all traffic now")');
await page.waitForSelector('[role=alertdialog]');
const kd = await page.$eval('[role=alertdialog]', (d) => d.innerText);
check('kill switch dialog with keep-LLM checked', new RegExp(`Cut all traffic for ${PI}\\?`).test(kd) && (await page.$eval('[role=alertdialog] input[type=checkbox]', (c) => c.checked)), kd.replace(/\n/g, ' | '));
await page.screenshot({ path: `${SHOTS}/p4-killswitch.png` });
await page.click('[role=alertdialog] button:has-text("Cut all traffic")');
check('strip shows ALL TRAFFIC CUT', await waitFor(has('span:text-is("ALL TRAFFIC CUT")'), 8000));
const cutFile = JSON.parse(readFileSync(RULES, 'utf8'));
check('cut file: default block, LLM kept', cutFile.default === 'block' && cutFile.rules[0].match.service === 'llm', JSON.stringify(cutFile.rules.slice(0, 2)));
await page.waitForTimeout(6000);
await page.screenshot({ path: `${SHOTS}/p4-cut.png` });
const restoreBtn = await page.$('button:text-is("Restore")');
const restoreDisabled = restoreBtn ? await restoreBtn.isDisabled() : 'missing';
await restoreBtn?.click();
const restored = await waitFor(async () => !(await page.$('span:text-is("ALL TRAFFIC CUT")')) && JSON.parse(readFileSync(RULES, 'utf8')).default === 'allow', 10000);
const diag = restored ? '' : JSON.stringify({ restoreDisabled, file: JSON.parse(readFileSync(RULES, 'utf8')).default,
  chip: !!(await page.$('span:text-is("ALL TRAFFIC CUT")')), toasts: await page.$$eval('[role=alert]', (as) => as.map((a) => a.innerText)),
  write: (await (await fetch(`${BASE}/api/net/sessions/${PI}/rules`)).json()).rules.write });
check('restore clears the chip and the default', restored, diag);
await waitFor(async () => /Enforced by the gate|in force/.test(await rulesText()), 10000);

// 5. Someone else edits the file
const ext = JSON.parse(readFileSync(RULES, 'utf8'));
ext.rules.push({ id: 'r_CLIEDIT', action: 'block', match: { host: 'cli.example' } });
writeFileSync(RULES, JSON.stringify(ext, null, 2));
check('external change toast', await waitFor(has('text=rules.json changed outside Layman'), 8000));
await page.screenshot({ path: `${SHOTS}/p4-external.png` });
// Wait for the gate to confirm the outside edit, so "the enforced file" is that one.
const extSha = createHash('sha256').update(readFileSync(RULES)).digest('hex');
check('the gate confirms the outside edit', await gateEnforces(PI, extSha));

// 6. Break the file by hand: rejected banner on all four tabs; revert
const good = readFileSync(RULES, 'utf8');
writeFileSync(RULES, JSON.stringify({ ...JSON.parse(good), exec: 'rm -rf /' }));
const banner = await waitFor(has('[role=alert]:has-text("glove rejected rules.json")'), 12000);
check('rejected banner appears', banner);
check('a hand edit is not called "your change"', /changed outside Layman, and glove rejected it/.test(await page.$eval('[role=alert]:has-text("glove rejected rules.json")', (d) => d.innerText)));
const toggleStill = await page.$('button[aria-label="Unblock ads.tracker.example"], button[aria-label="Unblock tracker.example"]');
check('toggles still show what is enforced (the fixture rule)', toggleStill !== null);
check('panel labels the file not enforced', /IN RULES\.JSON · NOT ENFORCED/.test(await rulesText()));
await page.screenshot({ path: `${SHOTS}/p4-rejected.png` });
for (const v of ['map', 'topology', 'trace']) {
  await page.goto(`${BASE}/?view=${v}&glove=${PI}`);
  check(`banner on ${v}`, await waitFor(has('[role=alert]:has-text("glove rejected rules.json")'), 8000));
}
await page.goto(`${BASE}/?view=network&glove=${PI}`);
await waitFor(has('[role=alert]:has-text("glove rejected rules.json")'), 8000);
await page.click('button:has-text("Revert to enforced rules")');
check('revert restores the enforced file and clears the banner', await waitFor(async () => !(await page.$('[role=alert]:has-text("glove rejected rules.json")')), 15000));
check('reverted bytes equal the last good file', readFileSync(RULES, 'utf8') === good);

// 7. Default block session: allow from the row
await page.goto(`${BASE}/?view=network&glove=${sid('default-block')}`);
await page.waitForSelector('[role=table][aria-label=Destinations] [role=row] >> nth=1');
await page.waitForTimeout(1000);
const allowT = await page.$('button[aria-label="Allow arxiv.org"]');
check('default-blocked row has an outlined "Allow" toggle', allowT !== null);
if (allowT) {
  await allowT.click();
  const dp = await page.$eval('[role=dialog]', (d) => d.innerText);
  check('default popover offers Allow', /Blocked by the default/.test(dp) && /Allow arxiv\.org/.test(dp), dp.replace(/\n/g, ' | '));
  await page.click('[role=dialog] button:has-text("Allow arxiv.org")');
  check('allowed once confirmed', await waitFor(has('button[aria-label="Block arxiv.org"]'), 15000));
}

await finish();
