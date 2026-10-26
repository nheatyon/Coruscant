import { chooseDemonstrationCatalog } from './helpers.js';
import { test, expect, type Page } from '@playwright/test';
import type { Context, PublicCatalog } from '../../shared/contracts.js';
import { prepareDiscovery, submitSavedPlanning } from './helpers.js';

const question = 'Compare possible surface-water expansion after heavy rainfall within this selected fictional estuary area.';
test.beforeAll(async ({ request }) => {
  const root = await request.get('/');
  expect(root.status()).toBe(200);
  const html = await root.text();
  expect(html).toContain('<div id="root">');
  const script = html.match(/src="(\/assets\/[^" ]+\.js)"/);
  expect(script, 'the actual built page names its emitted module').not.toBeNull();
  expect((await request.get(script![1]!)).status()).toBe(200);
  const font = await request.get('/fonts/IBMPlexSans-Variable.ttf');
  expect(font.status()).toBe(200);
  expect((await font.body()).length).toBeGreaterThan(100_000);
});
async function prepare(page: Page, suffix = '') {
  await page.goto('/'); await chooseDemonstrationCatalog(page);
  await prepareDiscovery(page, `${question}${suffix}`);
  await expect(page.getByRole('button', { name: 'Open Estuary SAR 03', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open Wide SAR 20', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open Coast Visible', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open Survey Candidate', exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Documented criteria only', exact: true }).check();
  const review = page.getByRole('button', { name: 'Use reviewed filters', exact: true });
  if (await review.isVisible()) await review.click();
  await expect(page.getByRole('button', { name: 'Open Survey Candidate', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Add Estuary SAR 03 to shortlist', exact: true }).click();
  if (!suffix) await page.screenshot({ path: test.info().outputPath('desktop-discovery.png'), fullPage: false });
  await page.getByRole('button', { name: /Review this mission/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Your request', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('radio', { name: 'Baseline–recent comparison', exact: true }).check();
  await expect(dialog.getByLabel('Baseline reference date', { exact: true })).toHaveValue('');
  await expect(dialog.getByLabel('Recent reference date', { exact: true })).toHaveValue('');
  await dialog.getByLabel('Centre latitude', { exact: true }).fill('52.6');
  await dialog.getByLabel('Centre longitude', { exact: true }).fill('-9.7');
  await dialog.getByLabel('Radius (km)', { exact: true }).fill('25');
  await dialog.getByRole('button', { name: 'Use these coordinates', exact: true }).click();
  await dialog.getByRole('checkbox', { name: 'I chose this target and checked the area size.', exact: true }).check();
  const catalog = await (await page.request.get('/api/public/catalog')).json() as PublicCatalog;
  await dialog.getByLabel('Baseline reference date', { exact: true }).fill(catalog.demo.baselineDate);
  await dialog.getByLabel('Recent reference date', { exact: true }).fill(catalog.demo.recentDate);
  await dialog.getByLabel('Contact name', { exact: true }).fill('Demonstration contact');
  await dialog.getByLabel('Contact email', { exact: true }).fill('researcher@estuary.example');
  await dialog.getByLabel('Organisation name', { exact: true }).fill('Demonstration research team');
  if (!suffix) await page.screenshot({ path: test.info().outputPath('desktop-brief.png'), fullPage: false });
  const changedReview = dialog.getByRole('button', { name: 'Use reviewed filters', exact: true });
  if (await changedReview.isVisible()) await changedReview.click();
  await dialog.getByRole('button', { name: 'Review request', exact: true }).click();
  return { catalog, dialog };
}
async function accessFromHandoff(page: Page, persona: string) {
  await page.getByRole('link', { name: 'Open customer workspace', exact: true }).click();
  await page.getByRole('combobox', { name: 'Demonstration customer', exact: true }).selectOption(persona);
  await page.getByRole('button', { name: 'Continue to workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Review request in this workspace', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Save your planning request', exact: true })).toBeVisible();
}
async function chooseCustomer(page: Page, persona: string) {
  await page.goto('/access');
  await page.getByRole('combobox', { name: 'Demonstration customer', exact: true }).selectOption(persona);
  await page.getByRole('button', { name: 'Continue to workspace', exact: true }).click();
}
async function readyToSubmit(page: Page) {
  await page.getByRole('checkbox', { name: 'I confirm this planning brief and destination. This does not request staff review.', exact: true }).check();
  const submit = page.getByRole('button', { name: 'Save planning request', exact: true });
  await expect(submit).toBeEnabled();
  return submit;
}

test('manual evidence → brief → explicit workspace → durable request → separate staff @slice-01', async ({ page }) => {
  const { catalog } = await prepare(page);
  await accessFromHandoff(page, 'a-owner');
  await expect(page.getByText('Demo Estuary Research', { exact: true }).first()).toBeVisible();
  const before = await (await page.request.get('/api/customer/org-a/requests')).json();
  const submit = await readyToSubmit(page);
  // Checking the review/entering access creates no request.
  const reviewed = await (await page.request.get('/api/customer/org-a/requests')).json();
  expect(reviewed.total).toBe(before.total);
  await submit.click();
  await expect(page.getByRole('heading', { name: 'Request saved', exact: true })).toBeVisible();
  const receipt = page.locator('.receipt-reference');
  await expect(receipt).toHaveText(/^SRS-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
  const reference = await receipt.textContent();
  await page.getByRole('link', { name: 'Open request in Demo Estuary Research', exact: true }).click();
  await submitSavedPlanning(page);
  await expect(page.getByRole('heading', { name: question, exact: true })).toBeVisible();
  await expect(page.getByText(reference!, { exact: true }).first()).toBeVisible();
  await page.getByText('Submitted brief and evidence · Revision 1', { exact: true }).click();
  await expect(page.getByText(`${catalog.demo.baselineDate} · UTC`, { exact: true })).toBeVisible();
  const detailUrl = page.url();
  await page.reload();
  await expect(page.getByRole('heading', { name: question, exact: true })).toBeVisible();
  // A full-document Back must not uncover the old private detail while access is unknown.
  await page.goto('/about/data');
  const active = await (await page.request.get('/api/context')).json() as Context;
  const exited = await page.request.post('/api/demo/leave', {
    headers: { Origin: new URL(page.url()).origin, 'X-Coruscant-CSRF': active.csrfToken! },
    data: { contextGeneration: active.contextGeneration, contextToken: active.contextToken },
  });
  expect(exited.status()).toBe(200);
  let releaseContext!: () => void;
  const contextGate = new Promise<void>(resolve => { releaseContext = resolve; });
  await page.route('**/api/context', async route => { await contextGate; await route.continue(); });
  try {
    await page.goBack({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Checking current access…', exact: true })).toBeVisible();
    await expect(page.getByText(question, { exact: true })).toHaveCount(0);
    await expect(page.getByText('researcher@estuary.example', { exact: true })).toHaveCount(0);
  } finally { releaseContext(); }
  await expect(page.getByRole('heading', { name: 'Demonstration access', exact: true })).toBeVisible();
  await page.unroute('**/api/context');
  await chooseCustomer(page, 'a-owner');
  await expect(page.getByRole('heading', { name: 'Requests', exact: true })).toBeVisible();
  await page.goto(detailUrl);
  await expect(page.getByRole('heading', { name: question, exact: true })).toBeVisible();
  await page.goto('/staff/login');
  await page.getByRole('button', { name: 'Enter demonstration staff access', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Mission requests', exact: true })).toBeVisible();
  await page.getByRole('link').filter({ hasText: reference! }).first().click();
  await expect(page.getByRole('heading', { name: question, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Leave demonstration staff access', exact: true }).click();
  await chooseCustomer(page, 'b-owner');
  await expect(page.getByRole('heading', { name: 'Requests', exact: true })).toBeVisible();
  await page.goto(detailUrl);
  await expect(page.getByRole('heading', { name: 'This item is unavailable in your current workspace', exact: true })).toBeVisible();
  await expect(page.getByText(question, { exact: true })).toHaveCount(0);
  const denied = await page.request.get(new URL(detailUrl).pathname.replace('/workspaces/org-a/service-requests/', '/api/customer/org-a/requests/'));
  expect(denied.status()).toBe(404);
  expect(await denied.text()).not.toContain(question);
  await page.goto('/'); await chooseDemonstrationCatalog(page);
  await expect(page.getByLabel('Search satellites and services')).toHaveValue('');
});

test('uncertain browser submission reuses its saved attempt and returns one record @slice-01', async ({ page }, info) => {
  const suffix = ` Browser response-loss example (${info.project.name}).`;
  await prepare(page, suffix); await accessFromHandoff(page, 'a-requester');
  const submit = await readyToSubmit(page);
  let intercepted = false;
  await page.route('**/api/commands/savePlanningRequest', async route => {
    if (intercepted) { await route.continue(); return; }
    intercepted = true;
    const response = await route.fetch(); expect(response.status()).toBe(201);
    await route.abort('failed');
  });
  await submit.click();
  await expect(page.getByText('Planning save outcome uncertain', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Retry same planning save', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Request saved', exact: true })).toBeVisible();
  const list = await (await page.request.get('/api/customer/org-a/requests')).json();
  expect(list.requests.filter((r: { brief: { purpose: string } }) => r.brief.purpose === question + suffix)).toHaveLength(1);
});

test('Viewer handoff refuses submission; multi and zero choices are actual memberships @slice-01', async ({ page }) => {
  await prepare(page, ' Read-only example.'); await accessFromHandoff(page, 'a-viewer');
  await expect(page.getByText('Your workspace role is read-only. An Owner or Requester can save or submit this brief.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save planning request', exact: true })).toHaveCount(0);
  await chooseCustomer(page, 'multi-viewer');
  await expect(page.getByRole('heading', { name: 'Choose workspace', exact: true })).toBeVisible();
  await expect(page.locator('.workspace-row')).toHaveCount(2);
  await chooseCustomer(page, 'no-workspace');
  await expect(page.getByRole('heading', { name: 'No workspace access is configured', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /View shared requests|Review request in this workspace/ })).toHaveCount(0);
});

test('390px brief keeps intent/errors, modal focus and the actual console font @slice-01', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/'); await chooseDemonstrationCatalog(page);
  await prepareDiscovery(page, question);
  await page.getByRole('button', { name: /Review this mission/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Your request', exact: true });
  await dialog.getByRole('button', { name: 'Review request', exact: true }).click();
  await expect(dialog.locator('#error-areaChoice')).toHaveText('Choose your target deliberately with Use these coordinates, then check its size.');
  await dialog.getByRole('radio', { name: 'Baseline–recent comparison', exact: true }).check();
  await expect(dialog.getByLabel('Baseline reference date', { exact: true })).toHaveValue('');
  await dialog.getByLabel('Centre latitude', { exact: true }).fill('0');
  await dialog.getByLabel('Centre longitude', { exact: true }).fill('0');
  await dialog.getByRole('button', { name: 'Use these coordinates', exact: true }).click();
  await dialog.getByRole('checkbox', { name: 'I chose this target and checked the area size.', exact: true }).check();
  await dialog.getByLabel('Radius (km)', { exact: true }).fill('30');
  await expect(dialog.getByRole('checkbox', { name: 'I chose this target and checked the area size.', exact: true })).toBeChecked();
  await expect(dialog.getByText('UNAPPLIED AREA PROPOSAL', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Use these coordinates', exact: true }).click();
  await expect(dialog.getByRole('checkbox', { name: 'I chose this target and checked the area size.', exact: true })).not.toBeChecked();
  await expect(page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).resolves.toBe(true);
  await page.keyboard.press('Tab');
  expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Review this mission/ })).toBeFocused();
  await page.getByRole('button', { name: /Review this mission/ }).click();
  await expect(dialog.getByLabel('Radius (km)', { exact: true })).toHaveValue('30');
  expect(await page.evaluate(async () => { await document.fonts.ready; return document.fonts.check('450 34px "IBM Plex Sans"'); })).toBe(true);
  await page.screenshot({ path: test.info().outputPath('mobile-brief.png'), fullPage: false });
});
