import { expect, type Page } from '@playwright/test';
import type { Context, PublicCatalog, RequestProjection } from '../../shared/contracts.js';
import { createEmptyQuoteDraft, revisionToInput, type StaffRequestProjection, type WorkflowCommandName } from '../../shared/workflow.js';

export async function enterCustomer(page: Page, persona = 'a-owner') {
  await page.goto('/access');
  await page.getByRole('combobox', { name: 'Demonstration customer', exact: true }).selectOption(persona);
  await page.getByRole('button', { name: 'Continue to workspace', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Requests', exact: true })).toBeVisible();
}

export async function enterStaff(page: Page) {
  await page.goto('/staff/login');
  await page.getByRole('button', { name: 'Enter demonstration staff access', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Mission requests', exact: true })).toBeVisible();
}

export async function showDiscoveryList(page: Page) {
  const filters = page.getByRole('dialog', { name: 'Discovery filters', exact: true });
  if (await filters.count()) {
    await filters.getByRole('button', { name: 'Show discoveries', exact: true }).click();
    await expect(filters).toHaveCount(0);
  }
  await expect(page.locator('#root')).toHaveJSProperty('inert', false);
  const list = page.getByRole('button', { name: 'List view', exact: true });
  await list.click();
  await expect(list).toHaveAttribute('aria-pressed', 'true');
}

/** Explicit local reading and manual choices through the real public controls. */
/** Historical demo scenarios deliberately use the ordinary source control; Real remains the app default. */
export async function chooseDemonstrationCatalog(page: Page) {
  const filters = page.getByRole('dialog', { name: 'Discovery filters', exact: true });
  if (await filters.count()) {
    await filters.getByRole('button', { name: 'Show discoveries', exact: true }).click();
    await expect(filters).toHaveCount(0);
  }
  await expect(page.locator('#root')).toHaveJSProperty('inert', false);
  const catalog = page.getByRole('combobox', { name: 'Catalog', exact: true });
  await expect(catalog).toBeVisible();
  await catalog.selectOption('DEMONSTRATION');
  await expect(catalog).toHaveValue('DEMONSTRATION');
}

export async function prepareDiscovery(page: Page, purpose: string) {
  await chooseDemonstrationCatalog(page);
  const description = page.getByLabel('Search satellites and services', { exact: true });
  if (!await description.isVisible()) await page.getByRole('button', { name: 'Discover', exact: true }).click();
  await description.fill(purpose);
  await page.getByRole('button', { name: 'Search catalog only', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Search catalog only', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Earth observation', exact: true }).click();
  await page.getByRole('combobox', { name: 'Sensor', exact: true }).selectOption('SAR');
  await page.getByRole('combobox', { name: 'Max resolution', exact: true }).selectOption('10');
  const filters = page.getByRole('dialog', { name: 'Discovery filters', exact: true });
  if (await filters.count()) { await filters.getByRole('button', { name: 'Show discoveries', exact: true }).click(); await expect(filters).toHaveCount(0); }
  await showDiscoveryList(page);
  const review = page.getByRole('button', { name: 'Use reviewed filters', exact: true });
  if (await review.isVisible()) await review.click();
}

/** The approved public save creates Planning; staff review is a separate same-record action. */
export async function submitSavedPlanning(page: Page) {
  await expect(page.locator('.page-heading').getByText('Planning', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Submit request for review…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Submit Planning request for review', exact: true });
  await dialog.getByRole('checkbox', { name: 'I request staff feasibility review for this brief and workspace. This is not a booking or collection.', exact: true }).check();
  await dialog.getByRole('button', { name: 'Review submission', exact: true }).click();
  await dialog.getByRole('button', { name: 'Submit request for review', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.page-heading').getByText('Submitted', { exact: true })).toBeVisible();
}

/** Fresh inputs submitted through the actual UI, never a pre-completed seed. */
export async function newRequest(page: Page, purpose: string, resolvedWindow = true) {
  await page.goto('/');
  const activeContext = await (await page.request.get('/api/context')).json() as Context;
  if (activeContext.audience === 'CUSTOMER' || activeContext.audience === 'STAFF') {
    const leave = page.getByRole('button', { name: /^Leave demonstration(?: staff)? access$/ });
    await expect(leave).toBeVisible(); await leave.click();
    await expect(page.getByRole('link', { name: 'Customer access', exact: true })).toBeVisible();
  }
  await prepareDiscovery(page, purpose);
  await page.getByRole('button', { name: 'Add Estuary SAR 03 to shortlist', exact: true }).click();
  await page.getByRole('button', { name: /Review this mission/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Your request', exact: true });
  await dialog.getByLabel('Centre latitude', { exact: true }).fill('52.6');
  await dialog.getByLabel('Centre longitude', { exact: true }).fill('-9.7');
  await dialog.getByLabel('Radius (km)', { exact: true }).fill('25');
  await dialog.getByRole('button', { name: 'Use these coordinates', exact: true }).click();
  await dialog.getByRole('checkbox', { name: 'I chose this target and checked the area size.', exact: true }).check();
  const catalog = await (await page.request.get('/api/public/catalog')).json() as PublicCatalog;
  const atDay = (offset: number, time: string) => {
    const date = new Date(catalog.demo.d0);
    date.setUTCDate(date.getUTCDate() + offset);
    return `${date.toISOString().slice(0, 10)}T${time}`;
  };
  const dates = { start: atDay(2, '08:00'), end: atDay(4, '18:00'),
    planStart: atDay(3, '10:00'), planEnd: atDay(3, '12:00'), expiry: atDay(1, '18:00') };
  await dialog.getByRole('radio', { name: 'Baseline–recent comparison', exact: true }).check();
  await dialog.getByLabel('Baseline reference date', { exact: true }).fill(catalog.demo.baselineDate);
  await dialog.getByLabel('Recent reference date', { exact: true }).fill(catalog.demo.recentDate);
  if (resolvedWindow) {
    await dialog.getByRole('checkbox', { name: 'Timing to be discussed', exact: true }).uncheck();
    await dialog.getByLabel('Window start (local)', { exact: true }).fill(dates.start);
    await dialog.getByLabel('Window end (local)', { exact: true }).fill(dates.end);
  }
  await dialog.getByLabel('Contact name', { exact: true }).fill('Demonstration research contact');
  await dialog.getByLabel('Contact email', { exact: true }).fill('comparison@estuary.example');
  await dialog.getByLabel('Organisation name', { exact: true }).fill('Demonstration environmental team');
  const criteriaReview = dialog.getByRole('button', { name: 'Use reviewed filters', exact: true });
  if (await criteriaReview.isVisible()) await criteriaReview.click();
  await dialog.getByRole('button', { name: 'Review request', exact: true }).click();
  await page.getByRole('link', { name: 'Open customer workspace', exact: true }).click();
  await page.getByRole('combobox', { name: 'Demonstration customer', exact: true }).selectOption('a-owner');
  await page.getByRole('button', { name: 'Continue to workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Review request in this workspace', exact: true }).click();
  await page.getByRole('checkbox', { name: 'I confirm this planning brief and destination. This does not request staff review.', exact: true }).check();
  const submit = page.getByRole('button', { name: 'Save planning request', exact: true });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.getByRole('heading', { name: 'Request saved', exact: true })).toBeVisible();
  const reference = (await page.locator('.receipt-reference').textContent())!;
  await page.getByRole('link', { name: 'Open request in Demo Estuary Research', exact: true }).click();
  const id = new URL(page.url()).pathname.split('/').at(-1)!;
  await submitSavedPlanning(page);
  const saved = await (await page.request.get(`/api/customer/org-a/requests/${id}`)).json() as RequestProjection;
  expect(saved.reference).toBe(reference);
  expect(saved.evidence).toEqual(expect.arrayContaining([expect.objectContaining({
    itemId: 'demo-sar-03', evidenceVersion: 'demo-evidence-v1', name: 'Estuary SAR 03', verified: true,
  })]));
  return { id, reference, saved, dates, catalog };
}

export async function currentContext(page: Page): Promise<Context> {
  return (await page.request.get('/api/context')).json() as Promise<Context>;
}

/** Real S2 commands provide the accepted context for later increment tests; no completed state is seeded. */
export async function workflowAction(page: Page, requestId: string, name: WorkflowCommandName, payload: Record<string, unknown>, quote?: { id: string; contentVersion: number }, review = true) {
  const context = await currentContext(page);
  const path = context.audience === 'STAFF' ? `/api/staff/requests/${requestId}` : `/api/customer/${context.organization!.id}/requests/${requestId}`;
  const response = await page.request.get(path); expect(response.status()).toBe(200);
  const row = await response.json() as StaffRequestProjection;
  const data = { commandId: crypto.randomUUID(), contextGeneration: context.contextGeneration, contextToken: context.contextToken,
    target: { requestId, ...(quote ? { quoteId: quote.id } : {}) },
    expected: { requestVersion: row.requestVersion, briefRevision: row.briefRevision, ...(quote ? { quoteContentVersion: quote.contentVersion } : {}) }, payload };
  const headers = { origin: new URL(page.url()).origin, 'x-coruscant-csrf': context.csrfToken! };
  let reviewToken: string | undefined;
  if (review) {
    const reviewed = await page.request.post(`/api/command-reviews/${name}`, { headers, data });
    expect(reviewed.status(), await reviewed.text()).toBe(200);
    reviewToken = (await reviewed.json()).reviewToken;
  }
  const saved = await page.request.post(`/api/commands/${name}`, { headers, data: { ...data, ...(reviewToken ? { reviewToken } : {}) } });
  expect(saved.status(), await saved.text()).toBe(200);
  return saved.json();
}

export async function scheduledRequest(page: Page, purpose: string, mismatch = false) {
  const mission = await newRequest(page, purpose);
  if (mismatch) {
    const brief = revisionToInput(mission.saved.brief);
    const baseline = new Date(`${brief.baselineDate}T00:00:00Z`); baseline.setUTCDate(baseline.getUTCDate() - 1);
    brief.baselineDate = baseline.toISOString().slice(0, 10);
    await workflowAction(page, mission.id, 'reviseBrief', { brief });
  }
  await enterStaff(page);
  const initial = await (await page.request.get(`/api/staff/requests/${mission.id}`)).json() as RequestProjection;
  if (initial.status === 'Submitted') await workflowAction(page, mission.id, 'startReview', {}, undefined, false);
  const quote = { ...createEmptyQuoteDraft(), priceType: 'FIXED', amount: '2400.00',
    scope: 'Demonstration-only SAR/Imagery comparison of the confirmed area and accepted reference dates. Two synthetic scenes and a staff finding, not a new acquisition or operator agreement.',
    licence: 'Original Coruscant synthetic scenes, permitted for local demonstration inspection.', validUntil: mission.dates.expiry };
  const draft = await workflowAction(page, mission.id, 'saveQuoteDraft', { quote }, undefined, false);
  const current = await (await page.request.get(`/api/staff/requests/${mission.id}`)).json() as StaffRequestProjection;
  const savedDraft = current.quoteDrafts.find(item => item.id === draft.quoteId)!;
  await workflowAction(page, mission.id, 'publishQuote', { replacesQuoteId: null }, savedDraft);
  await enterCustomer(page);
  const offered = await (await page.request.get(`/api/customer/org-a/requests/${mission.id}`)).json() as RequestProjection;
  await workflowAction(page, mission.id, 'acceptQuote', {}, offered.currentQuote!);
  await enterStaff(page);
  await workflowAction(page, mission.id, 'recordInitialSchedule', { acceptedQuoteId: offered.currentQuote!.id,
    schedule: { provider: 'Coruscant demonstration planning team', timezone: 'UTC', start: mission.dates.planStart, end: mission.dates.planEnd, trackedItemIds: [], notes: 'Initial recorded plan only; no operator agreement or execution.' } });
  await page.goto(`/staff/requests/${mission.id}`);
  await expect(page.locator('.page-heading').getByText('Scheduled', { exact: true })).toBeVisible();
  return mission;
}
