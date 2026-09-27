/**
 * Shared setup for the glove network views' browser checks. Everything a check
 * needs from its surroundings comes from here, so the checks run anywhere
 * `scripts/netobs-e2e.sh up` has prepared (see e2e/network/README.md).
 *
 *   LAYMAN_E2E_URL    the throwaway Layman (default http://localhost:8890); never the live :8880
 *   LAYMAN_E2E_DIR    its work dir: data/, glove/, shots/ (default /tmp/layman-netobs-e2e)
 *   LAYMAN_E2E_NAME   its container (default layman-netobs-e2e)
 *   CONTAINER_ENGINE  docker or podman (default docker)
 *   PLAYWRIGHT_CORE   path to a playwright-core package (the setup script installs one into the work dir)
 *   CHROME_PATH       a Chrome/Chromium binary (default: the macOS Google Chrome, else the `chrome` channel)
 */
import { createRequire } from 'module';
import { existsSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const BASE = process.env.LAYMAN_E2E_URL ?? 'http://localhost:8890';
export const WS_BASE = BASE.replace(/^http/, 'ws');
export const WORK = process.env.LAYMAN_E2E_DIR ?? '/tmp/layman-netobs-e2e';
export const GLOVE = join(WORK, 'glove');
export const DATA = join(WORK, 'data');
export const SHOTS = join(WORK, 'shots');
export const CONTAINER = process.env.LAYMAN_E2E_NAME ?? 'layman-netobs-e2e';
export const ENGINE = process.env.CONTAINER_ENGINE ?? 'docker';
mkdirSync(SHOTS, { recursive: true });

const pwPath = process.env.PLAYWRIGHT_CORE ?? join(WORK, 'pw/node_modules/playwright-core');
if (!existsSync(pwPath)) {
  console.error(`playwright-core not found at ${pwPath}: run scripts/netobs-e2e.sh up, or set PLAYWRIGHT_CORE`);
  process.exit(2);
}
export const { chromium } = createRequire(import.meta.url)(pwPath);

const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export function launch() {
  const executablePath = process.env.CHROME_PATH ?? (existsSync(MAC_CHROME) ? MAC_CHROME : undefined);
  return chromium.launch(executablePath ? { executablePath } : { channel: 'chrome' });
}

/** A request that leaves Layman: the views must never make one (the no-network rule). */
export const isForeign = (u) => !u.startsWith(BASE) && !u.startsWith(WS_BASE) && !u.startsWith('data:');

/**
 * A check's page and its bookkeeping. `check` records a result, `waitFor` polls a condition,
 * `has` is a condition for a selector. Page and console errors, and every request that leaves
 * Layman, are collected; `finish()` checks both, prints the tally, closes the browser and sets
 * the exit code.
 */
export async function startCheck({ viewport = { width: 1440, height: 900 } } = {}) {
  const results = [];
  const check = (name, ok, detail = '') => { results.push([ok ? 'PASS' : 'FAIL', name, String(detail).slice(0, 240)]); };
  const browser = await launch();
  const page = await browser.newPage({ viewport });
  const errors = [];
  const foreign = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('request', (r) => { const u = r.url(); if (isForeign(u)) foreign.push(u); });
  const waitFor = async (fn, ms = 10000) => {
    const t = Date.now();
    while (Date.now() - t < ms) { if (await fn()) return true; await page.waitForTimeout(250); }
    return false;
  };
  const has = (sel) => async () => (await page.$(sel)) !== null;
  const finish = async () => {
    check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
    check('every request went to Layman itself', foreign.length === 0, foreign.slice(0, 5).join(' '));
    await browser.close();
    for (const r of results) console.log(r.join('  '));
    console.log(`${results.filter((r) => r[0] === 'PASS').length}/${results.length} passed`);
    process.exitCode = results.every((r) => r[0] === 'PASS') ? 0 : 1;
  };
  return { page, check, waitFor, has, finish };
}

/** How far the page scrolls sideways; a view must fit, so anything over 0 is a failure. */
export const overflowX = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** Open Settings → Glove from the dashboard. */
export async function openGloveSettings(page) {
  await page.goto(`${BASE}/`);
  await page.waitForTimeout(800);
  await page.click('button:has-text("Settings")');
  await page.waitForTimeout(500);
  const tab = await page.$('text=/^Glove$/');
  if (tab) await tab.click().catch(() => {});
}
