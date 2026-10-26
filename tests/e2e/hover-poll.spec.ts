import { test, expect, type Locator, type Page } from '@playwright/test';
import type { Context } from '../../shared/contracts.js';
import { prepareDiscovery } from './helpers.js';

test.setTimeout(120_000);
type Mode = 'DEMONSTRATION' | 'REAL';
const frames = (canvas: Locator) => canvas.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

async function ready(stage: Locator) {
  const canvas = stage.locator('canvas');
  await expect(canvas).toHaveAttribute('data-texture', 'ready');
  await expect(stage.getByRole('button', { name: 'Reset view', exact: true })).toBeEnabled();
  await expect(stage.locator('.globe-drawing-status')).not.toContainText('Calculating');
  await expect(canvas).toHaveAttribute('data-drawable-ids', /\S/);
  return canvas;
}

async function preparedGlobe(page: Page, mode: Mode) {
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install(); await page.goto('/');
  // Finish initial public ensure/bootstrap before choosing the test's layer.
  await ready(page.getByRole('region', { name: 'Real orbital prediction', exact: true }));
  if (mode === 'DEMONSTRATION') await prepareDiscovery(page, 'SAR imagery with maximum ground resolution 10 m.');
  else {
    await page.getByLabel('Search satellites and services', { exact: true }).fill('SAR imagery with maximum ground resolution 10 m.');
    await page.getByRole('button', { name: 'Search catalog only', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Search catalog only', exact: true })).toBeEnabled();
  }
  await page.getByRole('button', { name: /Review this mission/ }).click();
  const brief = page.getByRole('dialog', { name: 'Your request', exact: true });
  await brief.getByLabel('Centre latitude', { exact: true }).fill('52.6'); await brief.getByLabel('Centre longitude', { exact: true }).fill('-9.7');
  await brief.getByLabel('Radius (km)', { exact: true }).fill('25'); await brief.getByRole('button', { name: 'Use these coordinates', exact: true }).click();
  await brief.getByRole('checkbox', { name: 'I chose this target and checked the area size.', exact: true }).check();
  await brief.getByRole('button', { name: 'Keep brief and close', exact: true }).click(); await expect(brief).toHaveCount(0);

  if (mode === 'DEMONSTRATION') {
    await page.getByRole('button', { name: 'List view', exact: true }).click();
    await page.getByRole('button', { name: 'Open Estuary SAR 03', exact: true }).click();
    await page.getByRole('button', { name: 'Close Discovery details', exact: true }).click();
  }
  await page.getByRole('button', { name: 'Globe view', exact: true }).click();
  const stage = page.getByRole('region', { name: mode === 'REAL' ? 'Real orbital prediction' : 'Public demonstration geometry', exact: true });
  const canvas = await ready(stage);
  if (mode === 'REAL') {
    await stage.getByRole('button', { name: 'Orbit details', exact: true }).click();
    await stage.locator('.globe-position-list .text-button').first().click();
  }
  if (mode === 'REAL') {
    await page.getByRole('button', { name: 'Close Discovery details', exact: true }).click();
    await stage.getByRole('button', { name: 'Orbit details', exact: true }).click();
  }
  await ready(stage);
  await stage.getByRole('button', { name: 'Follow selected', exact: true }).click();
  await expect(stage.getByRole('button', { name: 'Stop following', exact: true })).toBeVisible(); await frames(canvas);
  await stage.getByRole('button', { name: 'Stop following', exact: true }).click(); await frames(canvas);
  await expect(stage.locator('.globe-selected-reticle')).toBeVisible();
  await expect(canvas).toHaveAttribute('data-applied-target', /"confirmed":true/);
  return { stage, canvas };
}

async function stationaryGround(page: Page, stage: Locator, canvas: Locator) {
  const selected = (await stage.locator('.globe-selected-reticle').boundingBox())!;
  const center = { x: selected.x + selected.width / 2, y: selected.y + selected.height / 2 };
  for (const offset of [{ x: 80, y: 0 }, { x: -80, y: 0 }, { x: 0, y: 80 }, { x: 0, y: -80 }, { x: 60, y: 60 }, { x: -60, y: -60 }]) {
    const point = { x: Math.round(center.x + offset.x), y: Math.round(center.y + offset.y) };
    if (!await canvas.evaluate((node, value) => document.elementFromPoint(value.x, value.y) === node, point)) continue;
    await page.mouse.move(point.x, point.y); await frames(canvas);
    if (await stage.locator('.globe-ground-card').isVisible()) return stage.locator('.globe-ground-card');
  }
  throw new Error('No accessible ground hover beside the explicitly followed and stopped selection.');
}

async function snapshot(stage: Locator, canvas: Locator) {
  return { camera: (await canvas.getAttribute('data-camera-position'))!, view: await canvas.getAttribute('data-view-offset'),
    time: await stage.getAttribute('data-represented-utc'), target: await canvas.getAttribute('data-applied-target'),
    colors: await canvas.getAttribute('data-point-colors'), shortlist: await canvas.getAttribute('data-shortlisted-ids') };
}

async function successfulPollPreservesHover(page: Page, stage: Locator, canvas: Locator, card: Locator) {
  await expect(card).toBeVisible(); const text = await card.textContent(), before = await snapshot(stage, canvas);
  const original = await (await page.request.get('/api/context')).json() as Context;
  const polling = page.waitForResponse(response => new URL(response.url()).pathname === '/api/context' && response.request().method() === 'GET');
  // Advance the actual routine timer; no response double, forced render or mouse move.
  await page.clock.fastForward(15_000);
  const response = await polling; expect(response.status()).toBe(200); await response.finished();
  const adopted = await response.json() as Context;
  expect([adopted.contextGeneration, adopted.contextToken, adopted.audience, adopted.actor?.id, adopted.organization?.id, adopted.role])
    .toEqual([original.contextGeneration, original.contextToken, original.audience, original.actor?.id, original.organization?.id, original.role]);
  await page.clock.runFor(64); await frames(canvas);
  await expect(card).toBeVisible(); await expect(card).toHaveText(text!);
  const after = await snapshot(stage, canvas), a = JSON.parse(before.camera) as number[], b = JSON.parse(after.camera) as number[];
  expect(Math.hypot(...b.map((value, index) => value - a[index]!))).toBeLessThanOrEqual(64 * Number.EPSILON * Math.max(1, Math.hypot(...a)));
  expect({ ...after, camera: undefined }).toEqual({ ...before, camera: undefined });
  await expect(stage.locator('.globe-selected-reticle')).toBeVisible();
  await expect(stage.getByRole('button', { name: 'Stop following', exact: true })).toHaveCount(0);
}

for (const mode of ['DEMONSTRATION', 'REAL'] as const) {
  test(`${mode}: successful unchanged routine poll preserves stationary ground and object hover with the same camera, time, confirmed target and selection @hover-poll @slice-09`, async ({ page }) => {
    const { stage, canvas } = await preparedGlobe(page, mode);
    const ground = await stationaryGround(page, stage, canvas); await successfulPollPreservesHover(page, stage, canvas, ground);
    const marker = (await stage.locator('.globe-selected-reticle').boundingBox())!;
    await page.mouse.move(Math.round(marker.x + marker.width / 2), Math.round(marker.y + marker.height / 2)); await frames(canvas);
    const object = stage.locator('.globe-hover-card'); await expect(object).toBeVisible();
    await successfulPollPreservesHover(page, stage, canvas, object);
  });
}
