import { test, expect, type Locator, type Page } from '@playwright/test';
import type { RequestProjection } from '../../shared/contracts.js';
import type { NormalizedOMM, OrbitalBrowsePage, RealCatalogDetail, RealCatalogPage } from '../../shared/orbital-contracts.js';
import type { AssessmentPage } from '../../shared/plan-contracts.js';
import { emptyDiscoveryValues } from '../../shared/discovery.js';
import { createEmptyQuoteDraft, type StaffRequestProjection } from '../../shared/workflow.js';
import { createPropagator, lookAngles, observerAt } from '../../server/orbital/propagation.js';
import { solarElevationDeg } from '../../server/orbital/constraints.js';
import { currentContext, enterCustomer, enterStaff, showDiscoveryList, workflowAction } from './helpers.js';

test.setTimeout(120_000);
const panelFor = (page: Page) => page.getByRole('dialog', { name: 'Your request', exact: true });
const caseName = (label: string, engine: string) => `${label} ${engine} ${crypto.randomUUID().slice(0, 8)}`;
const iso = (value: number) => new Date(value).toISOString();
async function linkedError(input: Locator, text: string) {
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  const described = (await input.getAttribute('aria-describedby'))!.split(/\s+/), errorId = described.at(-1)!;
  expect(described.length).toBeGreaterThanOrEqual(2);
  const error = input.page().locator(`[id="${errorId}"]`);
  await expect(error).toBeVisible(); await expect(error).toContainText(text);
  return errorId;
}
async function bodyPost(page: Page, path: string, body: Record<string, unknown>) {
  const context = await currentContext(page);
  return page.request.post(path, { headers: { origin: new URL(page.url()).origin, 'x-coruscant-csrf': context.csrfToken! }, data: { ...body, contextGeneration: context.contextGeneration, contextToken: context.contextToken } });
}
/** No workflow state is seeded. The provider double's actual SGP4 output chooses
 * an observer beneath a future position, then the normal UI asks the real job. */
