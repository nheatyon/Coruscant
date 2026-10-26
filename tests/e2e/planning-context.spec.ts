import { test, expect, type Page } from '@playwright/test';
import type { Context, RequestProjection } from '../../shared/contracts.js';
import type { AssessmentPage } from '../../shared/plan-contracts.js';
import { enterCustomer, enterStaff } from './helpers.js';
import { caseName, finishWindow, panelFor, prepareRealTarget, selectProvisional } from './planning-test-helpers.js';

test.setTimeout(120_000);
async function withoutWebgl(page: Page) {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(this: HTMLCanvasElement, kind, ...args) {
      return kind === 'webgl2' ? null : Reflect.apply(original, this, [kind, ...args]);
    } as typeof original;
  });
}
const permissions = (page: Page) => panelFor(page).getByRole('region', { name: 'Planning context and permissions', exact: true });
async function enterSample(page: Page, persona: string) {
  if (persona === 'staff') { await enterStaff(page); return; }
  if (!['multi-viewer', 'no-workspace'].includes(persona)) { await enterCustomer(page, persona); return; }
  await page.goto('/access');
  await page.getByRole('combobox', { name: 'Demonstration customer', exact: true }).selectOption(persona);
  await page.getByRole('button', { name: 'Continue to workspace', exact: true }).click();
  if (persona === 'multi-viewer') {
    await expect(page.getByRole('heading', { name: 'Choose workspace', exact: true })).toBeVisible();
    await page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Demo Estuary Research', exact: true }) }).getByRole('button', { name: 'View shared requests', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Requests', exact: true })).toBeVisible();
  } else await expect(page.getByRole('heading', { name: 'No workspace access is configured', exact: true })).toBeVisible();
}

for (const [persona, actor, workspace] of [
  ['a-owner', 'A Owner', 'Demo Estuary Research'],
  ['a-requester', 'A Requester', 'Demo Estuary Research'],
  ['b-owner', 'B Owner', 'Demo Coastal Lab'],
] as const) test(`${actor} sees its actual planning capability before entry and calculates within its selected workspace @slice-10 @planning-context`, async ({ page }, info) => {
  await withoutWebgl(page); await enterSample(page, persona);
  const { panel, at } = await prepareRealTarget(page, caseName('SAR imagery current-role capability proof', info.project.name), true);
  await expect(permissions(page)).toContainText(actor); await expect(permissions(page)).toContainText(workspace);
  await expect(permissions(page)).toContainText('Automatic calculation: available for ready inputs');
  await expect(permissions(page)).toContainText('Saving Planning: available after explicit review');
  await expect(panel.getByRole('article', { name: /Planning option/ })).toHaveCount(0);
  await finishWindow(panel, at);
  await expect(panel.getByRole('article', { name: /Planning option SENTINEL-1C/ }).first()).toBeVisible();
  await expect(panel.getByText('Technical calculation unavailable', { exact: true })).toHaveCount(0);
});

