import { test, expect, type Page } from '@playwright/test';
import type { PublicCatalog, RequestProjection } from '../../shared/contracts.js';
import type { MissionsSnapshot } from '../../shared/tracking.js';
import type { StaffRequestProjection } from '../../shared/workflow.js';
import { areaSignature, createEmptyBrief } from '../../shared/validation.js';
import { createEmptyQuoteDraft } from '../../shared/workflow.js';
import { currentContext, enterCustomer, enterStaff, workflowAction } from './helpers.js';
import { approveAndPublishImages, grant, prepareResult, publishFinding, staffDetail } from './material-helpers.js';

test.setTimeout(180_000);
const requestsPath = '/workspaces/org-a/requests', missionsPath = '/workspaces/org-a/missions';
const plus = (instant: string, hours: number) => new Date(Date.parse(instant) + hours * 3600_000).toISOString();
const localUtc = (instant: string) => instant.slice(0, -1);
function unique(label: string, engine: string) { return `${label} ${engine} ${crypto.randomUUID().slice(0, 8)}`; }
async function detail(page: Page, id: string): Promise<RequestProjection> {
  const response = await page.request.get(`/api/customer/org-a/requests/${id}`);
  expect(response.status(), await response.text()).toBe(200);
  return response.json() as Promise<RequestProjection>;
}
/** Authored inputs pass the actual review/submission endpoints; no saved-state fixture is inserted. */
async function submitManual(page: Page, title: string): Promise<RequestProjection> {
  const context = await currentContext(page), catalogResponse = await page.request.get('/api/public/catalog');
  expect(catalogResponse.status()).toBe(200);
  const catalog = await catalogResponse.json() as PublicCatalog;
  const choice = { latitude: 52.6, longitude: -9.7, radiusKm: 25, method: 'coordinates' as const, generation: 1 };
  const brief = { ...createEmptyBrief(), purpose: title, sensor: 'SAR', maxResolution: '10', latitude: '52.6', longitude: '-9.7', radiusKm: '25', areaChoice: choice, areaConfirmation: areaSignature(choice), baselineDate: catalog.demo.baselineDate, recentDate: catalog.demo.recentDate, timezone: 'UTC', timingToDiscuss: false, windowStart: localUtc(plus(context.serverNow, -72)), windowEnd: localUtc(plus(context.serverNow, 144)), contact: { name: 'Fictional tracking researcher', email: 'tracking@example.test', organization: 'Fictional estuary research team' }, acknowledged: true };
  const envelope = { commandId: crypto.randomUUID(), contextGeneration: context.contextGeneration, contextToken: context.contextToken, target: { organizationId: 'org-a' }, expected: {}, payload: { brief } };
  const headers = { origin: new URL(page.url()).origin, 'x-coruscant-csrf': context.csrfToken! };
  const review = await page.request.post('/api/command-reviews/submitRequest', { headers, data: envelope });
  expect(review.status(), await review.text()).toBe(200);
  const saved = await page.request.post('/api/commands/submitRequest', { headers, data: { ...envelope, reviewToken: (await review.json()).reviewToken } });
  expect(saved.status(), await saved.text()).toBe(201);
  const row = await detail(page, (await saved.json()).requestId);
  expect(row.title).toBe(title); expect(row.status).toBe('Submitted');
  return row;
}
/** Real draft, publication and acceptance commands establish the commercial prerequisites. */
async function acceptRequests(page: Page, rows: RequestProjection[]) {
  await enterStaff(page);
  for (const row of rows) {
    await workflowAction(page, row.id, 'startReview', {}, undefined, false);
    const context = await currentContext(page);
    const draft = await workflowAction(page, row.id, 'saveQuoteDraft', { quote: { ...createEmptyQuoteDraft(), priceType: 'FIXED', amount: '2400.00', scope: 'Supplied synthetic comparison of the explicitly confirmed area and accepted reference dates. No actual acquisition, operator agreement or measured radar analysis.', licence: 'Original Coruscant synthetic scenes, for local demonstration inspection.', validUntil: plus(context.serverNow, 72) } }, undefined, false);
    const response = await page.request.get(`/api/staff/requests/${row.id}`);
    expect(response.status()).toBe(200);
    const current = await response.json() as StaffRequestProjection;
    const savedDraft = current.quoteDrafts.find(quote => quote.id === draft.quoteId)!;
    expect(savedDraft).toBeTruthy();
    await workflowAction(page, row.id, 'publishQuote', { replacesQuoteId: null }, savedDraft);
  }
  await enterCustomer(page);
  const accepted: RequestProjection[] = [];
  for (const row of rows) {
    const offered = await detail(page, row.id);
    await workflowAction(page, row.id, 'acceptQuote', {}, offered.currentQuote!);
    const saved = await detail(page, row.id); expect(saved.status).toBe('Accepted'); accepted.push(saved);
  }
  return accepted;
}
async function recordPlan(page: Page, row: RequestProjection, start: string, end: string) {
  await workflowAction(page, row.id, 'recordInitialSchedule', { acceptedQuoteId: row.acceptedQuote!.id, schedule: { provider: 'Coruscant fictional tracking desk', timezone: 'UTC', start: localUtc(start), end: localUtc(end), trackedItemIds: [], notes: 'Initial staff-recorded demonstration plan; not telemetry or execution.' } });
}
async function rawMissions(page: Page): Promise<MissionsSnapshot> {
  const response = await page.request.get('/api/customer/org-a/missions');
  expect(response.status(), await response.text()).toBe(200);
  return response.json() as Promise<MissionsSnapshot>;
}
function readout(page: Page, label: string) { return page.locator('.mission-readout').filter({ has: page.getByRole('heading', { name: label, exact: true }) }); }
async function expectReadout(page: Page, label: string, count: number) { await expect(readout(page, label).locator('.readout-value')).toHaveText(String(count)); }
async function applySearch(page: Page, text: string, status = '') {
  await page.getByLabel('Reference, service or place', { exact: true }).fill(text);
  await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption(status);
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
}

