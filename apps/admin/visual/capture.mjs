// Playwright capture for the visual-parity harness (FE-00).
//
//   node visual/capture.mjs            # capture every spec in manifest
//   node visual/capture.mjs 07 21      # capture only specs whose name contains 07 or 21
//
// The admin app keeps the session in React state only (no restore-from-token on boot), so a full
// page load of a protected route redirects to /login. We therefore log in ONCE per role via the form
// (landing on '/'), then navigate CLIENT-SIDE (history pushState + popstate, which React Router v6
// picks up) to each route — no reload, session stays alive. Full-page 1440px-wide PNGs land in
// visual/current/<name>.png. Requires dev servers live (admin :5173, backend :3000).

import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_URL, CREDS, SPECS, VIEWPORT_HEIGHT, VIEWPORT_WIDTH } from './manifest.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'current');
const NAV_TIMEOUT = 25_000;
const MAX_SHOT_HEIGHT = 30_000; // Chrome cannot capture past ~32767px; cap tall dashboards.

const filters = process.argv.slice(2);
const specs = filters.length ? SPECS.filter((s) => filters.some((f) => s.name.includes(f))) : SPECS;

async function login(page, role) {
  const { email, password } = CREDS[role];
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => !!sessionStorage.getItem('fsm.accessToken'), { timeout: NAV_TIMEOUT });
  await page.waitForFunction(() => window.location.pathname === '/', { timeout: NAV_TIMEOUT });
}

async function clientNavigate(page, route) {
  if (new URL(page.url()).pathname === route) return;
  await page.evaluate((to) => {
    window.history.pushState({}, '', to);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, route);
  await page.waitForFunction((to) => window.location.pathname === to, route, { timeout: NAV_TIMEOUT });
}

async function setActingZone(page, zone) {
  await page.fill('input[aria-label="Act as ZM for zone"]', String(zone));
  await page.getByRole('button', { name: 'Go', exact: true }).click();
  await page.waitForSelector('[role="status"]', { timeout: NAV_TIMEOUT });
}

async function settle(page) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(700); // charts/animations/font swap
}

async function shoot(page, name) {
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  const path = join(OUT, `${name}.png`);
  if (height > MAX_SHOT_HEIGHT) {
    // fullPage errors past Chrome's ~32767px limit and clip returns garbage — capture the top region
    // (header + KPIs + first rows, enough for parity) by growing the viewport instead.
    await page.setViewportSize({ width: VIEWPORT_WIDTH, height: 3200 });
    await page.waitForTimeout(250);
    await page.screenshot({ path, fullPage: false });
    await page.setViewportSize({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });
    console.log(`  ok  ${name}  (top 3200px of ${height}px)`);
  } else {
    await page.screenshot({ path, fullPage: true });
    console.log(`  ok  ${name}`);
  }
}

async function captureRole(browser, role, roleSpecs) {
  const context = await browser.newContext({
    viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT);
  const results = [];
  try {
    if (role) await login(page, role);
    // Non-acting specs first, then acting ones (acting mode persists on the session).
    const ordered = [...roleSpecs].sort((a, b) => (a.acting ? 1 : 0) - (b.acting ? 1 : 0));
    for (const spec of ordered) {
      try {
        if (role) {
          if (spec.acting) await setActingZone(page, spec.acting);
          await clientNavigate(page, spec.route);
        } else {
          await page.goto(`${BASE_URL}${spec.route}`, { waitUntil: 'domcontentloaded' });
        }
        await settle(page);
        if (spec.open === 'firstTicket') {
          await page.locator('table tbody tr').first().click();
          await page.waitForSelector('[aria-label="Ticket detail"]', { timeout: NAV_TIMEOUT });
          await settle(page);
        }
        await shoot(page, spec.name);
        results.push({ name: spec.name, ok: true });
      } catch (err) {
        console.log(`FAIL  ${spec.name}: ${err.message.split('\n')[0]}`);
        results.push({ name: spec.name, ok: false });
      }
    }
  } finally {
    await context.close();
  }
  return results;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const byRole = new Map();
  for (const s of specs) {
    const key = s.role ?? '__anon__';
    if (!byRole.has(key)) byRole.set(key, []);
    byRole.get(key).push(s);
  }

  const browser = await chromium.launch();
  const results = [];
  for (const [key, roleSpecs] of byRole) {
    results.push(...(await captureRole(browser, key === '__anon__' ? null : key, roleSpecs)));
  }
  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\ncaptured ${results.length - failed.length}/${results.length}`);
  if (failed.length) {
    console.log('failed:', failed.map((f) => f.name).join(', '));
    process.exitCode = 1;
  }
}

main();
