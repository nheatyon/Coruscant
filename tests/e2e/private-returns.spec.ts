import { test, expect, type Page } from '@playwright/test';
import type { Context, RequestProjection } from '../../shared/contracts.js';
import { chooseDemonstrationCatalog, currentContext, enterCustomer, newRequest, scheduledRequest } from './helpers.js';

test.setTimeout(150_000);

test('uncertain clarification closes without losing its original retry, survives a cover and saves once against immutable work @slice-07', async ({ page }, info) => {
  const mission = await scheduledRequest(page, `Immutable clarification recovery (${info.project.name}).`);
  await enterCustomer(page, 'a-requester'); await page.goto(`/workspaces/org-a/service-requests/${mission.id}`);
  const read = async () => (await page.request.get(`/api/customer/org-a/requests/${mission.id}`)).json() as Promise<RequestProjection>;
  const before = await read();
  await expect(page.getByRole('button', { name: 'Revise brief', exact: true })).toHaveCount(0);
  const clarification = page.getByRole('region', { name: 'Clarifications', exact: true });
  const text = 'Please discuss this proposed change; keep the accepted dates, scope, price and schedule unchanged.';
  await clarification.getByRole('button', { name: 'Reply to the team', exact: true }).click();
  await clarification.getByLabel('Message', { exact: true }).fill(text);
  await clarification.getByRole('button', { name: 'Preview reply', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Preview reply', exact: true });
  await expect(panel.getByText(text, { exact: true })).toBeVisible();
  const attempts: unknown[] = [];
  let committed = false;
  await page.route('**/api/commands/replyToTeam', async route => {
    attempts.push(route.request().postDataJSON());
    if (committed) return route.continue();
    const result = await route.fetch(); expect(result.ok()).toBe(true); committed = true;
    await route.abort('failed');
  });
  await panel.getByRole('button', { name: 'Confirm reply', exact: true }).click();
  await expect(panel.getByText('Outcome uncertain', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Close Preview reply', exact: true }).click();
  await page.getByRole('dialog', { name: 'Keep your private draft?', exact: true }).getByRole('button', { name: 'Keep draft and continue', exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(clarification.getByLabel('Message', { exact: true })).toHaveValue(text);
  let failCheck = true;
  await page.route('**/api/context', route => failCheck ? route.fulfill({ status: 503, json: { code: 'CHECK_UNAVAILABLE', message: 'Temporary isolated verification failure.' } }) : route.continue());
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('heading', { name: 'Check account', exact: true })).toBeVisible();
  await expect(page.getByLabel('Message', { exact: true })).toHaveCount(0);
  failCheck = false; await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(clarification.getByLabel('Message', { exact: true })).toHaveValue(text);
  await expect(panel).toHaveCount(0);
  await clarification.getByRole('button', { name: 'Retry same reply', exact: true }).click();
  await expect(clarification.getByText(text, { exact: true }).first()).toBeVisible();
  await expect(clarification.getByLabel('Message', { exact: true })).toHaveCount(0);
  expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]);
  const after = await read();
  expect(after.messages.filter(value => value.message === text)).toHaveLength(1);
  expect(after.history.filter(value => value.type === 'replyToTeam')).toHaveLength(1);
  expect(after.status).toBe('Scheduled'); expect(after.brief).toEqual(before.brief);
  expect(after.acceptedQuote).toEqual(before.acceptedQuote); expect(after.schedule).toEqual(before.schedule);
  await page.unrouteAll();
});

test('one/multiple/zero memberships preserve products and safe exact returns without transferring a private identifier @slice-07', async ({ page }, info) => {
  const mission = await newRequest(page, `Safe selected-workspace return (${info.project.name}).`);
  await page.getByRole('button', { name: 'Leave demonstration access', exact: true }).click();
  const path = `/workspaces/org-a/missions/${mission.id}`;
  await page.goto(path);
  await expect(page.getByRole('heading', { name: 'Demonstration access', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Demonstration customer', exact: true }).selectOption('a-owner');
  await page.getByRole('button', { name: 'Continue to workspace', exact: true }).click();
  await expect(page.getByRole('heading', { name: mission.saved.title, exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(path);
  await page.goto(`/access?product=missions&returnTo=${encodeURIComponent(path)}`);
  await page.getByRole('combobox', { name: 'Demonstration customer', exact: true }).selectOption('multi-viewer');
  await page.getByRole('button', { name: 'Continue to workspace', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Choose workspace', exact: true })).toBeVisible();
  await expect(page.locator('.workspace-row')).toHaveCount(2);
  let foreignReads = 0;
  await page.route(`**/api/customer/org-a/requests/${mission.id}`, route => { foreignReads++; return route.continue(); });
  await page.locator('.workspace-row').filter({ hasText: 'Demo Coastal Lab' }).getByRole('button', { name: 'Open Mission Control', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'This item is unavailable in your current workspace', exact: true })).toBeVisible();
  await expect(page.getByText(mission.saved.title, { exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Return to permitted Missions', exact: true })).toHaveAttribute('href', '/workspaces/org-b/missions');
  expect(foreignReads).toBe(0);
  await page.getByRole('link', { name: 'Return to permitted Missions', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Missions', exact: true })).toBeVisible();
  await page.goto('/workspaces?product=results');
  await page.locator('.workspace-row').filter({ hasText: 'Demo Estuary Research' }).getByRole('button', { name: 'Open SatSuite results', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Results', exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/workspaces/org-a/results');
  await page.goto('/access?product=missions');
  await page.getByRole('combobox', { name: 'Demonstration customer', exact: true }).selectOption('no-workspace');
  await page.getByRole('button', { name: 'Continue to workspace', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No workspace access is configured', exact: true })).toBeVisible();
  await expect(page.locator('.workspace-row')).toHaveCount(0);
});

test('an old-generation detail response stays covered; late old-context data cannot restore a previous customer @slice-07', async ({ page }, info) => {
  const mission = await newRequest(page, `Covered stale projection (${info.project.name}).`);
  await page.goto('/about/data');
  const context = await currentContext(page);
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let corrupt = true, holdContext = false;
  await page.route(`**/api/customer/org-a/requests/${mission.id}`, async route => {
    const response = await route.fetch();
    if (!corrupt) return route.fulfill({ response });
    corrupt = false; holdContext = true;
    await route.fulfill({ response, json: { ...await response.json(), contextGeneration: context.contextGeneration - 1 } });
  });
  await page.route('**/api/context', async route => { if (holdContext) await barrier; await route.continue(); });
  await page.goto(`/workspaces/org-a/service-requests/${mission.id}`);
  await expect(page.getByRole('heading', { name: 'Checking current access…', exact: true })).toBeVisible();
  await expect(page.getByText(mission.saved.title, { exact: true })).toHaveCount(0);
  holdContext = false; release();
  await expect(page.getByRole('heading', { name: mission.saved.title, exact: true })).toBeVisible();
  await page.unrouteAll(); await page.goto('/about/data');
  let releaseOld!: () => void;
  const oldBarrier = new Promise<void>(resolve => { releaseOld = resolve; });
  let captured = false;
  await page.route(`**/api/customer/org-a/requests/${mission.id}`, async route => {
    const response = await route.fetch(); captured = true; await oldBarrier;
    await route.fulfill({ response }).catch(() => {});
  });
  await page.getByRole('link', { name: 'Workspace', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Requests', exact: true })).toBeVisible();
  await page.getByRole('link').filter({ hasText: mission.reference }).first().click();
  await expect.poll(() => captured).toBe(true);
  await page.getByRole('link', { name: /A Owner/ }).click();
  await page.getByRole('combobox', { name: 'Demonstration customer', exact: true }).selectOption('b-owner');
  await page.getByRole('button', { name: 'Continue to workspace', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Requests', exact: true })).toBeVisible();
  expect((await currentContext(page) as Context).organization?.id).toBe('org-b');
  releaseOld();
  await expect(page.getByText(mission.saved.title, { exact: true })).toHaveCount(0);
  await expect(page.getByText(mission.reference, { exact: true })).toHaveCount(0);
  const denied = await page.request.get(`/api/customer/org-a/requests/${mission.id}`);
  expect(denied.status()).toBe(404); expect(await denied.text()).not.toContain(mission.saved.title);
  await page.unrouteAll();
});

test('a late persona entry cannot navigate or uncover a superseded lifecycle transition @slice-07', async ({ page }) => {
  await page.goto('/access');
  await page.getByRole('combobox', { name: 'Demonstration customer', exact: true }).selectOption('b-owner');
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let captured = false;
  await page.route('**/api/demo/customer/enter', async route => {
    const response = await route.fetch(); expect(response.ok()).toBe(true); captured = true;
    await barrier; await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Continue to workspace', exact: true }).click();
  await expect.poll(() => captured).toBe(true);
  await page.evaluate(() => { window.dispatchEvent(new Event('pagehide')); window.dispatchEvent(new Event('pageshow')); });
  release();
  await expect(page.getByText('Access changed while this action was in progress. Review the current context before continuing.', { exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/access');
  await expect(page.getByRole('heading', { name: 'Requests', exact: true })).toHaveCount(0);
  await page.unrouteAll();
  await page.getByRole('button', { name: 'Continue to workspace', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Requests', exact: true })).toBeVisible();
  expect((await currentContext(page)).organization?.id).toBe('org-b');
});

test('a routine account poll does not cancel a still-current deliberate access transition @slice-07', async ({ page }) => {
  await page.clock.install(); await page.goto('/access');
  await page.getByRole('combobox', { name: 'Demonstration customer', exact: true }).selectOption('b-owner');
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let captured = false;
  await page.route('**/api/demo/customer/enter', async route => {
    const response = await route.fetch(); expect(response.ok()).toBe(true); captured = true;
    await barrier; await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Continue to workspace', exact: true }).click();
  await expect.poll(() => captured).toBe(true);
  await page.clock.fastForward(16_000);
  release();
  await expect(page.getByRole('heading', { name: 'Requests', exact: true })).toBeVisible();
  expect((await currentContext(page)).organization?.id).toBe('org-b');
  await expect(page.getByText(/Access changed while this action/)).toHaveCount(0);
  await page.unrouteAll();
});


/** Wait for the initial fresh public check before isolating the next deliberate ensure. */
async function prepareDisclosedPlaceCheck(page: Page, question: string) {
  await page.clock.install(); await page.goto('/');
  const real = page.getByRole('region', { name: 'Real orbital prediction', exact: true });
  await expect(real.locator('.globe-drawing-status')).toContainText('200 positions');
  await chooseDemonstrationCatalog(page); await expect(real).toHaveCount(0);
  const field = page.getByLabel('Search satellites and services', { exact: true });
  if (!await field.isVisible()) await page.getByRole('button', { name: 'Discover', exact: true }).click();
  await field.fill(question); await expect(page.getByLabel('Place phrase', { exact: true })).toHaveValue('Dublin');
}

async function holdFirstFreshContext(page: Page) {
  let release!: () => void, captured!: () => void, completed!: () => void, gets = 0;
  const arrived = new Promise<void>(resolve => { captured = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const finished = new Promise<void>(resolve => { completed = resolve; });
  const handler = async (route: import('@playwright/test').Route) => {
    if (route.request().method() !== 'GET') { await route.continue(); return; }
    const ordinal = ++gets;
    if (ordinal !== 1) { await route.continue(); return; }
    try { const response = await route.fetch(); expect(response.status()).toBe(200); captured(); await barrier; await route.fulfill({ response }); }
    finally { completed(); }
  };
  await page.route('**/api/context', handler);
  return { arrived, finished, release, get count() { return gets; }, async cleanup() { release(); await finished; await page.unroute('**/api/context', handler); } };
}

test('routine account poll defers to a held fresh public check and the disclosed place action still completes @slice-09', async ({ page }) => {
  const question = 'Visible imagery of Dublin. Fresh public check overlaps a routine poll.';
  await prepareDisclosedPlaceCheck(page, question);
  const held = await holdFirstFreshContext(page); let placePosts = 0;
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/place-lookups') placePosts++; });
  try {
    await page.getByRole('button', { name: 'Find place', exact: true }).click(); await held.arrived;
    expect(placePosts).toBe(0);
    await page.clock.fastForward(16_000);
    expect(held.count).toBe(1); expect(placePosts).toBe(0);
    held.release(); await held.finished;
    await expect(page.getByRole('heading', { name: 'Dublin — generated provider-response test place', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Apply proposed location', exact: true })).toBeEnabled();
    expect(held.count).toBe(1); expect(placePosts).toBe(1);
    await expect(page.getByText('Access changed while preparing this action. Your input is retained.', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Search satellites and services', { exact: true })).toHaveValue(question);
  } finally { await held.cleanup(); }
});

test('a deliberate lifecycle cover still invalidates a held fresh public check before any place request @slice-09', async ({ page }) => {
  const question = 'SWIR imagery of Dublin. Deliberate lifecycle cover keeps the original question.';
  await prepareDisclosedPlaceCheck(page, question);
  const held = await holdFirstFreshContext(page); let placePosts = 0;
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/place-lookups') placePosts++; });
  try {
    await page.getByRole('button', { name: 'Find place', exact: true }).click(); await held.arrived;
    await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
    held.release(); await held.finished;
    await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
    await expect.poll(() => held.count).toBeGreaterThan(1);
    await expect(page.getByText(/Lookup or area proposal canceled/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Find place', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Apply proposed location', exact: true })).toHaveCount(0);
    expect(placePosts).toBe(0);
    await expect(page.getByLabel('Search satellites and services', { exact: true })).toHaveValue(question);
    await page.getByRole('button', { name: 'Find place', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Dublin — generated provider-response test place', exact: true })).toBeVisible();
    expect(placePosts).toBe(1);
  } finally { await held.cleanup(); }
});
