import { chooseDemonstrationCatalog } from './helpers.js';
import { test, expect, type Page } from '@playwright/test';
import type { PublicCatalog, RequestProjection } from '../../shared/contracts.js';
import { enterStaff, showDiscoveryList, submitSavedPlanning } from './helpers.js';

test.setTimeout(120_000);
async function filters(page: Page) {
  if (page.viewportSize()!.width < 1024) await expect(page.locator('.discovery-rail')).toHaveCount(0);
  const field = page.getByLabel('Search satellites and services', { exact: true });
  if (!await field.isVisible()) await page.getByRole('button', { name: 'Discover', exact: true }).click();
  await expect(field).toBeVisible();
}
async function discoveries(page: Page) { await showDiscoveryList(page); }
async function explore(page: Page, text: string) {
  await filters(page);
  await page.getByLabel('Search satellites and services', { exact: true }).fill(text);
  await page.getByRole('button', { name: 'Search catalog only', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Search catalog only', exact: true })).toBeEnabled();
  await expect(page.getByText('Read by local rules', { exact: true }).first()).toBeVisible();
}
function effective(page: Page, label: string) {
  return page.locator('.interpreted-effective > div').filter({ has: page.locator('dt', { hasText: new RegExp(`^${label}$`) }) }).locator('dd');
}
async function circleDatesContact(page: Page) {
  const panel = page.getByRole('dialog', { name: 'Your request', exact: true });
  await panel.getByRole('radio', { name: 'Baseline–recent comparison', exact: true }).check();
  await expect(panel.getByLabel('Baseline reference date', { exact: true })).toHaveValue('');
  await expect(panel.getByLabel('Recent reference date', { exact: true })).toHaveValue('');
  await panel.getByLabel('Centre latitude', { exact: true }).fill('52.6');
  await panel.getByLabel('Centre longitude', { exact: true }).fill('-9.7');
  await panel.getByLabel('Radius (km)', { exact: true }).fill('25');
  await panel.getByRole('button', { name: 'Use these coordinates', exact: true }).click();
  await panel.getByRole('checkbox', { name: 'I chose this target and checked the area size.', exact: true }).check();
  const catalog = await (await page.request.get('/api/public/catalog')).json() as PublicCatalog;
  await panel.getByLabel('Baseline reference date', { exact: true }).fill(catalog.demo.baselineDate);
  await panel.getByLabel('Recent reference date', { exact: true }).fill(catalog.demo.recentDate);
  await panel.getByLabel('Contact name', { exact: true }).fill('Demonstration coastal research contact');
  await panel.getByLabel('Contact email', { exact: true }).fill('local-rules@coastal.example');
  await panel.getByLabel('Organisation name', { exact: true }).fill('Demonstration water researchers');
  return { panel, catalog };
}
async function submit(page: Page) {
  await page.getByRole('button', { name: 'Review request', exact: true }).click();
  await page.getByRole('link', { name: 'Open customer workspace', exact: true }).click();
  await page.getByRole('combobox', { name: 'Demonstration customer', exact: true }).selectOption('a-owner');
  await page.getByRole('button', { name: 'Continue to workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Review request in this workspace', exact: true }).click();
  await page.getByRole('checkbox', { name: 'I confirm this planning brief and destination. This does not request staff review.', exact: true }).check();
  await page.getByRole('button', { name: 'Save planning request', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Request saved', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Open request in Demo Estuary Research', exact: true }).click();
  const id = new URL(page.url()).pathname.split('/').at(-1)!;
  await submitSavedPlanning(page);
  const row = await (await page.request.get(`/api/customer/org-a/requests/${id}`)).json() as RequestProjection;
  return { row, id };
}

test('varied English need → explained inference → real chip removal → canonical saved criteria/evidence @slice-05', async ({ page }, info) => {
  const text = `Our coastal team needs to compare possible surface-water expansion following heavy rainfall (${info.project.name}).`;
  await page.goto('/'); await chooseDemonstrationCatalog(page); await explore(page, text);
  await expect(effective(page, 'Sensor')).toHaveText('Synthetic aperture radar');
  await expect(effective(page, 'Max resolution')).toHaveText('10 m');
  await page.getByText('Requirements and source phrases', { exact: true }).first().click();
  await expect(page.getByText('inferred', { exact: true }).first()).toBeVisible();
  await discoveries(page);
  const review = page.getByRole('button', { name: 'Use reviewed filters', exact: true });
  if (await review.isVisible()) await review.click();
  await expect(page.getByRole('button', { name: 'Open Estuary SAR 03', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open Wide SAR 20', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open Survey Candidate', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add Estuary SAR 03 to shortlist', exact: true }).click();
  await filters(page);
  await page.getByRole('button', { name: /^Remove Max resolution/ }).click();
  await expect(effective(page, 'Max resolution')).toHaveText('No limit');
  await discoveries(page);
  await expect(page.getByRole('button', { name: 'Open Wide SAR 20', exact: true })).toBeVisible();
  if (await review.isVisible()) await review.click();
  await page.getByRole('button', { name: /Review this mission/ }).click();
  const { panel, catalog } = await circleDatesContact(page);
  await expect(panel.getByLabel('Mission purpose', { exact: true })).toHaveValue(text);
  await expect(panel.getByLabel('Maximum ground resolution', { exact: true })).toHaveValue('');
  const { row, id } = await submit(page);
  expect(row.brief.purpose).toBe(text); expect(row.brief.maxResolutionM).toBeNull();
  expect(row.brief.baselineDate).toBe(catalog.demo.baselineDate);
  expect(row.brief.recentDate).toBe(catalog.demo.recentDate);
  expect(row.brief.discovery!.effective.maxResolutionM).toBeNull();
  expect(row.brief.discovery!.manual).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'maxResolutionM', action: 'CLEAR' })]));
  expect(row.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ itemId: 'demo-sar-03', verified: true, matchesReviewedCriteria: true })]));
  expect(row.evidence[0]!.matchReasons!.length).toBeGreaterThan(0);
  await page.getByText('Submitted brief and evidence · Revision 1', { exact: true }).click();
  await expect(page.getByText('Read by local rules', { exact: true }).first()).toBeVisible();
  await enterStaff(page); await page.goto(`/staff/requests/${id}`);
  await expect(page.getByText(text, { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Requirements and source phrases', { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: info.outputPath('saved-local-reading.png') });
});

test('supported units, geometry exclusions, explicit sensor exclusions and honest mixed-family review @slice-05', async ({ page }) => {
  for (const text of ['Supply SAR imagery, maximum ground resolution 500 cm.', 'Synthetic aperture radar at .005 km resolution.']) {
    await page.goto('/'); await chooseDemonstrationCatalog(page); await explore(page, text);
    await expect(effective(page, 'Max resolution')).toHaveText('5 m');
    await page.getByText('Requirements and source phrases', { exact: true }).first().click();
    await expect(page.getByText('stated', { exact: true }).first()).toBeVisible();
    await discoveries(page);
    await expect(page.getByRole('button', { name: 'Open Estuary SAR 03', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open Coast SAR 08', exact: true })).toHaveCount(0);
  }
  await page.goto('/'); await chooseDemonstrationCatalog(page); await explore(page, 'SAR imagery; radius 25 km; spacecraft altitude 500 km.');
  await discoveries(page);
  await expect(page.getByRole('button', { name: 'Open Wide SAR 20', exact: true })).toBeVisible();
  await page.goto('/'); await chooseDemonstrationCatalog(page); await explore(page, 'SAR imagery with resolution 10.');
  await expect(page.locator('[aria-label="Review conflicting fields"]').getByText(/unitless|unit is required|explicit unit/i)).toBeVisible();
  await page.goto('/'); await chooseDemonstrationCatalog(page); await explore(page, 'Surface-water expansion; no SAR, optical only.');
  await discoveries(page);
  await expect(page.getByRole('heading', { name: 'Planned — outside this prototype', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Review this mission/ })).toBeEnabled();
  await page.goto('/'); await chooseDemonstrationCatalog(page); await explore(page, 'SAR imagery and broadband communications for our coastal region.');
  await expect(page.getByText('Review conflicting fields', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Use reviewed filters', exact: true }).click();
  await discoveries(page);
  await expect(page.getByRole('button', { name: /Review this mission|Start request/ })).toBeDisabled();
});

test('manual criteria survive replacement prose; Planned return retains the public brief and optional shortlist @slice-05', async ({ page }, info) => {
  await page.goto('/'); await chooseDemonstrationCatalog(page); await explore(page, 'SAR images with maximum resolution 10 m; cloud cover 5%; revisit daily.');
  await page.getByRole('combobox', { name: 'Max resolution', exact: true }).selectOption('custom');
  await page.getByLabel('Custom resolution (m)', { exact: true }).fill('5');
  await explore(page, 'We need SAR imagery of a coastal site.');
  await expect(effective(page, 'Max resolution')).toHaveText('5 m');
  await page.getByText('Requirements and source phrases', { exact: true }).first().click();
  await expect(page.getByText('manual', { exact: true }).first()).toBeVisible();
  await discoveries(page);
  await page.getByRole('button', { name: 'Add Estuary SAR 03 to shortlist', exact: true }).click();
  await page.getByRole('button', { name: /Review this mission/ }).click();
  const { panel, catalog } = await circleDatesContact(page);
  await expect(panel.getByLabel('Maximum cloud cover (%)', { exact: true })).toHaveValue('');
  await expect(panel.getByLabel('Revisit interval (hours)', { exact: true })).toHaveValue('');
  await panel.getByRole('button', { name: 'Keep brief and close', exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.locator('#root')).toHaveJSProperty('inert', false);
  await explore(page, 'Broadband communications for a region.');
  await discoveries(page);
  await expect(page.getByRole('heading', { name: 'Communications', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Return to Earth observation', exact: true }).click();
  await page.getByRole('button', { name: /Review this mission/ }).click();
  await expect(panel.getByLabel('Mission purpose', { exact: true })).toHaveValue('We need SAR imagery of a coastal site.');
  await expect(panel.getByLabel('Maximum ground resolution', { exact: true })).toHaveValue('5');
  await expect(panel.getByLabel('Baseline reference date', { exact: true })).toHaveValue(catalog.demo.baselineDate);
  await expect(panel.getByLabel('Contact email', { exact: true })).toHaveValue('local-rules@coastal.example');
  await expect(panel.locator('.brief-shortlist li')).toContainText('Estuary SAR 03');
  await expect(panel.getByRole('checkbox', { name: 'I chose this target and checked the area size.', exact: true })).toBeChecked();
  await page.screenshot({ path: info.outputPath('retained-supported-brief.png') });
});

test('current evidence controls, unmatched shortlist detail, responsive focus and real source failure fallback @slice-05', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/'); await chooseDemonstrationCatalog(page); await explore(page, 'SAR imagery, maximum resolution 10 m; owner country: IE.');
  await discoveries(page);
  await page.getByRole('button', { name: 'Add Estuary SAR 03 to shortlist', exact: true }).click();
  await filters(page); await page.getByLabel('Keyword', { exact: true }).fill('Delta');
  await discoveries(page);
  await expect(page.getByText('No longer matching or not yet verified', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Details for shortlisted Estuary SAR 03', exact: true }).click();
  const detail = page.getByRole('complementary', { name: 'Discovery details', exact: true });
  await expect(detail.getByRole('heading', { name: 'Estuary SAR 03', exact: true })).toBeVisible();
  await expect(page.locator('#root')).toHaveJSProperty('inert', false);
  await detail.getByRole('button', { name: 'Close Discovery details', exact: true }).click();
  const grip = page.getByRole('separator', { name: /discovery/i });
  await grip.focus(); await grip.press('End'); await expect(grip).toHaveAttribute('aria-valuenow', '520');
  await grip.press('Home'); await expect(grip).toHaveAttribute('aria-valuenow', '280');
  for (const width of [1024, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width < 1024) {
      await filters(page);
      const filterPanel = page.getByRole('dialog', { name: 'Discovery filters', exact: true });
      await expect(filterPanel).toBeVisible();
      await expect(page.locator('#root')).toHaveJSProperty('inert', true);
      await expect(filterPanel.getByText('Read by local rules', { exact: true }).first()).toBeVisible();
      await page.keyboard.press('Tab'); expect(await filterPanel.evaluate(node => node.contains(document.activeElement))).toBe(true);
      await page.keyboard.press('Escape'); await expect(filterPanel).toHaveCount(0);
      await expect(page.locator('#root')).toHaveJSProperty('inert', false);
      await expect(page.getByRole('button', { name: 'Discover', exact: true })).toBeFocused();
    }
  }
  await page.getByRole('button', { name: 'Details for shortlisted Estuary SAR 03', exact: true }).click();
  const mobile = page.getByRole('dialog', { name: 'Discovery details', exact: true });
  await expect(mobile).toBeVisible(); await expect(page.locator('#root')).toHaveJSProperty('inert', true);
  await page.keyboard.press('Escape'); await expect(mobile).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('mobile-local-discovery.png') });
  await page.unrouteAll();
  await page.route('**/api/public/catalog', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'TEST_SOURCE_UNAVAILABLE', message: 'Isolated test source failure.' }) }));
  await page.goto('/'); await chooseDemonstrationCatalog(page); await explore(page, 'SAR imagery of a coastal estuary.');
  await page.getByRole('button', { name: 'Earth observation', exact: true }).click();
  await page.getByRole('combobox', { name: 'Sensor', exact: true }).selectOption('SAR');
  await discoveries(page);
  await expect(page.getByRole('heading', { name: 'Catalog unavailable', exact: true })).toBeVisible();
  const failedFeedback = page.getByRole('region', { name: 'Discovery query results', exact: true });
  await expect(failedFeedback).toHaveAttribute('data-query-phase', 'failure');
  await expect(failedFeedback.getByText('Candidate count unavailable', { exact: true })).toBeVisible();
  await expect(failedFeedback.getByText('0 matching candidates', { exact: true })).toHaveCount(0);
  await expect(page.locator('#discovery-matches').getByRole('heading', { name: 'Matches Unavailable', exact: true })).toBeVisible();
  await expect(page.locator('#discovery-matches')).toContainText('No loaded candidate set or verified total is available.');
  await expect(page.locator('#discovery-matches')).not.toContainText('0 available records');
  await page.getByRole('button', { name: /Review this mission/ }).click();
  await expect(page.getByRole('dialog', { name: 'Your request', exact: true })).toBeVisible();
});

test('optional shortlist enforces the actual fifty-item cap without losing existing selections @slice-05', async ({ page }) => {
  await page.route('**/api/public/catalog', async route => {
    const response = await route.fetch(), catalog = await response.json() as PublicCatalog;
    // Fresh isolated public-evidence examples exercise a bound the six-row recording catalog cannot reach.
    catalog.items = Array.from({ length: 51 }, (_, index) => ({
      id: `test-shortlist-${String(index + 1).padStart(2, '0')}`, name: `Shortlist example ${index + 1}`,
      family: 'EO', type: 'catalog', operator: null, ownerCountry: null, sensors: ['SAR'], resolutionM: 3,
      evidenceVersion: 'isolated-shortlist-v1', source: 'Fresh isolated synthetic shortlist-bound example',
      checkedAt: catalog.demo.d0, demonstration: true, caveats: ['Synthetic test evidence; no provider availability.'],
      status: 'unknown', launchDate: null,
    }));
    await route.fulfill({ response, json: catalog });
  });
  await page.goto('/'); await chooseDemonstrationCatalog(page); await filters(page);
  await page.getByRole('button', { name: 'Earth observation', exact: true }).click();
  await discoveries(page);
  for (let index = 1; index <= 50; index++) await page.getByRole('button', { name: `Add Shortlist example ${index} to shortlist`, exact: true }).click();
  await page.getByRole('button', { name: 'Add Shortlist example 51 to shortlist', exact: true }).click();
  await expect(page.getByText('The shortlist holds up to 50 items. Remove one to add another.', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your shortlist · 50', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add Shortlist example 51 to shortlist', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Remove Shortlist example 1 from shortlist', exact: true }).first().click();
  await page.getByRole('button', { name: 'Add Shortlist example 51 to shortlist', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your shortlist · 50', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove Shortlist example 51 from shortlist', exact: true }).first()).toBeVisible();
});


test('an older local reading cannot overwrite newer prose or a deliberate manual correction @slice-05', async ({ page }) => {
  await page.goto('/'); await chooseDemonstrationCatalog(page); await filters(page);
  await page.getByLabel('Search satellites and services', { exact: true }).fill('Surface-water expansion comparison.');
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find(node => node.textContent === 'Search catalog only')!;
    button.addEventListener('click', () => {
      const original = window.requestAnimationFrame;
      window.requestAnimationFrame = callback => {
        window.requestAnimationFrame = original;
        return window.setTimeout(() => { callback(performance.now()); document.documentElement.dataset.oldReadingReleased = 'yes'; }, 600);
      };
    }, { capture: true, once: true });
  });
  await page.getByRole('button', { name: 'Search catalog only', exact: true }).click();
  await page.getByLabel('Search satellites and services', { exact: true }).fill('SAR imagery at maximum resolution 5 m.');
  await page.getByRole('button', { name: 'Search catalog only', exact: true }).click();
  await expect(effective(page, 'Max resolution')).toHaveText('5 m');
  await page.getByRole('combobox', { name: 'Max resolution', exact: true }).selectOption('3');
  await expect(page.locator('html')).toHaveAttribute('data-old-reading-released', 'yes');
  await expect(effective(page, 'Max resolution')).toHaveText('3 m');
  await expect(page.getByLabel('Search satellites and services', { exact: true })).toHaveValue('SAR imagery at maximum resolution 5 m.');
  await page.getByRole('button', { name: 'Clear all filters', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start request', exact: false })).toBeEnabled();
  await discoveries(page);
  await expect(page.getByRole('button', { name: 'Open Wide SAR 20', exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Documented criteria only', exact: true })).not.toBeChecked();
  await expect(page.getByLabel('Search satellites and services', { exact: true })).toHaveValue('SAR imagery at maximum resolution 5 m.');
});

test('query feedback distinguishes browsing, an actual held reading, stale wording, review and a true empty match set @slice-07', async ({ page }) => {
  await page.goto('/'); await chooseDemonstrationCatalog(page);
  // This case deliberately holds the reading's animation frame. Use the actual list
  // so the unrelated continuous WebGL frame loop cannot compete for that test hook.
  await discoveries(page);
  const feedback = page.getByRole('region', { name: 'Discovery query results', exact: true });
  await expect(feedback).toHaveAttribute('data-query-phase', 'initial');
  await expect(feedback.getByText('6 catalog candidates', { exact: true })).toBeVisible();
  await expect(feedback.getByText('Includes 2 with unrecorded evidence', { exact: true })).toBeVisible();
  await expect(feedback.getByRole('status')).toHaveAttribute('aria-live', 'polite');
  await expect(feedback.getByText('0 shortlisted', { exact: true })).toBeVisible();
  await filters(page);
  await page.getByLabel('Search satellites and services', { exact: true }).fill('SAR imagery with maximum resolution 10 m.');
  await expect(feedback).toHaveAttribute('data-query-phase', 'stale');
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find(node => node.textContent === 'Explore matches')!;
    button.addEventListener('click', () => {
      const original = window.requestAnimationFrame;
      window.requestAnimationFrame = callback => {
        window.requestAnimationFrame = original;
        (window as Window & { releaseDiscoveryReading?: () => void }).releaseDiscoveryReading = () => callback(performance.now());
        return 0;
      };
    }, { capture: true, once: true });
  });
  await page.getByRole('button', { name: 'Explore matches', exact: true }).click();
  await expect(feedback).toHaveAttribute('data-query-phase', 'reading');
  await expect(feedback.getByText(/Reading your request/)).toBeVisible();
  // Reading is semantically unavailable without native disabled-button blur.
  // A repeated keyboard activation must neither start nor complete a new reading.
  const readingAction = page.getByRole('button', { name: 'Reading…', exact: true });
  await expect(readingAction).toHaveAttribute('aria-disabled', 'true');
  await readingAction.focus(); await expect(readingAction).toBeFocused();
  await readingAction.press('Enter');
  await expect(feedback).toHaveAttribute('data-query-phase', 'reading');
  await page.evaluate(() => (window as Window & { releaseDiscoveryReading?: () => void }).releaseDiscoveryReading!());
  await expect(feedback).toHaveAttribute('data-query-phase', 'complete');
  await expect(feedback.getByText('4 matching candidates', { exact: true })).toBeVisible();
  await expect(feedback.getByText('Includes 2 with unrecorded evidence', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Explore matches', exact: true })).toBeFocused();
  await expect(feedback.getByText('0 shortlisted', { exact: true })).toBeVisible();
  await page.getByLabel('Search satellites and services', { exact: true }).fill('');
  await expect(feedback).toHaveAttribute('data-query-phase', 'stale');
  await expect(feedback.getByText('4 candidates from previous criteria', { exact: true })).toBeVisible();
  await feedback.getByRole('button', { name: 'View matches', exact: true }).click();
  await expect(page.locator('#discovery-matches')).toContainText('4 candidates from the previous criteria.');
  await expect(page.locator('#discovery-matches')).toContainText('The current wording or source check does not have completed results.');
  await expect(page.locator('#discovery-matches')).not.toContainText('match the current criteria');
  await expect(page.getByRole('button', { name: /Review this mission/ })).toBeDisabled();
  await explore(page, 'SAR imagery and broadband communications for our coastal region.');
  await expect(feedback).toHaveAttribute('data-query-phase', 'review');
  await expect(feedback.getByText(/provisional candidates/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Start request|Review this mission/ })).toBeDisabled();
  await explore(page, 'SAR imagery with maximum resolution 0.3 m.');
  await page.getByRole('checkbox', { name: 'Documented criteria only', exact: true }).check();
  await expect(feedback).toHaveAttribute('data-query-phase', 'empty');
  await expect(feedback.getByText('0 matching candidates', { exact: true })).toBeVisible();
  await feedback.getByRole('button', { name: 'View matches', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No catalog matches', exact: true })).toBeVisible();
  await expect(page.locator('.catalog-row.selected')).toHaveCount(0);
});

test('query actions and the existing dock open the actual optional shortlist; optical evidence stays prominent and approved EO planning remains available @slice-07', async ({ page }) => {
  await page.goto('/'); await chooseDemonstrationCatalog(page);
  const feedback = page.getByRole('region', { name: 'Discovery query results', exact: true });
  await feedback.getByRole('button', { name: 'View shortlist', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your shortlist · 0', exact: true })).toBeInViewport();
  await expect(page.getByText('Nothing shortlisted yet. Open a match from the list or the globe and choose “Add to shortlist”.', { exact: true })).toBeVisible();
  await explore(page, 'SAR imagery with maximum resolution 10 m.');
  await feedback.getByRole('button', { name: 'View matches', exact: true }).click();
  await page.getByRole('button', { name: 'Add Estuary SAR 03 to shortlist', exact: true }).click();
  await expect(feedback.getByText('1 shortlisted', { exact: true })).toBeVisible();
  await page.getByRole('region', { name: 'Prepared mission', exact: true }).getByRole('button', { name: 'Shortlist (1)', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your shortlist · 1', exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Details for shortlisted Estuary SAR 03', exact: true })).toBeVisible();
  await explore(page, 'Visible imagery over Shannon estuary.');
  await feedback.getByRole('button', { name: 'View matches', exact: true }).click();
  const availability = page.getByRole('region', { name: 'Request availability', exact: true });
  await expect(availability).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open Coast Visible', exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: /Review this mission/ })).toBeEnabled();
  await expect(page.getByRole('heading', { name: 'Your shortlist · 1', exact: true })).toBeVisible();
  await expect(page.getByText('No longer matching or not yet verified', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Sensor', exact: true })).toHaveValue('VISIBLE');
  await expect(page.getByRole('button', { name: 'List view', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('long refinement values remain readable at every approved width and keyboard query actions remain usable @slice-07', async ({ page }, info) => {
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 }); await page.goto('/'); await chooseDemonstrationCatalog(page); await filters(page);
    await explore(page, 'SAR imagery over Shannon estuary, maximum resolution 10 m; cloud cover 5%; revisit daily.');
    await page.getByText('Requirements and source phrases', { exact: true }).first().click();
    if (width >= 1024) {
      const rail = (await page.getByRole('region', { name: 'Discovery criteria', exact: true }).boundingBox())!;
      const dock = (await page.getByRole('region', { name: 'Prepared mission', exact: true }).boundingBox())!;
      expect(rail.y + rail.height, `${width}px internal rail viewport ends before the dock hit region`).toBeLessThanOrEqual(dock.y);
    }
    // This real click must remain reachable after expanded provenance makes the rail scroll.
    await page.getByRole('button', { name: 'Earth observation', exact: true }).click();
    await explore(page, 'SAR imagery over Shannon estuary, maximum resolution 5 m; cloud cover 10%; revisit weekly.');
    await page.getByRole('button', { name: 'Earth observation', exact: true }).click();
    await page.getByRole('combobox', { name: 'Sensor', exact: true }).selectOption('SAR');
    for (const label of ['Sensor', 'Owner country']) {
      const control = page.getByRole('combobox', { name: label, exact: true });
      await expect(control).toBeVisible();
      expect(await control.evaluate(node => {
        const select = node as HTMLSelectElement, style = getComputedStyle(select), canvas = document.createElement('canvas');
        const context = canvas.getContext('2d')!; context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        return context.measureText(select.selectedOptions[0]!.text).width <= select.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 8;
      }), `${width}px ${label} selected value fits its visible control`).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const action = page.getByRole('region', { name: 'Discovery query results', exact: true }).getByRole('button', { name: 'View matches', exact: true });
    await action.focus(); await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Discovery filters', exact: true })).toHaveCount(0);
    await expect(page.locator('#root')).toHaveJSProperty('inert', false);
    await expect(page.getByRole('button', { name: 'Open Estuary SAR 03', exact: true })).toBeInViewport();
    await page.screenshot({ path: info.outputPath(`query-feedback-${width}.png`) });
  }
});

test('unresolved place wording discloses no lookup and retains the deliberate AOI until separately proposed and confirmed @slice-07', async ({ page }) => {
  await page.goto('/'); await chooseDemonstrationCatalog(page);
  const feedback = page.getByRole('region', { name: 'Discovery query results', exact: true });
  await expect(feedback.getByText('No area applied', { exact: true })).toBeVisible();
  await expect(feedback.getByText(/A place label or preview does not place a target/)).toBeVisible();
  await explore(page, 'SAR imagery over Shannon estuary, maximum resolution 10 m.');
  await page.getByRole('button', { name: /Review this mission/ }).click();
  const { panel, catalog } = await circleDatesContact(page);
  const area = panel.getByRole('region', { name: 'Current area and place names', exact: true });
  await expect(area).toContainText('52.6000°, -9.7000° · 25 km radius');
  await expect(area.getByText('Size confirmed', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Keep brief and close', exact: true }).click();
  await expect(panel).toHaveCount(0);
  const question = 'SAR imagery with maximum resolution 10 m; place: Busan Harbor.';
  await explore(page, question);
  await expect(feedback).toContainText('52.6000°, -9.7000° · 25 km radius');
  await expect(feedback.getByText('Size confirmed', { exact: true })).toBeVisible();
  await expect(feedback.getByText('Not resolved from the new description. Apply a proposed location or explicitly keep this existing target for the current question.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Use reviewed filters', exact: true }).click();
  await page.getByRole('button', { name: /Review this mission/ }).click();
  await expect(panel.getByLabel('Mission purpose', { exact: true })).toHaveValue(question);
  await expect(panel.getByLabel('Centre latitude', { exact: true })).toHaveValue('52.6');
  await expect(panel.getByLabel('Centre longitude', { exact: true })).toHaveValue('-9.7');
  await expect(panel.getByLabel('Radius (km)', { exact: true })).toHaveValue('25');
  await expect(panel.getByLabel('Baseline reference date', { exact: true })).toHaveValue(catalog.demo.baselineDate);
  await expect(panel.getByLabel('Contact email', { exact: true })).toHaveValue('local-rules@coastal.example');
  const confirmation = panel.getByRole('checkbox', { name: 'I chose this target and checked the area size.', exact: true });
  await expect(confirmation).toBeChecked();
  await expect(area).toContainText('Not resolved from the new description.');
  await panel.getByLabel('Centre latitude', { exact: true }).fill('53');
  await expect(area).toContainText('52.6000°, -9.7000° · 25 km radius');
  await expect(confirmation).toBeChecked();
  await expect(panel.getByText('UNAPPLIED AREA PROPOSAL', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Use these coordinates', exact: true }).click();
  await expect(area).toContainText('53.0000°, -9.7000° · 25 km radius');
  await expect(area.getByText('Applied · size confirmation needed', { exact: true })).toBeVisible();
  await expect(confirmation).not.toBeChecked();
  await confirmation.check();
  await expect(area.getByText('Size confirmed', { exact: true })).toBeVisible();
  await expect(panel.getByLabel('Mission purpose', { exact: true })).toHaveValue(question);
  await panel.getByRole('button', { name: 'Review request', exact: true }).click();
  await expect(panel.getByText(/This deliberate circle was chosen with drawing or coordinates/)).toBeVisible();
  await expect(panel.getByText('53.0000°, -9.7000°', { exact: true })).toBeVisible();
});
