import { test, expect, type Page } from '@playwright/test';
import type { Context, PublicCatalog, RequestProjection } from '../../shared/contracts.js';
import type { RealCatalogPage, RealEvidenceSnapshot } from '../../shared/orbital-contracts.js';
import { chooseDemonstrationCatalog, enterCustomer, enterStaff, showDiscoveryList } from './helpers.js';

// The isolated test server imports newly authored provider-response doubles: 283 unique
// identities, not the separately acquired 276-object recording catalog or reference orbits.
test.setTimeout(120_000);
const objectName = (id: number) => `Generated provider-response test object ${id}`;
const sentinelC = 'SENTINEL-1C — generated response double';
const sentinelD = 'SENTINEL-1D — generated response double';
const feedback = (page: Page) => page.getByRole('region', { name: 'Discovery query results', exact: true });
async function filters(page: Page) {
  const text = page.getByLabel('Search satellites and services', { exact: true });
  if (!await text.isVisible()) await page.getByRole('button', { name: 'Discover', exact: true }).click();
  await expect(text).toBeVisible();
}
async function closeFilters(page: Page) {
  const panel = page.getByRole('dialog', { name: 'Discovery filters', exact: true });
  if (await panel.count()) {
    await panel.getByRole('button', { name: 'Show discoveries', exact: true }).click();
    await expect(panel).toHaveCount(0);
  }
}
async function chooseReal(page: Page) {
  await closeFilters(page);
  const control = page.getByRole('combobox', { name: 'Catalog', exact: true });
  await control.selectOption('REAL'); await expect(control).toHaveValue('REAL');
}
async function readRealNeed(page: Page, purpose: string) {
  await filters(page);
  await page.getByLabel('Search satellites and services', { exact: true }).fill(purpose);
  await page.getByRole('button', { name: 'Search catalog only', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Search catalog only', exact: true })).toBeEnabled();
  await expect(page.getByText('Read by local rules', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Earth observation', exact: true }).click();
  await page.getByRole('combobox', { name: 'Sensor', exact: true }).selectOption('SAR');
  await page.getByRole('combobox', { name: 'Max resolution', exact: true }).selectOption('10');
  const review = page.getByRole('button', { name: 'Use reviewed filters', exact: true });
  if (await review.isVisible()) await review.click();
  await closeFilters(page);
  await expect(feedback(page).getByText('283 matching candidates', { exact: true })).toBeVisible();
}
async function fillBrief(page: Page) {
  await page.getByRole('button', { name: /Review this mission/ }).click();
  const panel = page.getByRole('dialog', { name: 'Your request', exact: true });
  await panel.getByRole('radio', { name: 'Baseline–recent comparison', exact: true }).check();
  await expect(panel.getByLabel('Baseline reference date', { exact: true })).toHaveValue('');
  await expect(panel.getByLabel('Recent reference date', { exact: true })).toHaveValue('');
  await panel.getByLabel('Centre latitude', { exact: true }).fill('52.6');
  await panel.getByLabel('Centre longitude', { exact: true }).fill('-9.7');
  await panel.getByLabel('Radius (km)', { exact: true }).fill('25');
  await panel.getByRole('button', { name: 'Use these coordinates', exact: true }).click();
  await panel.getByRole('checkbox', { name: 'I chose this target and checked the area size.', exact: true }).check();
  const bootstrap = await (await page.request.get('/api/public/catalog')).json() as PublicCatalog;
  await panel.getByLabel('Baseline reference date', { exact: true }).fill(bootstrap.demo.baselineDate);
  await panel.getByLabel('Recent reference date', { exact: true }).fill(bootstrap.demo.recentDate);
  await panel.getByLabel('Contact name', { exact: true }).fill('Generated-catalog research contact');
  await panel.getByLabel('Contact email', { exact: true }).fill('real-source-test@research.example');
  await panel.getByLabel('Organisation name', { exact: true }).fill('Fresh isolated environmental team');
  return { panel, bootstrap };
}
async function savePublicBrief(page: Page) {
  await page.getByRole('button', { name: 'Review request', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Real catalog evidence', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Open customer workspace', exact: true }).click();
  await page.getByRole('combobox', { name: 'Demonstration customer', exact: true }).selectOption('a-owner');
  await page.getByRole('button', { name: 'Continue to workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Review request in this workspace', exact: true }).click();
  await page.getByRole('checkbox', { name: 'I confirm this planning brief and destination. This does not request staff review.', exact: true }).check();
  const submit = page.getByRole('button', { name: 'Save planning request', exact: true });
  await expect(submit).toBeEnabled(); await submit.click();
  await expect(page.getByRole('heading', { name: 'Request saved', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Open request in Demo Estuary Research', exact: true }).click();
  const id = new URL(page.url()).pathname.split('/').at(-1)!;
  const planning = await (await page.request.get(`/api/customer/org-a/requests/${id}`)).json() as RequestProjection;
  expect(planning.status).toBe('Planning'); expect(planning.submittedAt).toBeNull();
  await page.getByRole('button', { name: 'Submit request for review…', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Submit Planning request for review', exact: true });
  await review.getByRole('checkbox', { name: 'I request staff feasibility review for this brief and workspace. This is not a booking or collection.', exact: true }).check();
  await review.getByRole('button', { name: 'Review submission', exact: true }).click();
  await review.getByRole('button', { name: 'Submit request for review', exact: true }).click();
  await expect(review).toHaveCount(0);
  await expect(page.locator('.page-heading').getByText('Submitted', { exact: true })).toBeVisible();
  const response = await page.request.get(`/api/customer/org-a/requests/${id}`);
  expect(response.status()).toBe(200);
  const row = await response.json() as RequestProjection;
  expect(row.brief).toEqual(planning.brief); expect(row.briefRevision).toBe(planning.briefRevision);
  return { id, row };
}

test('default real source counts the full adopted snapshot, pages beyond 100, and separates unknown from documented capabilities @slice-08', async ({ page }, info) => {
  await page.goto('/'); await closeFilters(page);
  await expect(page.getByRole('combobox', { name: 'Catalog', exact: true })).toHaveValue('REAL');
  await expect(feedback(page).getByText('283 catalog candidates', { exact: true })).toBeVisible();
  const source = page.getByRole('region', { name: 'Discovery catalog source', exact: true });
  await expect(source).toContainText('232 source rows');
  await expect(source).toContainText('81 source rows');
  await expect(source).toContainText('Partial source coverage');
  await showDiscoveryList(page);
  await expect(page.locator('.catalog-list > .catalog-row')).toHaveCount(100);
  await expect(page.locator('.real-catalog-paging')).toContainText('100 loaded / 283 matches');
  await page.getByRole('button', { name: 'Load more matches', exact: true }).click();
  await expect(page.locator('.catalog-list > .catalog-row')).toHaveCount(200);
  await expect(feedback(page).getByText('283 catalog candidates', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Load more matches', exact: true }).click();
  await expect(page.locator('.catalog-list > .catalog-row')).toHaveCount(283);
  await expect(page.getByRole('button', { name: `Open ${objectName(123456789)}`, exact: true })).toBeVisible();
  const ids = await page.locator('.catalog-list .catalog-identity').allTextContents();
  expect(new Set(ids).size).toBe(283);
  expect(ids.filter(id => id === 'norad:100201')).toHaveLength(1); // overlap is deduplicated
  await readRealNeed(page, 'SAR imagery, maximum ground resolution 10 m.');
  await expect(feedback(page)).toContainText('Includes 283 with unrecorded evidence');
  await filters(page);
  await page.getByRole('checkbox', { name: 'Documented criteria only', exact: true }).check();
  await expect(feedback(page).getByText('0 matching candidates', { exact: true })).toBeVisible();
  await showDiscoveryList(page);
  await expect(page.getByRole('heading', { name: 'No candidates with all requested evidence documented', exact: true })).toBeVisible();
  await filters(page);
  await page.getByRole('button', { name: /^Remove Max resolution:/ }).click();
  await closeFilters(page);
  await expect(feedback(page).getByText('2 matching candidates', { exact: true })).toBeVisible();
  await showDiscoveryList(page);
  await expect(page.getByRole('button', { name: `Open ${sentinelC}`, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: `Open ${sentinelD}`, exact: true })).toBeVisible();
  await page.getByRole('button', { name: `Open ${sentinelC}`, exact: true }).click();
  const detail = page.getByRole('complementary', { name: 'Discovery details', exact: true });
  await expect(detail).toContainText('Mode/product required to verify requested resolution');
  await expect(detail).toContainText('10×10 m pixel spacing is not spatial resolution');
  await expect(detail).toContainText('20 × 22 m');
  await expect(detail).toContainText('IW'); await expect(detail).toContainText('GRD HR');
  await expect(detail.getByRole('link', { name: /Approximate spatial resolution/ })).toHaveAttribute('href', /^https:\/\//);
  await page.screenshot({ path: info.outputPath('real-capability-facts.png') });
});

test('off-page real details and per-source shortlists preserve the shared question, manual fields, deliberate circle and reference dates @slice-08', async ({ page }, info) => {
  const purpose = `Preserve this coastal SAR research question (${info.project.name}).`;
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.goto('/'); await readRealNeed(page, purpose);
  await filters(page); await page.getByLabel('Keyword', { exact: true }).fill('100260');
  await closeFilters(page); await showDiscoveryList(page);
  await expect(feedback(page).getByText('1 matching candidate', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: `Add ${objectName(100260)} to shortlist`, exact: true }).click();
  await page.getByRole('button', { name: `Open ${objectName(100260)}`, exact: true }).click();
  const detail = page.getByRole('dialog', { name: 'Discovery details', exact: true });
  const catalog = await (await page.request.get('/api/public/real-catalog')).json() as RealCatalogPage;
  await expect(detail).toContainText('NORAD 100260');
  await expect(detail).toContainText(catalog.snapshotVersion!);
  await expect(detail).toContainText(catalog.factVersion);
  await expect(detail).toContainText('No independently cited instrument/operator facts');
  await detail.getByRole('button', { name: 'Close Discovery details', exact: true }).click();
  await filters(page); await page.getByLabel('Keyword', { exact: true }).fill('');
  await closeFilters(page); await expect(feedback(page).getByText('283 matching candidates', { exact: true })).toBeVisible();
  await showDiscoveryList(page);
  await expect(page.locator('.catalog-list').getByRole('button', { name: `Open ${objectName(100260)}`, exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: `Details for shortlisted ${objectName(100260)}`, exact: true }).click();
  await expect(detail.getByRole('heading', { name: objectName(100260), exact: true })).toBeVisible();
  await detail.getByRole('button', { name: 'Close Discovery details', exact: true }).click();
  const { panel, bootstrap } = await fillBrief(page);
  await panel.getByLabel('Maximum ground resolution', { exact: true }).fill('5');
  await panel.getByRole('button', { name: 'Keep brief and close', exact: true }).click();
  await expect(panel).toHaveCount(0);
  await chooseDemonstrationCatalog(page); await showDiscoveryList(page);
  await expect(page.getByRole('heading', { name: 'Your shortlist · 0', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: `Open ${objectName(100260)}`, exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Add Estuary SAR 03 to shortlist', exact: true }).click();
  await chooseReal(page); await showDiscoveryList(page);
  await expect(page.getByRole('heading', { name: 'Your shortlist · 1', exact: true })).toBeVisible();
  await expect(page.locator('#discovery-shortlist')).toContainText(objectName(100260));
  await expect(page.locator('#discovery-shortlist')).not.toContainText('Estuary SAR 03');
  await page.getByRole('button', { name: /Review this mission/ }).click();
  await expect(panel.getByLabel('Mission purpose', { exact: true })).toHaveValue(purpose);
  await expect(panel.getByLabel('Maximum ground resolution', { exact: true })).toHaveValue('5');
  await expect(panel.getByLabel('Centre latitude', { exact: true })).toHaveValue('52.6');
  await expect(panel.getByLabel('Centre longitude', { exact: true })).toHaveValue('-9.7');
  await expect(panel.getByRole('checkbox', { name: 'I chose this target and checked the area size.', exact: true })).toBeChecked();
  await expect(panel.getByLabel('Baseline reference date', { exact: true })).toHaveValue(bootstrap.demo.baselineDate);
  await expect(panel.getByLabel('Recent reference date', { exact: true })).toHaveValue(bootstrap.demo.recentDate);
  await expect(panel.getByLabel('Contact email', { exact: true })).toHaveValue('real-source-test@research.example');
  await page.screenshot({ path: info.outputPath('real-demo-retained-mobile-brief.png') });
});

for (const selected of [true, false]) test(`a new real-source request ${selected ? 'with exact selected evidence' : 'without an optional shortlist'} is saved through named customer review and visible to separate staff @slice-08`, async ({ page }, info) => {
  const purpose = `Fresh real-source request ${selected ? 'with selection' : 'without selection'} (${info.project.name}). SAR imagery.`;
  await page.goto('/'); await readRealNeed(page, purpose); await showDiscoveryList(page);
  const catalog = await (await page.request.get('/api/public/real-catalog')).json() as RealCatalogPage;
  if (selected) await page.getByRole('button', { name: `Add ${sentinelC} to shortlist`, exact: true }).click();
  await fillBrief(page);
  const { id, row } = await savePublicBrief(page);
  expect(row.brief.purpose).toBe(purpose);
  expect(row.brief.catalogContext).toEqual({ sourceKind: 'PUBLIC_REAL', snapshotVersion: catalog.snapshotVersion, factVersion: catalog.factVersion });
  expect(row.brief.maxResolutionM).toBe(10);
  expect(row.evidence).toHaveLength(selected ? 1 : 0);
  if (selected) {
    const evidence = row.evidence[0] as RealEvidenceSnapshot;
    expect(evidence).toMatchObject({ sourceKind: 'PUBLIC_REAL', itemId: 'norad:62261', catalogNumber: '62261', verified: true, snapshotVersion: catalog.snapshotVersion, factVersion: catalog.factVersion, resolutionM: null });
    expect(evidence.evidenceVersion).toBeTruthy();
    expect(evidence.capabilityFacts.some(fact => fact.product === 'GRD HR' && fact.mode === 'IW')).toBe(true);
    expect(evidence.uncertainties.join(' ')).toMatch(/resolution|mode|product/i);
  }
  await page.reload();
  await expect(page.getByText(purpose, { exact: true }).first()).toBeVisible();
  await page.getByText(`Submitted brief and evidence · Revision ${row.briefRevision}`, { exact: true }).click();
  if (selected) {
    await expect(page.getByText('Saved real catalog evidence — historical snapshot, not taskability', { exact: true })).toBeVisible();
    await page.getByText('Saved real-source provenance and capability facts', { exact: true }).click();
    await expect(page.getByText(catalog.snapshotVersion!, { exact: true })).toBeVisible();
  } else await expect(page.getByText('No catalog selection. Our team will review the brief.', { exact: true })).toBeVisible();
  await enterStaff(page); await page.goto(`/staff/requests/${id}`);
  await expect(page.getByText(purpose, { exact: true }).first()).toBeVisible();
  const staff = await (await page.request.get(`/api/staff/requests/${id}`)).json() as RequestProjection;
  expect(staff.brief.catalogContext).toEqual(row.brief.catalogContext);
  expect(staff.evidence).toEqual(row.evidence);
  await page.screenshot({ path: info.outputPath(selected ? 'saved-real-selection-staff.png' : 'saved-real-empty-shortlist-staff.png') });
});

test('real source unavailable and failed checks disclose unknown counts while manual brief and local sample access remain usable @slice-08', async ({ page }, info) => {
  await page.route('**/api/public/real-catalog?*', async route => {
    const response = await route.fetch(), value = await response.json() as RealCatalogPage;
    await route.fulfill({ response, json: { ...value, availability: 'UNAVAILABLE', validation: 'UNAVAILABLE', snapshotVersion: null,
      items: [], nextCursor: null, dictionary: { operators: [], countries: [], places: [] },
      counts: { unique: 0, matching: 0, unknown: 0, excluded: 0, rejected: 0, invalidOrbits: 0, loaded: 0, sourceTotal: null },
      sources: value.sources.map(source => ({ ...source, version: null, retrievedAt: null, checkedAt: null, validation: 'UNAVAILABLE', rows: 0, identified: 0, error: 'Fresh isolated unavailable-source response.' })),
      message: 'Fresh isolated unavailable-source response.' } });
  });
  await page.goto('/'); await readUnavailableNeed(page, `Manual fallback after unavailable real source (${info.project.name}). SAR imagery.`);
  await expect(feedback(page).getByText('Candidate count unavailable', { exact: true })).toBeVisible();
  await expect(feedback(page).getByText('0 matching candidates', { exact: true })).toHaveCount(0);
  await showDiscoveryList(page);
  await expect(page.locator('#discovery-matches').getByRole('heading', { name: 'Matches Unavailable', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open Estuary SAR 03', exact: true })).toHaveCount(0);
  await expect(page.locator('.catalog-list > .catalog-row')).toHaveCount(0);
  await fillBrief(page);
  const { row } = await savePublicBrief(page);
  expect(row.brief.catalogContext).toEqual({ sourceKind: 'PUBLIC_REAL', snapshotVersion: null, factVersion: null });
  expect(row.evidence).toEqual([]);
  await page.unroute('**/api/public/real-catalog?*');
  await page.goto('/'); await closeFilters(page);
  await expect(feedback(page).getByText('283 catalog candidates', { exact: true })).toBeVisible();
  await page.route('**/api/public/real-catalog?*', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'TEST_REAL_SOURCE_FAILED', message: 'Fresh isolated latest source-check failure.' }) }));
  await filters(page); await page.getByLabel('Keyword', { exact: true }).fill('100260');
  await closeFilters(page); await showDiscoveryList(page);
  await expect(feedback(page)).toHaveAttribute('data-query-phase', 'failure');
  await expect(feedback(page)).toContainText('283 candidates from');
  await expect(page.locator('#discovery-matches')).toContainText('Results are incomplete because the latest source check failed.');
  await expect(page.locator('#discovery-matches')).not.toContainText('0 available records');
  await expect(page.locator('.catalog-list > .catalog-row')).toHaveCount(100);
});

test('a public catalog refresh cannot uncover cached customer access after a failed fresh lifecycle check @slice-08', async ({ page }) => {
  await enterCustomer(page);
  const context = await (await page.request.get('/api/context')).json() as Context;
  expect(context.audience).toBe('CUSTOMER'); expect(context.actor).not.toBeNull();
  await expect(page.locator('.header-context .context-name')).toContainText(context.actor!.name);
  await page.locator('.desktop-products').getByRole('link', { name: 'StarSearch', exact: true }).click();
  await closeFilters(page);
  await expect(feedback(page).getByText('283 catalog candidates', { exact: true })).toBeVisible();
  await showDiscoveryList(page); // The public catalog action is usable without a globe request.
  await page.route('**/api/context', route => route.fulfill({ status: 503, json: { code: 'TEST_FRESH_CONTEXT_FAILED', message: 'Fresh isolated access check is unavailable.' } }));
  const failedCheck = page.waitForResponse(response => new URL(response.url()).pathname === '/api/context' && response.status() === 503);
  await page.evaluate(() => { window.dispatchEvent(new Event('pagehide')); window.dispatchEvent(new Event('pageshow')); });
  await failedCheck;
  await expect(page.locator('.header-context .context-name')).toHaveCount(0);
  await page.locator('.desktop-products').getByRole('link', { name: 'Workspace', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Check account', exact: true })).toBeVisible();
  await page.locator('.desktop-products').getByRole('link', { name: 'StarSearch', exact: true }).click();
  await closeFilters(page); await showDiscoveryList(page);
  let refreshPosts = 0;
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/orbital-evidence/refresh') refreshPosts++; });
  const source = page.getByRole('region', { name: 'Discovery catalog source', exact: true });
  await source.getByRole('button', { name: 'Refresh public catalog', exact: true }).click();
  await expect(source.getByRole('status')).toContainText('Fresh isolated access check is unavailable.');
  await expect(page.locator('.header-context .context-name')).toHaveCount(0);
  expect(refreshPosts).toBe(0);
  await page.locator('.desktop-products').getByRole('link', { name: 'Workspace', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Check account', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Requests', exact: true })).toHaveCount(0);
  await expect(page.locator('.header-context .context-name')).toHaveCount(0);
});

async function readUnavailableNeed(page: Page, purpose: string) {
  await filters(page);
  await page.getByLabel('Search satellites and services', { exact: true }).fill(purpose);
  await page.getByRole('button', { name: 'Search catalog only', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Search catalog only', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Earth observation', exact: true }).click();
  await page.getByRole('combobox', { name: 'Sensor', exact: true }).selectOption('SAR');
  const review = page.getByRole('button', { name: 'Use reviewed filters', exact: true });
  if (await review.isVisible()) await review.click();
  await closeFilters(page);
}
