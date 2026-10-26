import { test, expect } from '@playwright/test';
import type { RequestProjection } from '../../shared/contracts.js';
import { caseName, prepareRealTarget, finishWindow, selectProvisional, saveFromPublic } from './planning-test-helpers.js';

test.setTimeout(120_000);

test('discarding an unsaved replacement clears both local selections, retains unrelated edits and never changes the durable plan @slice-10 @planning-discard', async ({ page }, info) => {
  const { panel, at } = await prepareRealTarget(page, caseName('SAR imagery discard regression', info.project.name));
  await finishWindow(panel, at); await selectProvisional(panel);
  const initial = await saveFromPublic(page);
  expect(initial.currentProposedPlan?.version).toBe(1);
  await page.goto(`/workspaces/org-a/service-requests/${initial.id}`);
  const beforeResponse = await page.request.get(`/api/customer/org-a/requests/${initial.id}`);
  expect(beforeResponse.status()).toBe(200);
  const before = await beforeResponse.json() as RequestProjection;
  let commands = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/commands/saveProposedPlan') commands++; });

  await page.getByRole('button', { name: 'Inspect technical planning options', exact: true }).click();
  const options = page.getByRole('dialog', { name: 'Your request · Proposed plan', exact: true });
  const option = options.getByRole('article', { name: /Planning option SENTINEL-1C/ }).first();
  await expect(option).toBeVisible();
  await option.getByText('Optional personal processing assumption', { exact: true }).click();
  await option.getByLabel('Assumed processing hours (optional)', { exact: true }).fill('4');
  await option.getByLabel('Why you entered this assumption', { exact: true }).fill('A personal QA assumption retained independently of selecting an option.');
  await selectProvisional(options);
  await options.getByRole('button', { name: 'Keep brief without this plan', exact: true }).click();

  await expect(options.getByRole('region', { name: 'Locally selected proposed plan', exact: true })).toHaveCount(0);
  await expect(options.getByRole('heading', { name: 'Earlier local selection retained', exact: true })).toHaveCount(0);
  await expect(options.getByRole('button', { name: 'Review retained proposed plan', exact: true })).toHaveCount(0);
  await expect(options.getByRole('button', { name: 'Save proposed plan', exact: true })).toHaveCount(0);
  await expect(option.getByLabel('Assumed processing hours (optional)', { exact: true })).toHaveValue('4');
  await expect(option.getByLabel('Why you entered this assumption', { exact: true })).toHaveValue('A personal QA assumption retained independently of selecting an option.');

  await options.getByRole('button', { name: 'Keep draft and close', exact: true }).click();
  await page.getByRole('dialog', { name: 'Keep your private draft?', exact: true }).getByRole('button', { name: 'Keep draft and continue', exact: true }).click();
  await expect(options).toHaveCount(0);
  await page.getByRole('button', { name: 'Inspect technical planning options', exact: true }).click();
  await expect(options).toBeVisible();
  await expect(options.getByRole('heading', { name: 'Earlier local selection retained', exact: true })).toHaveCount(0);
  await expect(options.getByRole('button', { name: 'Review retained proposed plan', exact: true })).toHaveCount(0);
  await expect(options.getByLabel('Assumed processing hours (optional)', { exact: true }).first()).toHaveValue('4');
  const afterResponse = await page.request.get(`/api/customer/org-a/requests/${initial.id}`);
  expect(afterResponse.status()).toBe(200);
  const after = await afterResponse.json() as RequestProjection;
  expect(commands).toBe(0);
  expect(after.requestVersion).toBe(before.requestVersion);
  expect(after.brief).toEqual(before.brief);
  expect(after.currentProposedPlan).toEqual(before.currentProposedPlan);
  expect(after.earlierProposedPlans).toEqual(before.earlierProposedPlans);
  expect(after.status).toBe('Planning');
  expect(after.currentQuote).toBeNull(); expect(after.schedule).toBeNull();
});