for (const [persona, actor] of [
  ['a-viewer', 'A Viewer'], ['multi-viewer', 'Multi-workspace viewer'], ['no-workspace', 'No-workspace sample'], ['staff', 'Staff Admin'],
] as const) test(`${actor} gets upfront refusal and deliberate visitor recovery with the same public brief @slice-10 @planning-context`, async ({ page }, info) => {
  await withoutWebgl(page); await enterSample(page, persona);
  const purpose = caseName('SAR imagery role recovery keeps the question', info.project.name);
  const { panel, at, target } = await prepareRealTarget(page, purpose, true);
  const starts: string[] = []; page.on('request', request => { if (new URL(request.url()).pathname === '/api/orbital-assessments') starts.push(request.url()); });
  await expect(permissions(page)).toContainText(actor);
  await expect(permissions(page)).toContainText('Automatic calculation: unavailable in this context');
  await expect(permissions(page)).toContainText('Catalog search: available in every context');
  await panel.getByLabel('Contact name', { exact: true }).fill('Fictional retained public contact');
  await finishWindow(panel, at); await page.clock.install(); await page.clock.fastForward(1000);
  expect(starts).toHaveLength(0);
  await expect(panel.getByRole('article', { name: /Planning option/ })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Retry technical calculation', exact: true })).toHaveCount(0);
  const left = page.waitForResponse(response => new URL(response.url()).pathname === '/api/demo/leave');
  await permissions(page).getByRole('button', { name: 'Continue as visitor', exact: true }).click();
  expect((await left).status()).toBe(200);
  await expect(permissions(page)).toContainText('Public visitor');
  await expect(panel.getByLabel('Mission purpose', { exact: true })).toHaveValue(purpose);
  await expect(panel.getByLabel('Contact name', { exact: true })).toHaveValue('Fictional retained public contact');
  await expect(panel.getByLabel('Centre latitude', { exact: true })).toHaveValue(String(target.latitude));
  await expect(panel.getByLabel('Window start (local)', { exact: true })).not.toHaveValue('');
  await page.clock.fastForward(1000);
  await expect(panel.getByRole('article', { name: /Planning option SENTINEL-1C/ }).first()).toBeVisible();
  expect(starts.length).toBeGreaterThan(0);
});

test('persona retirement removes completed choices, views and option edits while customer recovery keeps raw inputs @slice-10 @planning-context', async ({ page }, info) => {
  await withoutWebgl(page); await enterSample(page, 'a-requester');
  const purpose = caseName('SAR imagery exact original-owner retirement', info.project.name);
  const { panel, at, browsingUtc } = await prepareRealTarget(page, purpose, true);
  await panel.getByLabel('Contact email', { exact: true }).fill('retained-public@example.test');
  await finishWindow(panel, at);
  const option = panel.getByRole('article', { name: /Planning option SENTINEL-1C/ }).first(); await expect(option).toBeVisible();
  await option.getByRole('button', { name: 'View predicted position', exact: true }).click();
  await expect(page.getByText(/^Assessment view at .* — paused$/)).toBeVisible();
  await page.getByRole('button', { name: /Review this mission/ }).click();
  await option.getByText('Optional personal processing assumption', { exact: true }).click();
  await option.getByLabel('Assumed processing hours (optional)', { exact: true }).fill('3');
  await option.getByLabel('Why you entered this assumption', { exact: true }).fill('Earlier Requester-only unsent option edit.');
  await selectProvisional(panel);
  await panel.getByRole('button', { name: 'Keep brief and close', exact: true }).click();
  await page.getByRole('link', { name: /A Requester/ }).click();
  await page.getByRole('combobox', { name: 'Demonstration customer', exact: true }).selectOption('a-viewer');
  await page.getByRole('button', { name: 'Continue to workspace', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Requests', exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: 'Products', exact: true }).getByRole('link', { name: 'StarSearch', exact: true }).click();
  await expect(page.getByText(/^Assessment view at .* — paused$/)).toHaveCount(0);
  await page.getByRole('button', { name: /Review this mission/ }).click();
  await expect(panel.getByRole('article', { name: /Planning option/ })).toHaveCount(0);
  await expect(panel.getByRole('region', { name: 'Locally selected proposed plan', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Save proposed plan', exact: true })).toHaveCount(0);
  await expect(panel.getByLabel('Mission purpose', { exact: true })).toHaveValue(purpose);
  await expect(panel.getByLabel('Contact email', { exact: true })).toHaveValue('retained-public@example.test');
  await permissions(page).getByRole('link', { name: 'Choose customer access', exact: true }).click();
  await page.getByRole('combobox', { name: 'Demonstration customer', exact: true }).selectOption('a-owner');
  await page.getByRole('button', { name: 'Continue to workspace', exact: true }).click();
  await expect(panel).toBeVisible(); await expect(permissions(page)).toContainText('A Owner');
  await expect(panel.getByRole('region', { name: 'Locally selected proposed plan', exact: true })).toHaveCount(0);
  const fresh = panel.getByRole('article', { name: /Planning option SENTINEL-1C/ }).first(); await expect(fresh).toBeVisible();
  await fresh.getByText('Optional personal processing assumption', { exact: true }).click();
  await expect(fresh.getByLabel('Assumed processing hours (optional)', { exact: true })).toHaveValue('');
  await expect(fresh.getByLabel('Why you entered this assumption', { exact: true })).toHaveValue('');
  await expect(panel.getByLabel('Contact email', { exact: true })).toHaveValue('retained-public@example.test');
  expect(browsingUtc).toBeTruthy();
});

test('unsigned exploration actually leaves Staff and preserves the public draft @slice-10 @planning-context', async ({ page }, info) => {
  await withoutWebgl(page); await enterStaff(page);
  const purpose = caseName('SAR imagery visitor-transition label proof', info.project.name);
  const { panel } = await prepareRealTarget(page, purpose, true);
  await panel.getByRole('button', { name: 'Keep brief and close', exact: true }).click();
  await page.getByRole('link', { name: /Staff Admin/ }).click();
  const left = page.waitForResponse(response => new URL(response.url()).pathname === '/api/demo/leave');
  await page.getByRole('button', { name: 'Explore StarSearch as a visitor', exact: true }).click();
  expect((await left).status()).toBe(200);
  await expect(page.getByRole('link', { name: /Staff Admin/ })).toHaveCount(0);
  await page.getByRole('button', { name: /Review this mission/ }).click();
  await expect(permissions(page)).toContainText('Public visitor');
  await expect(panel.getByLabel('Mission purpose', { exact: true })).toHaveValue(purpose);
});

test('the explicit public two-rotation handoff survives retirement and same-context uncertain save recovery @slice-10 @planning-context', async ({ page }, info) => {
  await withoutWebgl(page);
  const { panel, at } = await prepareRealTarget(page, caseName('SAR imagery explicit handoff and exact recovery', info.project.name), true);
  await expect(permissions(page)).toContainText('Public visitor'); await finishWindow(panel, at); await selectProvisional(panel);
  await panel.getByRole('button', { name: 'Save proposed plan', exact: true }).click();
  const begin = page.waitForResponse(response => new URL(response.url()).pathname === '/api/orbital-assessments/handoff');
  await page.getByRole('link', { name: 'Open customer workspace', exact: true }).click();
  const initial = await (await begin).json() as { handle: AssessmentPage['handle'] };
  await page.getByRole('combobox', { name: 'Demonstration customer', exact: true }).selectOption('a-requester');
  const entering = page.waitForResponse(response => new URL(response.url()).pathname === '/api/demo/customer/enter');
  await page.getByRole('button', { name: 'Continue to workspace', exact: true }).click();
  const entered = await (await entering).json() as Context;
  expect(entered.planningHandoff?.phase).toBe('CONTINUE');
  await expect(page.getByRole('region', { name: 'Locally selected proposed plan', exact: true })).toHaveCount(0);
  await expect(page.getByRole('article', { name: /Planning option/ })).toHaveCount(0);
  const workspace = page.waitForResponse(response => new URL(response.url()).pathname === '/api/context/workspace');
  await page.getByRole('button', { name: 'Review request in this workspace', exact: true }).click();
  const destination = await (await workspace).json() as Context;
  expect(destination.planningHandoff?.phase).toBe('COMPLETE');
  if (destination.planningHandoff?.phase === 'COMPLETE') expect(destination.planningHandoff.result.handle.assessmentId).toBe(initial.handle.assessmentId);
  await page.getByRole('checkbox', { name: 'I confirm this planning brief and destination. This does not request staff review.', exact: true }).check();
  await expect(page.getByRole('heading', { name: 'Tentative — not booked', exact: true })).toBeVisible();
  const attempts: unknown[] = [], outcomes: string[] = [];
  await page.route('**/api/commands/saveProposedPlan', async route => {
    attempts.push(route.request().postDataJSON()); const response = await route.fetch(); expect(response.status()).toBe(attempts.length === 1 ? 201 : 200);
    outcomes.push((await response.json()).outcome);
    if (attempts.length === 1) await route.abort('failed'); else await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Save proposed plan', exact: true }).click();
  const retry = page.getByRole('button', { name: 'Retry same planning save', exact: true }); await expect(retry).toBeEnabled();
  const rechecked = page.waitForResponse(response => new URL(response.url()).pathname === '/api/context');
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); expect((await rechecked).status()).toBe(200);
  await expect(retry).toBeEnabled(); await retry.click();
  await expect(page.getByRole('heading', { name: 'Request saved', exact: true })).toBeVisible();
  expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]); expect(outcomes).toEqual(['saved', 'replayed']);
  const query = new URL(page.url()).searchParams, response = await page.request.get(`/api/customer/org-a/requests/${query.get('request')}`);
  expect(response.status()).toBe(200); const saved = await response.json() as RequestProjection;
  expect(saved.status).toBe('Planning'); expect(saved.currentProposedPlan?.assessment.assessmentId).toBe(initial.handle.assessmentId);
  expect(saved.currentProposedPlan?.actorId).toBe('a-requester');
});