test('Requests applies explicit filters, literal search and20-row paging; detail and mission keep the exact filtered return @slice-07', async ({ page }, info) => {
  await enterCustomer(page); const prefix = unique('Tracking batch', info.project.name), rows: RequestProjection[] = [];
  for (let index = 0; index < 22; index++) rows.push(await submitManual(page, index === 0 ? `${prefix}%_ literal comparison` : `${prefix} comparison ${String(index).padStart(2, '0')}`));
  await enterStaff(page);
  for (const row of rows.slice(0, 2)) await workflowAction(page, row.id, 'startReview', {}, undefined, false);
  await enterCustomer(page); await page.goto(requestsPath); await applySearch(page, prefix);
  const body = page.locator('.tracking-request-table tbody');
  await expect(body.locator('tr')).toHaveCount(20); await expect(page.locator('.tracking-list-count')).toContainText('22 requests');
  const applied = page.url();
  await page.getByLabel('Reference, service or place', { exact: true }).fill(`${prefix}%_`);
  expect(page.url()).toBe(applied); await expect(body.locator('tr')).toHaveCount(20);
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(body.locator('tr')).toHaveCount(1); await expect(body).toContainText(rows[0]!.reference);
  await applySearch(page, prefix); await expect(body.locator('tr')).toHaveCount(20);
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(body.locator('tr')).toHaveCount(2);
  expect(new URL(page.url()).searchParams.get('search')).toBe(prefix); expect(new URL(page.url()).searchParams.get('page')).toBe('2');
  const pageTwo = page.url(); await page.reload(); await expect(body.locator('tr')).toHaveCount(2); expect(page.url()).toBe(pageTwo);
  const requestLink = body.locator('tr').first().locator('.tracking-title-link'), selectedHref = await requestLink.getAttribute('href');
  await requestLink.click(); await expect(page).toHaveURL(new RegExp('/service-requests/'));
  expect(new URL(page.url()).searchParams.get('returnTo')).toBe(new URL(pageTwo).pathname + new URL(pageTwo).search);
  await page.reload(); await page.getByRole('link', { name: /Back Requests/ }).first().click();
  expect(page.url()).toBe(pageTwo); await expect(body.locator('tr')).toHaveCount(2);
  const mission = body.locator('tr').first().getByRole('link', { name: 'Mission Control view', exact: true });
  const missionHref = await mission.getAttribute('href'); expect(missionHref).not.toBe(selectedHref);
  await mission.click(); await expect(page).toHaveURL(new RegExp('/missions/'));
  await page.getByRole('link', { name: 'Back to request list', exact: true }).click(); expect(page.url()).toBe(pageTwo);
  await page.getByRole('button', { name: 'First page', exact: true }).click(); await expect(body.locator('tr')).toHaveCount(20);
  expect(new URL(page.url()).searchParams.has('page')).toBe(false);
  await applySearch(page, prefix, 'In review'); await expect(body.locator('tr')).toHaveCount(2);
  expect(new URL(page.url()).searchParams.get('status')).toBe('In review');
  for (const invalid of ['status=Cancelled', 'unknown=1']) {
    await page.goto(`${requestsPath}?${invalid}`);
    await expect(page.getByRole('heading', { name: 'Those filters could not be used', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Clear filters', exact: true })).toBeVisible();
    await expect(page.locator('.tracking-request-table')).toHaveCount(0);
  }
  await page.screenshot({ path: info.outputPath('requests-invalid-filter.png') });
});

test('Missions readouts match loaded saved records and five actual clarifications expand beyond the first four @slice-07', async ({ page }, info) => {
  await enterCustomer(page); const prefix = unique('Agenda question', info.project.name), rows: RequestProjection[] = [];
  for (let index = 0; index < 5; index++) rows.push(await submitManual(page, `${prefix} ${index + 1}`));
  await enterStaff(page);
  for (const row of rows) { await workflowAction(page, row.id, 'startReview', {}, undefined, false); await workflowAction(page, row.id, 'askCustomer', { message: `Please clarify the intended use for ${row.title}.` }); }
  await enterCustomer(page); const saved = await rawMissions(page), at = Date.parse(saved.serverNow);
  const attentionCount = saved.requests.filter(row => row.status === 'Needs information' || row.status === 'Quote ready' && !!row.currentQuote || row.status === 'Accepted' && !row.schedule || row.status === 'Scheduled' && !!row.schedule && Date.parse(row.schedule.endUtc) <= at).length;
  const windowCount = saved.requests.filter(row => row.status === 'Scheduled' && !!row.schedule && Date.parse(row.schedule.endUtc) > at).length;
  await page.goto(missionsPath); await expect(page.getByRole('heading', { name: 'Missions', exact: true })).toBeVisible();
  await expect(page.locator('.tracking-scope')).toContainText(`Loaded ${saved.scope.loaded} of ${saved.scope.total} authorized saved requests`);
  await expectReadout(page, 'Missions in view', saved.requests.length); await expectReadout(page, 'Decisions and next steps', attentionCount); await expectReadout(page, 'Upcoming windows', windowCount);
  const panel = page.getByRole('region', { name: 'Decisions & next steps', exact: true });
  await expect(panel.locator('ol > li')).toHaveCount(4);
  const expand = panel.getByRole('button', { name: `Show all ${attentionCount} next steps`, exact: true });
  await expand.focus(); await expand.press('Enter'); await expect(panel.locator('ol > li')).toHaveCount(attentionCount);
  for (const row of rows) await expect(panel.getByRole('link').filter({ hasText: row.title }).first()).toBeVisible();
  await panel.getByRole('button', { name: 'Show fewer next steps', exact: true }).click(); await expect(panel.locator('ol > li')).toHaveCount(4);
  const current = page.getByRole('region', { name: 'Current', exact: true });
  for (const row of rows) await expect(current.locator(`[data-request-id="${row.id}"]`)).toBeVisible();
  await expect(page.getByText('All times UTC', { exact: true })).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: info.outputPath('missions-readouts-and-attention.png') });
});

test('actual acceptance, scheduled and elapsed plans, and manual delivery drive groups with a separate entitled result link @slice-07', async ({ page }, info) => {
  await enterCustomer(page); const prefix = unique('Saved plan', info.project.name), rows: RequestProjection[] = [];
  for (const label of ['awaiting schedule', 'upcoming window', 'elapsed window', 'delivered result']) rows.push(await submitManual(page, `${prefix} ${label}`));
  const accepted = await acceptRequests(page, rows), context = await currentContext(page);
  await enterStaff(page);
  await recordPlan(page, accepted[1]!, plus(context.serverNow, 48), plus(context.serverNow, 50));
  await recordPlan(page, accepted[2]!, plus(context.serverNow, -2), plus(context.serverNow, -1));
  await recordPlan(page, accepted[3]!, plus(context.serverNow, 24), plus(context.serverNow, 26));
  const delivered = accepted[3]!; await page.goto(`/staff/requests/${delivered.id}`);
  const resultTitle = `${prefix} supplied comparison`, resultId = await prepareResult(page, delivered.id, resultTitle);
  await approveAndPublishImages(page, delivered.id); await publishFinding(page, delivered.id); await grant(page, delivered.id);
  expect((await staffDetail(page, delivered.id)).result!.readiness.ready).toBe(true);
  await page.getByLabel('Delivery note', { exact: true }).fill('The reviewed synthetic comparison and finding are supplied for this demonstration. This is not a real collection.');
  await page.getByRole('button', { name: 'Review delivery', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Review delivery', exact: true });
  await review.getByRole('button', { name: 'Confirm record delivery', exact: true }).click(); await expect(review).toHaveCount(0);
  expect((await staffDetail(page, delivered.id)).status).toBe('Delivered');
  await enterCustomer(page); await page.goto(missionsPath);
  const upcoming = page.getByRole('region', { name: 'Upcoming', exact: true }), current = page.getByRole('region', { name: 'Current', exact: true }), past = page.getByRole('region', { name: 'Past', exact: true });
  await expect(upcoming.locator(`[data-request-id="${rows[0]!.id}"]`)).toContainText('Accepted');
  await expect(upcoming.locator(`[data-request-id="${rows[1]!.id}"]`)).toContainText('Scheduled');
  await expect(current.locator(`[data-request-id="${rows[2]!.id}"]`)).toContainText('Planned window elapsed');
  expect((await detail(page, rows[2]!.id)).status).toBe('Scheduled');
  const deliveredRow = past.locator(`[data-request-id="${delivered.id}"]`);
  await expect(deliveredRow).toContainText('Delivered');
  const result = deliveredRow.locator('.mission-row-result').getByRole('link', { name: resultTitle, exact: true });
  await expect(result).toHaveAttribute('href', `/workspaces/org-a/results/${resultId}`);
  await expect(deliveredRow.locator('.mission-row-title a')).toHaveAttribute('href', `/workspaces/org-a/missions/${delivered.id}`);
  await result.focus(); await result.press('Enter'); await expect(page).toHaveURL(new RegExp(`/results/${resultId}$`));
  await expect(page.getByRole('heading', { name: resultTitle, exact: true, level: 1 })).toBeVisible();
  const exactReturn = page.locator(`a[href="/workspaces/org-a/missions/${delivered.id}"]`).first();
  await expect(exactReturn).toBeVisible(); await exactReturn.click(); await expect(page).toHaveURL(new RegExp(`/missions/${delivered.id}$`));
  await expect(page.locator('.page-heading')).toContainText(delivered.title);
  await page.screenshot({ path: info.outputPath('delivered-mission-return.png') });
});

test('partial window details stay unknown and a failed refresh retains the permitted snapshot until real recovery @slice-07', async ({ page }, info) => {
  await enterCustomer(page); const row = await submitManual(page, unique('Partial window', info.project.name));
  const [accepted] = await acceptRequests(page, [row]), at = (await currentContext(page)).serverNow;
  await enterStaff(page); await recordPlan(page, accepted!, plus(at, 36), plus(at, 38)); await enterCustomer(page);
  let mode: 'partial' | 'failure' | 'normal' = 'partial';
  await page.route('**/api/customer/org-a/missions', async route => {
    if (mode === 'failure') { await route.fulfill({ status: 503, contentType: 'application/json', json: { code: 'RETRY_LATER', message: 'The isolated test summary refresh is temporarily unavailable.', retryable: true, correlationId: 'tracking-refresh-check' } }); return; }
    const response = await route.fetch(), value = await response.json() as MissionsSnapshot;
    if (mode === 'partial') { const target = value.requests.find(request => request.id === row.id)!; target.schedule = null; target.detailAvailability.window = 'UNAVAILABLE'; value.completeness = 'PARTIAL'; }
    await route.fulfill({ response, json: value });
  });
  await page.goto(missionsPath);
  await expect(page.getByText('Some quote or window details could not be loaded. Open a mission or refresh', { exact: true })).toBeVisible();
  const unknown = page.getByRole('region', { name: 'Unknown window details', exact: true });
  await expect(unknown.locator(`[data-request-id="${row.id}"]`)).toBeVisible();
  await expect(readout(page, 'Upcoming windows')).toContainText('1 unknown · total incomplete');
  await expect(page.getByRole('heading', { name: 'No missions yet', exact: true })).toHaveCount(0);
  const priorCount = await readout(page, 'Missions in view').locator('.readout-value').textContent();
  mode = 'failure'; await page.getByRole('button', { name: 'Refresh mission summary', exact: true }).click();
  await expect(page.getByText('Mission summary could not be refreshed', { exact: true })).toBeVisible();
  await expect(unknown.locator(`[data-request-id="${row.id}"]`)).toBeVisible();
  await expect(readout(page, 'Missions in view').locator('.readout-value')).toHaveText(priorCount!);
  await page.screenshot({ path: info.outputPath('partial-summary-refresh-retained.png') });
  mode = 'normal'; await page.getByRole('button', { name: 'Refresh mission summary', exact: true }).click();
  await expect(page.getByText('Mission summary could not be refreshed', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Upcoming', exact: true }).locator(`[data-request-id="${row.id}"]`)).toBeVisible();
  await expect(unknown.locator(`[data-request-id="${row.id}"]`)).toHaveCount(0);
  await page.unroute('**/api/customer/org-a/missions');
});

test('Requests retains an unapplied keyboard search while the actual initial list response is pending @slice-07', async ({ page }, info) => {
  await enterCustomer(page);
  const title = unique('Search during initial loading', info.project.name), saved = await submitManual(page, title);
  let releaseInitial!: () => void, markRetained!: () => void;
  const release = new Promise<void>(resolve => { releaseInitial = resolve; });
  const retained = new Promise<void>(resolve => { markRetained = resolve; });
  const endpoint = '**/api/customer/org-a/requests';
  await page.route(endpoint, async route => {
    const response = await route.fetch();
    markRetained();
    await release;
    await route.fulfill({ response });
  });
  try {
    await page.goto(requestsPath);
    await retained;
    await expect(page.getByText('Loading saved requests…', { exact: true })).toBeVisible();
    const search = page.getByLabel('Reference, service or place', { exact: true });
    await search.focus(); await search.fill(title);
    await expect(search).toHaveValue(title);
    const initialResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/customer/org-a/requests' && !new URL(response.url()).search && response.request().method() === 'GET');
    releaseInitial();
    expect((await initialResponse).status()).toBe(200);
    await expect(page.locator('.tracking-request-table')).toBeVisible();
    await expect(page.getByText('Loading saved requests…', { exact: true })).toHaveCount(0);
    await expect(search).toHaveValue(title);
    const filteredResponse = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === '/api/customer/org-a/requests' && url.searchParams.get('search') === title && response.request().method() === 'GET';
    });
    await search.press('Enter');
    await expect(page).toHaveURL(url => url.pathname === requestsPath && url.searchParams.get('search') === title);
    const response = await filteredResponse;
    expect(response.status()).toBe(200);
    const data = await response.json() as { requests: RequestProjection[]; total: number };
    expect(data.total).toBe(1); expect(data.requests.map(request => request.id)).toEqual([saved.id]);
    await expect(page.locator('.tracking-request-table tbody tr')).toHaveCount(1);
    await expect(page.locator('.tracking-request-table tbody')).toContainText(saved.reference);
  } finally {
    releaseInitial();
    await page.unroute(endpoint);
  }
});

test('tracking remains keyboard usable without horizontal overflow at390/768/1024/1440 and keeps phone actions44px @slice-07', async ({ page }, info) => {
  await enterCustomer(page); const title = unique('Responsive saved request', info.project.name); await submitManual(page, title);
  for (const width of [390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 }); await page.goto(requestsPath);
    await expect(page.locator('.tracking-request-table')).toBeVisible();
    await expect(page.getByText('Loading saved requests…', { exact: true })).toHaveCount(0);
    const search = page.getByLabel('Reference, service or place', { exact: true });
    await search.focus(); await search.fill(title); await expect(search).toHaveValue(title); await search.press('Enter');
    await expect(page).toHaveURL(url => url.pathname === requestsPath && url.searchParams.get('search') === title);
    await expect(page.locator('.tracking-request-table tbody tr')).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const apply = await page.getByRole('button', { name: 'Apply filters', exact: true }).boundingBox(); expect(apply!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: info.outputPath(`requests-${width}.png`) });
    await page.goto(missionsPath); await expect(page.getByRole('heading', { name: 'Missions', exact: true })).toBeVisible();
    await expect(page.locator(`.mission-row`).filter({ hasText: title })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const refresh = page.getByRole('button', { name: 'Refresh mission summary', exact: true });
    await refresh.focus(); const response = page.waitForResponse(result => result.url().endsWith('/api/customer/org-a/missions') && result.request().method() === 'GET'); await refresh.press('Enter'); expect((await response).status()).toBe(200);
    await expect(refresh).toBeEnabled();
    if (width === 390) { const action = await page.locator('.mission-row-next a').first().boundingBox(); expect(action!.height).toBeGreaterThanOrEqual(44); }
    await page.screenshot({ path: info.outputPath(`missions-${width}.png`) });
  }
});
