import { expect, type Locator, type Page } from '@playwright/test';
import type { RequestProjection } from '../../shared/contracts.js';
import type { OrbitalBrowsePage, RealCatalogPage } from '../../shared/orbital-contracts.js';
import { emptyDiscoveryValues } from '../../shared/discovery.js';
import { currentContext, showDiscoveryList } from './helpers.js';

export const panelFor = (page: Page) => page.getByRole('dialog', { name: 'Your request', exact: true });
export const caseName = (label: string, engine: string) => `${label} ${engine} ${crypto.randomUUID().slice(0, 8)}`;
export const iso = (value: number) => new Date(value).toISOString();
export async function bodyPost(page: Page, path: string, body: Record<string, unknown>) {
  const context = await currentContext(page);
  return page.request.post(path, { headers: { origin: new URL(page.url()).origin, 'x-coruscant-csrf': context.csrfToken! }, data: { ...body, contextGeneration: context.contextGeneration, contextToken: context.contextToken } });
}
/** No workflow state is seeded. The provider double's actual SGP4 output chooses
 * an observer beneath a future position, then the normal UI asks the real job. */
export async function prepareRealTarget(page: Page, title: string, withoutRenderer = false) {
  await page.goto('/');
  const browsingUtc = await page.getByRole('region', { name: 'Real orbital prediction', exact: true }).getAttribute('data-represented-utc');
  if (withoutRenderer) await expect(page.getByRole('heading', { name: '3D globe unavailable', exact: true })).toBeVisible();
  const description = page.getByLabel('Search satellites and services', { exact: true });
  if (!await description.isVisible()) await page.getByRole('button', { name: 'Discover', exact: true }).click();
  await description.fill(title);
  await page.getByRole('button', { name: 'Search catalog only', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Search catalog only', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Earth observation', exact: true }).click();
  await page.getByRole('combobox', { name: 'Sensor', exact: true }).selectOption('SAR');
  await page.getByLabel('Keyword', { exact: true }).fill('SENTINEL-1C');
  await page.getByRole('combobox', { name: 'Max resolution', exact: true }).selectOption('10');
  await showDiscoveryList(page);
  const reviewFilters = page.getByRole('button', { name: 'Use reviewed filters', exact: true });
  if (await reviewFilters.isVisible()) await reviewFilters.click();
  await page.getByRole('button', { name: /Review this mission/ }).click();
  const panel = panelFor(page); await expect(panel).toBeVisible();
  const sourceResponse = await page.request.get('/api/public/real-catalog'); expect(sourceResponse.status()).toBe(200);
  const source = await sourceResponse.json() as RealCatalogPage;
  const context = await currentContext(page), at = Date.parse(context.serverNow) + 15 * 60_000;
  const browse = await bodyPost(page, '/api/orbital-browse', { snapshotVersion: source.snapshotVersion, factVersion: source.factVersion, representedAt: iso(at), generation: 9001, criteria: { ...emptyDiscoveryValues(), family: 'EO', sensor: 'SAR', keyword: 'SENTINEL-1C', documentedOnly: false }, selectedId: 'norad:62261', shortlistedIds: [], visibility: 'MATCHES' });
  expect(browse.status(), await browse.text()).toBe(200);
  const value = await browse.json() as OrbitalBrowsePage, target = value.objects.find(row => row.id === 'norad:62261');
  expect(target?.positionAvailability).toBe('AVAILABLE');
  await panel.getByLabel('Centre latitude', { exact: true }).fill(String(target!.position!.latitude));
  await panel.getByLabel('Centre longitude', { exact: true }).fill(String(target!.position!.longitude));
  await panel.getByLabel('Radius (km)', { exact: true }).fill('1');
  await panel.getByRole('button', { name: 'Use these coordinates', exact: true }).click();
  await panel.getByRole('checkbox', { name: 'I chose this target and checked the area size.', exact: true }).check();
  return { panel, at, source, target: target!.position!, browsingUtc };
}
export async function finishWindow(panel: Locator, at: number) {
  await panel.getByRole('checkbox', { name: 'Timing to be discussed', exact: true }).uncheck();
  await panel.getByLabel('Window start (local)', { exact: true }).fill(iso(at - 10_000).slice(0, -1));
  await panel.getByLabel('Window end (local)', { exact: true }).fill(iso(at + 10_000).slice(0, -1));
}
export async function selectProvisional(panel: Locator) {
  const option = panel.getByRole('article', { name: /Planning option SENTINEL-1C/ }).first();
  await expect(option).toBeVisible();
  await expect(option).toContainText('Geometric candidate — requirements unresolved');
  await expect(option.getByRole('button', { name: 'Use this plan', exact: true })).toBeDisabled();
  for (const check of await option.getByRole('checkbox').all()) await check.check();
  await option.getByRole('button', { name: 'Use this plan', exact: true }).click();
  await expect(panel.getByRole('region', { name: 'Locally selected proposed plan', exact: true })).toBeVisible();
  return option;
}
export async function saveFromPublic(page: Page) {
  await panelFor(page).getByRole('button', { name: 'Save proposed plan', exact: true }).click();
  await page.getByRole('link', { name: 'Open customer workspace', exact: true }).click();
  await page.getByRole('combobox', { name: 'Demonstration customer', exact: true }).selectOption('a-owner');
  await page.getByRole('button', { name: 'Continue to workspace', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Review request in this workspace', exact: true })).toBeVisible();
  const rechecked = page.waitForResponse(response => new URL(response.url()).pathname === '/api/context' && response.request().method() === 'GET');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  expect((await rechecked).status()).toBe(200);
  await expect(page.getByRole('button', { name: 'Review request in this workspace', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Review request in this workspace', exact: true }).click();
  await page.getByRole('checkbox', { name: 'I confirm this planning brief and destination. This does not request staff review.', exact: true }).check();
  const save = page.getByRole('button', { name: 'Save proposed plan', exact: true });
  await expect(save).toBeEnabled();
  await expect(page.getByRole('heading', { name: 'Tentative — not booked', exact: true })).toBeVisible();
  await save.click(); await expect(page.getByRole('heading', { name: 'Request saved', exact: true })).toBeVisible();
  const requestId = new URL(page.url()).searchParams.get('request')!;
  const response = await page.request.get(`/api/customer/org-a/requests/${requestId}`); expect(response.status()).toBe(200);
  return await response.json() as RequestProjection;
}