async function prepareRealTarget(page: Page, title: string, withoutRenderer = false) {
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
async function finishWindow(panel: Locator, at: number) {
  await panel.getByRole('checkbox', { name: 'Timing to be discussed', exact: true }).uncheck();
  await panel.getByLabel('Window start (local)', { exact: true }).fill(iso(at - 10_000).slice(0, -1));
  await panel.getByLabel('Window end (local)', { exact: true }).fill(iso(at + 10_000).slice(0, -1));
}
async function selectProvisional(panel: Locator) {
  const option = panel.getByRole('article', { name: /Planning option SENTINEL-1C/ }).first();
  await expect(option).toBeVisible();
  await expect(option).toContainText('Geometric candidate — requirements unresolved');
  await expect(option.getByRole('button', { name: 'Use this plan', exact: true })).toBeDisabled();
  for (const check of await option.getByRole('checkbox').all()) await check.check();
  await option.getByRole('button', { name: 'Use this plan', exact: true }).click();
  await expect(panel.getByRole('region', { name: 'Locally selected proposed plan', exact: true })).toBeVisible();
  return option;
}
async function saveFromPublic(page: Page) {
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

test('automatic assessment waits for the confirmed target and real future window, preserves focus, and saves an acknowledged provisional plan through both access rotations @slice-10', async ({ page }, info) => {
  const starts: Record<string, unknown>[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/orbital-assessments') starts.push(request.postDataJSON()); });
  const { panel, at } = await prepareRealTarget(page, caseName('SAR imagery for a fresh tentative observation', info.project.name));
  await expect(panel.getByRole('region', { name: 'Missing planning inputs', exact: true })).toContainText('explicit planning window');
  expect(starts).toHaveLength(0);
  await panel.getByLabel('Contact email', { exact: true }).fill('unfinished@');
  await finishWindow(panel, at);
  await expect(panel.getByLabel('Window end (local)', { exact: true })).toBeFocused();
  await expect(panel.getByRole('article', { name: /Planning option SENTINEL-1C/ }).first()).toBeVisible();
  await expect(panel.getByLabel('Window end (local)', { exact: true })).toBeFocused();
  expect(starts).toHaveLength(1);
  const latest = starts[0] as { brief: { observationIntent: string; baselineDate: string; recentDate: string } };
  expect(latest.brief.observationIntent).toBe('single-observation'); expect(latest.brief.baselineDate).toBe(''); expect(latest.brief.recentDate).toBe('');
  await expect(panel.getByLabel('Contact email', { exact: true })).toHaveValue('unfinished@');
  await panel.getByLabel('Contact email', { exact: true }).fill('');
  await selectProvisional(panel);
  const saved = await saveFromPublic(page);
  expect(saved.status).toBe('Planning'); expect(saved.submittedAt).toBeNull(); expect(saved.originalSubmittedContact).toBeNull(); expect(saved.schedule).toBeNull(); expect(saved.currentQuote).toBeNull();
  expect(saved.currentProposedPlan?.version).toBe(1); expect(saved.currentProposedPlan?.option.outcome).toBe('PROVISIONAL');
  expect(saved.currentProposedPlan?.acknowledgedUnknownIds).toEqual(expect.arrayContaining(saved.currentProposedPlan!.option.unknowns.map(unknown => unknown.id)));
  expect(saved.currentProposedPlan?.selectedAtUtc).toBeNull(); expect(saved.currentProposedPlan?.assumptions).toEqual([]);
  await page.getByRole('link', { name: 'Open request in Demo Estuary Research', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Saved proposed plans', exact: true })).toContainText('Plan version 1');
  await page.reload(); await expect(page.getByRole('region', { name: 'Saved proposed plans', exact: true })).toContainText(saved.currentProposedPlan!.digest);
  const savedPlan = page.getByRole('region', { name: 'Saved proposed plans', exact: true });
  await savedPlan.getByText('As-calculated orbit and timing evidence', { exact: true }).click();
  await expect(savedPlan).toContainText(saved.currentProposedPlan!.option.sourceOrbit.sourceEpoch!);
  await expect(savedPlan).toContainText(saved.currentProposedPlan!.option.sourceOrbit.retrievedAt!);
  await expect(savedPlan).toContainText(saved.currentProposedPlan!.option.los.peakUtc);
  await expect(savedPlan).toContainText(saved.currentProposedPlan!.assessment.manifestDigest);
  await page.screenshot({ path: info.outputPath('saved-provisional-planning.png') });
});

test('an obsolete held assessment cannot restore options after a current known sensor mismatch completes @slice-10', async ({ page }, info) => {
  const { panel, at } = await prepareRealTarget(page, caseName('SAR imagery current generation check', info.project.name));
  let release!: () => void, held!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; }), retained = new Promise<void>(resolve => { held = resolve; });
  let first = true;
  await page.route('**/api/orbital-assessments', async route => {
    if (!first) { await route.continue(); return; }
    first = false; const response = await route.fetch(); held(); await hold; await route.fulfill({ response }).catch(() => {});
  });
  try {
    await finishWindow(panel, at); await retained;
    await panel.getByRole('combobox', { name: 'Sensor', exact: true }).selectOption('VISIBLE');
    await expect(panel.getByRole('region', { name: 'Missing planning inputs', exact: true })).toContainText('Review conflicting fields');
    await expect(panel.getByRole('region', { name: 'Missing planning inputs', exact: true })).not.toContainText('Enter an explicit planning window');
    await panel.getByRole('button', { name: 'Use reviewed filters', exact: true }).click();
    await expect(panel.getByRole('heading', { name: 'No eligible candidates', exact: true })).toBeVisible();
    release();
    await expect(panel.getByRole('article', { name: /Planning option/ })).toHaveCount(0);
    await expect(panel.getByRole('combobox', { name: 'Sensor', exact: true })).toHaveValue('VISIBLE');
    await expect(panel.getByRole('region', { name: 'Locally selected proposed plan', exact: true })).toHaveCount(0);
    await expect(panel.getByRole('heading', { name: 'No eligible candidates', exact: true })).toBeVisible();
  } finally { release(); await page.unroute('**/api/orbital-assessments'); }
});

test('same-input Retry rejects held old outcomes, selected-position and cancel replies while ordinary cancellation still acknowledges @slice-10', async ({ page }, info) => {
  const { panel, at } = await prepareRealTarget(page, caseName('SAR imagery same-input retry proof', info.project.name));
  await finishWindow(panel, at);
  const options = panel.getByRole('article', { name: /Planning option SENTINEL-1C/ });
  await expect(options.first()).toBeVisible();
  let heldKind: 'OUTCOMES' | 'VIEW' | null = null;
  let release!: () => void, markHeld!: () => void;
  let gate = Promise.resolve(), held = Promise.resolve();
  const heldIds: string[] = [];
  const arm = (kind: 'OUTCOMES' | 'VIEW') => {
    heldKind = kind;
    gate = new Promise<void>(resolve => { release = resolve; });
    held = new Promise<void>(resolve => { markHeld = resolve; });
  };
  await page.route('**/api/orbital-assessments/status', async route => {
    const input = route.request().postDataJSON() as { assessmentId: string; kind?: string; optionId?: string };
    if (!(heldKind === 'OUTCOMES' && input.kind === 'OUTCOMES' || heldKind === 'VIEW' && !!input.optionId)) { await route.continue(); return; }
    heldKind = null;
    const thisGate = gate, response = await route.fetch();
    expect(response.status()).toBe(200); heldIds.push(input.assessmentId); markHeld();
    await thisGate; await route.fulfill({ response }).catch(() => {});
  });
  const retryAndComplete = async () => {
    const start = page.waitForResponse(response => new URL(response.url()).pathname === '/api/orbital-assessments' && response.request().method() === 'POST');
    await panel.getByRole('button', { name: 'Calculate current evidence again', exact: true }).click();
    const response = await start; expect(response.status()).toBe(200);
    const calculation = await response.json() as AssessmentPage;
    await expect(options.first()).toBeVisible();
    return calculation;
  };
  const flushRenderedResponse = async () => { await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); };
  try {
    await panel.getByText('Source epochs, calculation limits and per-object outcomes', { exact: true }).click();
    arm('OUTCOMES');
    await panel.getByRole('button', { name: 'Inspect object outcomes', exact: true }).click(); await held;
    const second = await retryAndComplete(); expect(second.handle.assessmentId).not.toBe(heldIds[0]);
    const oldOutcomes = page.waitForResponse(response => new URL(response.url()).pathname === '/api/orbital-assessments/status' && response.request().postDataJSON().kind === 'OUTCOMES');
    release(); await (await oldOutcomes).finished(); await flushRenderedResponse();
    await expect(panel).toBeVisible(); await expect(options.first()).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Back to planning options', exact: true })).toHaveCount(0);

    arm('VIEW');
    await options.first().getByRole('button', { name: 'View predicted position', exact: true }).click(); await held;
    const third = await retryAndComplete(); expect(third.handle.assessmentId).not.toBe(heldIds[1]);
    const oldView = page.waitForResponse(response => new URL(response.url()).pathname === '/api/orbital-assessments/status' && !!response.request().postDataJSON().optionId);
    release(); await (await oldView).finished(); await flushRenderedResponse();
    await expect(panel).toBeVisible(); await expect(options.first()).toBeVisible();
    await expect(page.getByText(/^Assessment view at .* — paused$/)).toHaveCount(0);
    await expect(panel.getByRole('region', { name: 'Locally selected proposed plan', exact: true })).toHaveCount(0);
    await expect(panel.getByLabel('Maximum ground resolution', { exact: true })).toHaveValue('10');
    // Hold real polling replies so the initial QUEUED projection stays inspectable.
    // Cancellation may legitimately acknowledge either canceled or already complete.
    let holdPolling = true;
    const pollReleases: Array<() => void> = [];
    const releasePolling = () => { holdPolling = false; for (const resolve of pollReleases.splice(0)) resolve(); };
    await page.route('**/api/orbital-assessments/status', async route => {
      const input = route.request().postDataJSON() as { kind?: string; optionId?: string };
      if (!holdPolling || input.kind !== 'OPTIONS' || input.optionId) { await route.continue(); return; }
      const response = await route.fetch();
      await new Promise<void>(resolve => pollReleases.push(resolve));
      await route.fulfill({ response }).catch(() => {});
    });
    const startFresh = async () => {
      const response = page.waitForResponse(value => new URL(value.url()).pathname === '/api/orbital-assessments' && value.request().method() === 'POST');
      await panel.getByRole('button', { name: /^(?:Calculate current evidence again|Start a new calculation)$/, exact: true }).click();
      const value = await response; expect(value.status()).toBe(200);
      return await value.json() as AssessmentPage;
    };
    let releaseCancel: (() => void) | undefined;
    try {
      const ordinary = await startFresh();
      await expect(panel.getByRole('button', { name: 'Cancel calculation', exact: true })).toBeVisible();
      const acknowledged = page.waitForResponse(value => new URL(value.url()).pathname === '/api/orbital-assessments/cancel' && value.request().postDataJSON().assessmentId === ordinary.handle.assessmentId);
      await panel.getByRole('button', { name: 'Cancel calculation', exact: true }).click();
      expect((await acknowledged).status()).toBe(200);
      await expect(panel.getByText(/^Cancellation requested\./)).toHaveCount(0);
      await expect(panel.getByRole('button', { name: /^(?:Calculate current evidence again|Start a new calculation)$/, exact: true })).toBeVisible();
      releasePolling();

      holdPolling = true;
      const toCancel = await startFresh();
      await expect(panel.getByRole('button', { name: 'Cancel calculation', exact: true })).toBeVisible();
      let markCancel!: () => void, holdFirst = true;
      const canceledHeld = new Promise<void>(resolve => { markCancel = resolve; });
      const cancelGate = new Promise<void>(resolve => { releaseCancel = resolve; });
      await page.route('**/api/orbital-assessments/cancel', async route => {
        if (!holdFirst || route.request().postDataJSON().assessmentId !== toCancel.handle.assessmentId) { await route.continue(); return; }
        holdFirst = false;
        const response = await route.fetch(); expect(response.status()).toBe(200); markCancel();
        await cancelGate; await route.fulfill({ response }).catch(() => {});
      });
      await panel.getByRole('button', { name: 'Cancel calculation', exact: true }).click(); await canceledHeld;
      await expect(panel.getByText(/^Cancellation requested\./)).toBeVisible();
      const current = await startFresh(); expect(current.handle.assessmentId).not.toBe(toCancel.handle.assessmentId);
      releasePolling(); await expect(options.first()).toBeVisible();
      const oldCancel = page.waitForResponse(value => new URL(value.url()).pathname === '/api/orbital-assessments/cancel' && value.request().postDataJSON().assessmentId === toCancel.handle.assessmentId);
      releaseCancel!(); await (await oldCancel).finished(); await flushRenderedResponse();
      await expect(options.first()).toBeVisible();
      await expect(panel.getByText(/^Cancellation requested\./)).toHaveCount(0);
      const inspect = panel.getByRole('button', { name: 'Inspect object outcomes', exact: true });
      if (!await inspect.isVisible()) await panel.getByText('Source epochs, calculation limits and per-object outcomes', { exact: true }).click();
      const currentInspection = page.waitForRequest(value => new URL(value.url()).pathname === '/api/orbital-assessments/status' && value.postDataJSON().kind === 'OUTCOMES');
      await inspect.click();
      expect((await currentInspection).postDataJSON().assessmentId).toBe(current.handle.assessmentId);
    } finally {
      releaseCancel?.(); releasePolling();
      await page.unroute('**/api/orbital-assessments/cancel');
      await page.unroute('**/api/orbital-assessments/status');
    }

  } finally { release?.(); await page.unroute('**/api/orbital-assessments/status'); }
});

test('an unchanged private option creates a plan version without changing the published offer, and acceptance freezes the actual reviewed plan @slice-10', async ({ page }, info) => {
  const { panel, at } = await prepareRealTarget(page, caseName('SAR imagery private version proof', info.project.name));
  await finishWindow(panel, at); await selectProvisional(panel);
  const initial = await saveFromPublic(page);
  await page.goto(`/workspaces/org-a/service-requests/${initial.id}`);
  await page.getByRole('button', { name: 'Submit request for review…', exact: true }).click();
  const submission = page.getByRole('dialog', { name: 'Submit Planning request for review', exact: true });
  await submission.getByLabel('Contact name', { exact: true }).fill('Fictional plan reviewer');
  await submission.getByLabel('Contact email', { exact: true }).fill('plan-review@example.test');
  await submission.getByLabel('Organisation name', { exact: true }).fill('Fictional plan test organization');
  await submission.getByRole('checkbox', { name: 'I request staff feasibility review for this brief and workspace. This is not a booking or collection.', exact: true }).check();
  await submission.getByRole('button', { name: 'Review submission', exact: true }).click();
  await submission.getByRole('button', { name: 'Submit request for review', exact: true }).click();
  await expect(submission).toHaveCount(0);
  await enterStaff(page); await workflowAction(page, initial.id, 'startReview', {}, undefined, false);
  const context = await currentContext(page);
  const draft = await workflowAction(page, initial.id, 'saveQuoteDraft', { quote: { ...createEmptyQuoteDraft(), priceType: 'FIXED', amount: '3100.00', scope: 'Fictional feasibility offer for the saved single-observation planning question. No imagery supply, booking or execution is promised.', licence: 'Terms for fictional planning review only.', validUntil: iso(Date.parse(context.serverNow) + 72 * 3600_000) } }, undefined, false);
  const staffResponse = await page.request.get(`/api/staff/requests/${initial.id}`); expect(staffResponse.status()).toBe(200);
  const staff = await staffResponse.json() as StaffRequestProjection;
  await workflowAction(page, initial.id, 'publishQuote', { replacesQuoteId: null }, staff.quoteDrafts.find(quote => quote.id === draft.quoteId)!);
  await enterCustomer(page); await page.goto(`/workspaces/org-a/service-requests/${initial.id}`);
  const before = await (await page.request.get(`/api/customer/org-a/requests/${initial.id}`)).json() as RequestProjection;
  await page.getByRole('button', { name: 'Inspect technical planning options', exact: true }).click();
  const options = page.getByRole('dialog', { name: 'Your request · Proposed plan', exact: true });
  await selectProvisional(options);
  await options.getByRole('button', { name: 'Save proposed plan', exact: true }).click();
  await expect(options.getByRole('heading', { name: 'Review proposed plan', exact: true })).toBeVisible();
  const planAttempts: unknown[] = [];
  await page.route('**/api/commands/saveProposedPlan', async route => {
    planAttempts.push(route.request().postDataJSON());
    if (planAttempts.length === 1) {
      const response = await route.fetch(); expect(response.status()).toBe(200);
      await route.abort('failed');
    } else await route.continue();
  });
  await options.getByRole('button', { name: 'Save proposed plan', exact: true }).click();
  await expect(options.getByRole('button', { name: 'Retry same proposed-plan save', exact: true })).toBeEnabled();
  await expect(options.getByRole('button', { name: 'Keep brief without this plan', exact: true })).toHaveCount(0);
  await options.getByRole('button', { name: 'Close Your request · Proposed plan', exact: true }).click();
  await page.getByRole('dialog', { name: 'Keep your private draft?', exact: true }).getByRole('button', { name: 'Keep draft and continue', exact: true }).click();
  await expect(options).toHaveCount(0);
  await page.getByRole('button', { name: 'Refresh request', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Saved proposed plans', exact: true })).toContainText('Plan version 2');
  const updated = await (await page.request.get(`/api/customer/org-a/requests/${initial.id}`)).json() as RequestProjection;
  expect(updated.currentProposedPlan?.version).toBe(2); expect(updated.briefRevision).toBe(before.briefRevision);
  expect(updated.currentQuote).toEqual(before.currentQuote); expect(updated.status).toBe('Quote ready'); expect(updated.schedule).toBeNull();
  await page.getByRole('button', { name: 'Accept quote…', exact: true }).click();
  const acceptance = page.getByRole('dialog', { name: 'Confirm acceptance', exact: true });
  await expect(acceptance.getByRole('heading', { name: 'Tentative plan included in acceptance', exact: true })).toBeVisible();
  await expect(acceptance).toContainText(updated.currentProposedPlan!.digest);
  await acceptance.getByRole('button', { name: 'Confirm acceptance', exact: true }).click(); await expect(acceptance).toHaveCount(0);
  const accepted = await (await page.request.get(`/api/customer/org-a/requests/${initial.id}`)).json() as RequestProjection;
  expect(accepted.acceptedPlan?.plan?.id).toBe(updated.currentProposedPlan!.id); expect(accepted.schedule).toBeNull();
  await expect(page.getByRole('button', { name: 'Inspect technical planning options', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Recover proposed-plan save…', exact: true })).toBeVisible();
  await page.getByRole('region', { name: 'Saved proposed plans', exact: true }).getByRole('button', { name: 'Retry same proposed-plan save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Recover proposed-plan save…', exact: true })).toHaveCount(0);
  expect(planAttempts).toHaveLength(2); expect(planAttempts[1]).toEqual(planAttempts[0]);
  const recovered = await (await page.request.get(`/api/customer/org-a/requests/${initial.id}`)).json() as RequestProjection;
  expect(recovered.status).toBe('Accepted'); expect(recovered.currentProposedPlan?.version).toBe(2);
  expect(recovered.acceptedPlan).toEqual(accepted.acceptedPlan); expect(recovered.requestVersion).toBe(accepted.requestVersion);
  await page.unroute('**/api/commands/saveProposedPlan');
  await page.reload(); await expect(page.getByRole('heading', { name: 'Accepted tentative-plan snapshot', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Saved proposed plans', exact: true })).toContainText(updated.currentProposedPlan!.digest);
});

test('explicit predicted-opportunity view shares one UTC, preserves the area and returns the prior browsing snapshot without Follow or shortlist changes @slice-10', async ({ page }, info) => {
  const { panel, at, target, browsingUtc } = await prepareRealTarget(page, caseName('SAR imagery checked position view', info.project.name));
  await finishWindow(panel, at);
  const option = panel.getByRole('article', { name: /Planning option SENTINEL-1C/ }).first(); await expect(option).toBeVisible();
  const checkedView = page.waitForResponse(response => new URL(response.url()).pathname === '/api/orbital-assessments/status' && !!response.request().postDataJSON().optionId);
  await option.getByRole('button', { name: 'View predicted position', exact: true }).click();
  const checked = await (await checkedView).json() as AssessmentPage;
  await expect(panel).toHaveCount(0);
  const stage = page.getByRole('region', { name: 'Real orbital prediction', exact: true });
  await expect(stage.getByText(/^Assessment view at .* — paused$/)).toBeVisible();
  expect(await stage.getAttribute('data-represented-utc')).not.toBe(browsingUtc);
  await expect(stage.getByRole('button', { name: 'Stop following', exact: true })).toHaveCount(0);
  await expect(stage.getByRole('button', { name: 'Update predicted time to now', exact: true })).toBeDisabled();
  await expect(stage.locator('.globe-drawing-status')).not.toContainText('Calculating');
  await stage.getByRole('button', { name: 'Orbit details', exact: true }).click();
  const orbitDetails = stage.getByRole('region', { name: 'Real orbit details', exact: true });
  if (checked.selectedView?.arc) {
    await expect(orbitDetails).toContainText(`Assessment arc ${checked.selectedView.arc.startUtc} → ${checked.selectedView.arc.endUtc}`);
    await expect(orbitDetails).toContainText(`${checked.selectedView.arc.sourceCadenceSeconds}s source samples · ${checked.selectedView.arc.displayStepSeconds}s drawing step`);
  } else await expect(orbitDetails).toContainText('Checked opportunity arc unavailable; no ordinary path is substituted.');
  await expect(page.getByRole('button', { name: 'Shortlist (0)', exact: true })).toBeVisible();
  await stage.getByRole('button', { name: 'Return to browsing snapshot', exact: true }).click();
  await expect(stage).toHaveAttribute('data-represented-utc', browsingUtc!);
  await expect(stage.getByRole('button', { name: 'Update predicted time to now', exact: true })).toBeEnabled();
  await expect(stage.getByText(/^Assessment view at /)).toHaveCount(0);
  await page.getByRole('button', { name: /Review this mission/ }).click();
  await expect(panelFor(page).getByLabel('Centre latitude', { exact: true })).toHaveValue(String(target.latitude));
  await expect(panelFor(page).getByRole('checkbox', { name: 'I chose this target and checked the area size.', exact: true })).toBeChecked();
});

test('actual tentative options remain keyboard usable at390/768/1024/1440 without WebGL or horizontal overflow @slice-10', async ({ page }, info) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(this: HTMLCanvasElement, kind, ...args) {
      return kind === 'webgl2' ? null : Reflect.apply(original, this, [kind, ...args]);
    } as typeof original;
  });
  const { panel, at } = await prepareRealTarget(page, caseName('SAR imagery renderer-independent plan', info.project.name), true);
  await panel.getByRole('checkbox', { name: 'Timing to be discussed', exact: true }).uncheck();
  const start = panel.getByLabel('Window start (local)', { exact: true });
  await start.fill('not-an-instant');
  await panel.getByLabel('Window end (local)', { exact: true }).fill(iso(at + 10_000).slice(0, -1));
  await panel.getByRole('button', { name: 'Review request', exact: true }).click();
  await expect(start).toHaveAttribute('aria-invalid', 'true');
  await expect(start).toHaveAttribute('aria-describedby', 'error-windowStart');
  await expect(panel.locator('#error-windowStart')).toBeVisible();
  await start.fill(iso(at - 10_000).slice(0, -1));
  await expect(start).toHaveAttribute('aria-invalid', 'false');
  const option = panel.getByRole('article', { name: /Planning option SENTINEL-1C/ }).first();
  await expect(option).toBeVisible();
  await page.setViewportSize({ width: 390, height: 1000 });
  const optionTime = option.getByLabel('Proposed checked instant (UTC)', { exact: true });
  await optionTime.fill('not-an-instant');
  const timeError = await linkedError(optionTime, 'complete UTC instant');
  await expect(option.getByRole('button', { name: 'Use this plan', exact: true })).toBeDisabled();
  expect(await panel.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('plan-time-error-390.png') });
  await optionTime.fill('');
  await expect(optionTime).toHaveAttribute('aria-invalid', 'false');
  expect(await optionTime.getAttribute('aria-describedby')).not.toContain(timeError);
  await expect(panel.locator(`[id="${timeError}"]`)).toHaveCount(0);
  await option.getByText('Optional personal processing assumption', { exact: true }).click();
  const processing = option.getByLabel('Assumed processing hours (optional)', { exact: true });
  const explanation = option.getByLabel('Why you entered this assumption', { exact: true });
  await processing.fill('not-hours');
  await linkedError(processing, 'finite number');
  await processing.fill('1');
  await expect(processing).toHaveAttribute('aria-invalid', 'false');
  const assumptionError = await linkedError(explanation, 'explain this personal assumption');
  await explanation.fill('An explicitly entered fictional personal processing assumption, not a provider estimate.');
  await expect(explanation).toHaveAttribute('aria-invalid', 'false');
  await expect(panel.locator(`[id="${assumptionError}"]`)).toHaveCount(0);
  for (const width of [390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await panel.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    const bounds = await panel.boundingBox(); expect(bounds!.width).toBeLessThanOrEqual(Math.min(680, width));
    for (const check of await option.getByRole('checkbox').all()) {
      await expect(check).toHaveAccessibleName(/^I acknowledge:/);
      if (!await check.isChecked()) { await check.focus(); await check.press('Space'); await expect(check).toBeChecked(); }
    }
    const use = option.getByRole('button', { name: /^Use this plan(?: again)?$/, exact: true });
    await expect(use).toBeEnabled(); expect((await use.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await use.focus(); await use.press('Enter');
    const save = panel.getByRole('button', { name: 'Save proposed plan', exact: true });
    await expect(save).toBeEnabled(); await save.focus(); await expect(save).toBeFocused();
    expect((await save.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await option.getByRole('heading', { name: /SENTINEL-1C/ }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`tentative-options-no-webgl-${width}.png`) });
  }
  await panel.getByRole('button', { name: 'Save proposed plan', exact: true }).focus();
  await panel.getByRole('button', { name: 'Save proposed plan', exact: true }).press('Enter');
  await expect(panel.getByRole('heading', { name: 'Save your planning request', exact: true })).toBeVisible();
  await expect(panel.getByRole('link', { name: 'Open customer workspace', exact: true })).toBeVisible();
  await expect(panel).toContainText('Selected tentative plan — needs fresh review');
});


/** Use the generated provider double's actual epoch and freshly computed geometry.
 * No canned outcome, reference fixture or calculation response is substituted. */
async function daylightBoundary(page: Page) {
  const response = await page.request.get('/api/public/real-catalog/norad:62261'); expect(response.status()).toBe(200);
  const detail = await response.json() as RealCatalogDetail;
  const epoch = detail.item.orbit.epoch!;
  expect(epoch).toBeTruthy();
  const omm: NormalizedOMM = {
    OBJECT_NAME: detail.item.name, OBJECT_ID: '2024-235A', EPOCH: epoch, NORAD_CAT_ID: '62261',
    CENTER_NAME: 'EARTH', REF_FRAME: 'TEME', TIME_SYSTEM: 'UTC', MEAN_ELEMENT_THEORY: 'SGP4',
    MEAN_MOTION: 14.6, ECCENTRICITY: .001, INCLINATION: 63, RA_OF_ASC_NODE: 62261 % 360,
    ARG_OF_PERICENTER: 41, MEAN_ANOMALY: 62261 % 360, EPHEMERIS_TYPE: 0,
    CLASSIFICATION_TYPE: 'U', ELEMENT_SET_NO: 1, REV_AT_EPOCH: 1,
    BSTAR: .00001, MEAN_MOTION_DOT: .000001, MEAN_MOTION_DDOT: 0,
  };
  const propagator = createPropagator(omm), start = Date.parse(detail.serverNow) + 15 * 60_000;
  const subsolar = (at: number) => { const point = propagator.at(iso(at)); expect(point.ok).toBe(true); if (!point.ok) throw new Error(point.reason); return { point, sun: solarElevationDeg(iso(at), point.geodetic.latitude, point.geodetic.longitude)! }; };
  let previous = subsolar(start);
  for (let right = start + 60_000; right <= start + 6 * 3600_000; right += 60_000) {
    const next = subsolar(right);
    if (Math.sign(previous.sun) !== Math.sign(next.sun)) {
      let low = right - 60_000, high = right, sign = Math.sign(previous.sun);
      while (high - low > 1) { const middle = Math.floor((low + high) / 2); if (Math.sign(subsolar(middle).sun) === sign) low = middle; else high = middle; }
      const at = high, target = subsolar(at).point.geodetic, observer = observerAt(target.latitude, target.longitude);
      const times = [at - 90_000, at + 90_000].map(time => {
        const point = propagator.at(iso(time)); if (!point.ok) throw new Error(point.reason);
        return { time, sun: solarElevationDeg(iso(time), target.latitude, target.longitude)!, elevation: lookAngles(point.ecfKm, observer)!.elevationDeg };
      });
      const pass = times.find(value => value.sun > .11 && value.elevation > 10), fail = times.find(value => value.sun < -.11 && value.elevation > 10);
      if (pass && fail) return { at, target, pass: pass.time, fail: fail.time };
    }
    previous = next;
  }
  throw new Error('The freshly generated orbit did not expose a bounded daylight crossing with both checked instants in LOS.');
}

test('edited instants automatically replace actual daylight checks, clear earlier acknowledgements, and allow only the newly checked plan @slice-10 @edited-time', async ({ page }, info) => {
  const { panel } = await prepareRealTarget(page, caseName('SAR imagery in daylight for an explicit checked target', info.project.name));
  const boundary = await daylightBoundary(page);
  await panel.getByLabel('Centre latitude', { exact: true }).fill(String(boundary.target.latitude));
  await panel.getByLabel('Centre longitude', { exact: true }).fill(String(boundary.target.longitude));
  await panel.getByRole('button', { name: 'Use these coordinates', exact: true }).click();
  await panel.getByRole('checkbox', { name: 'I chose this target and checked the area size.', exact: true }).check();
  await panel.getByRole('checkbox', { name: 'Timing to be discussed', exact: true }).uncheck();
  await panel.getByLabel('Window start (local)', { exact: true }).fill(iso(boundary.at - 100_000).slice(0, -1));
  await panel.getByLabel('Window end (local)', { exact: true }).fill(iso(boundary.at + 100_000).slice(0, -1));
  const option = panel.getByRole('article', { name: /Planning option SENTINEL-1C/ }).first();
  await expect(option).toBeVisible();
  const checks = option.getByText('Named checks, evidence and model assumptions', { exact: true }); await checks.click();
  await expect(option.getByText('Requested daylight condition · BOUNDARY UNCERTAIN', { exact: true })).toBeVisible();
  for (const checkbox of await option.getByRole('checkbox').all()) await checkbox.check();
  const use = option.getByRole('button', { name: 'Use this plan', exact: true }), time = option.getByLabel('Proposed checked instant (UTC)', { exact: true });
  await expect(use).toBeEnabled();
  let release!: () => void, markHeld!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), held = new Promise<void>(resolve => { markHeld = resolve; });
  let first = true;
  await page.route('**/api/orbital-assessments/recheck', async route => {
    if (!first) { await route.continue(); return; }
    first = false; const response = await route.fetch(); expect(response.status()).toBe(200); markHeld(); await gate; await route.fulfill({ response }).catch(() => {});
  });
  try {
    await time.fill(iso(boundary.pass)); await held;
    await expect(time).toBeFocused(); await expect(use).toBeDisabled();
    await expect(option).toContainText('Earlier checks below describe the original instant');
    const passResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/orbital-assessments/recheck' && response.request().postDataJSON().proposedAtUtc === iso(boundary.pass));
    release(); const passed = await (await passResponse).json();
    expect(passed.option.checks.find((check: { id: string }) => check.id === 'explicit-day').state).toBe('PASS');
    await expect(option.getByText('Requested daylight condition · PASS', { exact: true })).toBeVisible();
    await expect(option.getByRole('checkbox', { name: /I acknowledge: Requested daylight condition/ })).toHaveCount(0);
    for (const checkbox of await option.getByRole('checkbox').all()) { await expect(checkbox).not.toBeChecked(); await checkbox.check(); }
    await expect(use).toBeEnabled();

    const failedResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/orbital-assessments/recheck' && response.request().postDataJSON().proposedAtUtc === iso(boundary.fail));
    await time.fill(iso(boundary.fail)); const failed = await (await failedResponse).json();
    expect(failed.option.outcome).toBe('INELIGIBLE');
    await expect(option.getByText('Requested daylight condition · FAIL', { exact: true })).toBeVisible();
    await expect(use).toBeDisabled();

    const uncertainResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/orbital-assessments/recheck' && response.request().postDataJSON().proposedAtUtc === iso(boundary.at));
    await time.fill(iso(boundary.at)); const uncertain = await (await uncertainResponse).json();
    expect(uncertain.option.checks.find((check: { id: string }) => check.id === 'explicit-day').state).toBe('BOUNDARY_UNCERTAIN');
    await expect(option.getByText('Requested daylight condition · BOUNDARY UNCERTAIN', { exact: true })).toBeVisible();
    const daylight = option.getByRole('checkbox', { name: /I acknowledge: Requested daylight condition/ });
    await expect(daylight).not.toBeChecked();
    for (const checkbox of await option.getByRole('checkbox').all()) await checkbox.check();
    await daylight.uncheck(); await expect(use).toBeDisabled();
    await daylight.check(); await expect(use).toBeEnabled();
    await use.click();
    await expect(panel.getByRole('region', { name: 'Locally selected proposed plan', exact: true })).toContainText(iso(boundary.at));
    await expect(time).toHaveValue(iso(boundary.at));
    await option.getByRole('button', { name: 'View predicted position', exact: true }).click();
    await expect(panel).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Real orbital prediction', exact: true })).toHaveAttribute('data-represented-utc', iso(boundary.at));
    await expect(page.getByText(`Assessment view at ${iso(boundary.at)} — paused`, { exact: true })).toBeVisible();
  } finally { release(); await page.unroute('**/api/orbital-assessments/recheck'); }
});
