import { test, expect, type Page } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import type { StaffMaterialRequestProjection, CustomerResultProjection } from '../../shared/material.js';
import { enterCustomer, enterStaff, scheduledRequest } from './helpers.js';
import { answer, staffDetail, prepareResult, approveAndPublishImages, publishFinding, grant, expectLinked } from './material-helpers.js';

test.setTimeout(120_000);
test('same mission → explicitly reviewed published pair/finding → separate access → SatSuite comparison @slice-03', async ({ page }, info) => {
  const mission = await scheduledRequest(page, `Inspect a reviewed synthetic estuary comparison (${info.project.name}).`);
  const title = `Reviewed estuary comparison (${info.project.name})`;
  const resultId = await prepareResult(page, mission.id, title);
  let releaseRefresh!: () => void; let sawRefresh!: () => void;
  const refreshGate = new Promise<void>(resolve => { releaseRefresh = resolve; });
  const refreshHeld = new Promise<void>(resolve => { sawRefresh = resolve; });
  const detailRoute = `**/api/staff/requests/${mission.id}`;
  await page.route(detailRoute, async route => {
    const response = await route.fetch();
    const projection = await response.json() as StaffMaterialRequestProjection;
    if (projection.result?.images.some(image => image.role === 'RECENT' && image.state === 'PUBLISHED')) {
      sawRefresh(); await refreshGate;
    }
    try { await route.fulfill({ response }); } catch { /* A covered prior read may be aborted. */ }
  });
  try {
    await approveAndPublishImages(page, mission.id);
    await refreshHeld;
    await publishFinding(page, mission.id, false, async () => {
      releaseRefresh();
      await expect(page.getByText(/2 of\s*2 images published/)).toBeVisible();
    });
  } finally { releaseRefresh(); await page.unroute(detailRoute); }
  // Publication alone exposes neither customer result metadata nor protected bytes.
  const staff = (await staffDetail(page, mission.id)).result!;
  await enterCustomer(page);
  expect((await page.request.get(`/api/customer/org-a/results/${resultId}`)).status()).toBe(404);
  expect((await page.request.get(staff.images[0]!.publishedVersion!.previewUrl)).status()).toBe(404);
  await enterStaff(page); await page.goto(`/staff/requests/${mission.id}`);
  await grant(page, mission.id);
  expect((await staffDetail(page, mission.id)).status).toBe('Scheduled');
  await enterCustomer(page); await page.goto(`/workspaces/org-a/missions/${mission.id}`);
  await page.getByRole('link', { name: title, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/workspaces/org-a/results/${resultId}$`));
  await expect(page.getByRole('heading', { name: title, level: 1, exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Staff finding', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText(answer, { exact: true })).toBeVisible();
  await expect(page.getByText('Uncertainty and limitations', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Not collected — synthetic demonstration', { exact: true }).first()).toBeVisible();
  const response = await page.request.get(`/api/customer/org-a/results/${resultId}`);
  const result = await response.json() as CustomerResultProjection;
  expect(result.dateComparison.status).toBe('ALIGNED');
  expect(result.acceptedContext.baselineReferenceDate).toBe(mission.catalog.demo.baselineDate);
  expect(result.images).toHaveLength(2);
  await page.getByRole('combobox', { name: 'Compare with', exact: true }).selectOption(`${result.images[1]!.assetId}:${result.images[1]!.contentVersion}`);
  await page.getByRole('checkbox', { name: 'Link navigation', exact: true }).check();
  await expect(page.getByText(/not registration|not georegistration/i).first()).toBeVisible();
  await page.getByRole('button', { name: 'Zoom in', exact: true }).first().click();
  await expect(page.locator('.zoom-readout').first()).toHaveText('125%');
  await expectLinked(page);
  const viewer = page.getByRole('region', { name: 'Baseline image viewer', exact: true });
  const beforePan = await viewer.locator('img').getAttribute('style');
  await viewer.focus(); await viewer.press('ArrowRight');
  await expect.poll(() => viewer.locator('img').getAttribute('style')).not.toBe(beforePan);
  await expectLinked(page);
  await page.locator('.rail-image[aria-pressed="true"]').click();
  await expectLinked(page);
  await page.getByRole('button', { name: 'Fit', exact: true }).first().click();
  await expect(page.locator('.zoom-readout').first()).toHaveText('100%');
  await expectLinked(page);
  await page.getByRole('button', { name: /\[2\].*Recent/ }).click();
  await expect(page.locator('.cited-stage').getByRole('heading', { name: /Recent/ })).toBeVisible();
  for (const width of [1440, 1280, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByText(answer, { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath(`comparison-${width}.png`) });
  }
  await page.reload();
  await expect(page.getByText(answer, { exact: true })).toBeVisible();
  const testRoot = info.config.metadata.dataRoot as string;
  expect(testRoot).toContain('coruscant-e2e-');
  const testDatabase = new DatabaseSync(join(testRoot, 'coruscant.sqlite'));
  try {
    testDatabase.exec('PRAGMA busy_timeout=1000');
    testDatabase.prepare('UPDATE result_entitlements SET active=0 WHERE result_id=?').run(resultId);
    // Exercise the actual visible item check, not a cosmetic browser role change.
    await expect(page.getByText(answer, { exact: true })).toHaveCount(0, { timeout: 20_000 });
    await expect(page.locator('img[src^="blob:"]')).toHaveCount(0);
  } finally {
    testDatabase.prepare('UPDATE result_entitlements SET active=1 WHERE result_id=?').run(resultId);
    testDatabase.close();
  }
  await page.goto(`/workspaces/org-a/results/${resultId}`);
  await expect(page.getByText(answer, { exact: true })).toBeVisible();
  // The server has already permitted and returned these bytes. The browser must still
  // discard them if its original customer context is left before the fetch settles.
  let release!: () => void; let received!: () => void; let held = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const bytesReceived = new Promise<void>(resolve => { received = resolve; });
  await page.route('**/api/material/**/preview', async route => {
    if (held) { await route.continue(); return; }
    held = true;
    const permittedBytes = await route.fetch();
    expect(permittedBytes.status()).toBe(200);
    received(); await gate;
    try { await route.fulfill({ response: permittedBytes }); } catch { /* An aborted old-context fetch is an allowed safe result. */ }
  });
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await bytesReceived;
    await page.getByRole('button', { name: 'Leave demonstration access', exact: true }).click();
  } finally { release(); }
  await expect(page.getByText(title, { exact: true })).toHaveCount(0);
  await expect(page.locator('img[src^="blob:"]')).toHaveCount(0);
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Demonstration access', exact: true })).toBeVisible();
  await expect(page.getByText(answer, { exact: true })).toHaveCount(0);
  await page.unroute('**/api/material/**/preview');
  await enterCustomer(page, 'b-owner');
  await page.goto(`/workspaces/org-a/results/${resultId}`);
  await expect(page.getByRole('heading', { name: 'This item is unavailable in your current workspace', exact: true })).toBeVisible();
  await expect(page.getByText(title, { exact: true })).toHaveCount(0);
  for (const image of result.images) {
    expect((await page.request.get(image.previewUrl)).status()).toBe(404);
    expect((await page.request.get(image.thumbnailUrl)).status()).toBe(404);
  }
});

test('entitlement exposes no draft; disclosed mismatched material can publish without changing accepted work @slice-03', async ({ page }, info) => {
  const mission = await scheduledRequest(page, `Inspect explicit synthetic date discrepancy (${info.project.name}).`, true);
  const title = `Mismatched illustrative dates (${info.project.name})`;
  const resultId = await prepareResult(page, mission.id, title);
  const before = (await staffDetail(page, mission.id)).acceptedQuote;
  await grant(page, mission.id);
  await enterCustomer(page);
  expect((await page.request.get(`/api/customer/org-a/results/${resultId}`)).status()).toBe(404);
  await page.goto('/workspaces/org-a/results');
  await expect(page.getByRole('heading', { name: 'Results', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: title, exact: true })).toHaveCount(0);
  const permittedLibrary = await (await page.request.get('/api/customer/org-a/results')).json();
  expect(permittedLibrary.results.some((item: { id: string }) => item.id === resultId)).toBe(false);
  await enterStaff(page); await page.goto(`/staff/requests/${mission.id}`);
  await approveAndPublishImages(page, mission.id);
  await publishFinding(page, mission.id, true);
  const after = await staffDetail(page, mission.id);
  expect(after.acceptedQuote).toEqual(before);
  expect(after.result!.dateComparison.status).toBe('DIFFERENT');
  expect(after.status).toBe('Scheduled');
  await enterCustomer(page); await page.goto(`/workspaces/org-a/results/${resultId}`);
  await expect(page.getByText('Requested comparison dates differ from supplied illustrative dates', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/This sample does not fulfill that requested date/)).toBeVisible();
  await enterStaff(page); await page.goto(`/staff/requests/${mission.id}`);
  await page.getByRole('button', { name: 'Withdraw', exact: true }).click();
  const withdrawal = page.getByRole('dialog', { name: 'Withdraw finding', exact: true });
  await withdrawal.getByLabel('Withdrawal reason', { exact: true }).fill('Withdraw this test finding while preserving the reviewed history and separately published synthetic pair.');
  await withdrawal.getByRole('button', { name: 'Confirm withdrawal', exact: true }).click();
  await expect(withdrawal).toHaveCount(0);
  await expect.poll(async () => (await staffDetail(page, mission.id)).result?.finding?.state).toBe('WITHDRAWN');
  await enterCustomer(page); await page.goto(`/workspaces/org-a/results/${resultId}`);
  await expect(page.getByText(answer, { exact: true })).toHaveCount(0);
  const withdrawn = await (await page.request.get(`/api/customer/org-a/results/${resultId}`)).json() as CustomerResultProjection;
  expect(withdrawn.finding).toBeNull(); expect(withdrawn.images).toHaveLength(2);
  await page.reload();
  await expect(page.getByRole('region', { name: 'Baseline image viewer', exact: true })).toBeVisible();
  await expect(page.getByText(answer, { exact: true })).toHaveCount(0);
});
