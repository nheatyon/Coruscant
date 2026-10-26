import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { BriefInput, RequestProjection, SubmissionOutcome, SubmissionReview } from '../../shared/contracts.js';
import { areaSignature, createEmptyBrief } from '../../shared/validation.js';
import { currentContext, enterCustomer, submitSavedPlanning } from './helpers.js';

test.setTimeout(90_000);
const planningReview = 'Review not requested. Staff review requires the separate “Submit request for review…” action.';
const oldFallback = 'The local preliminary check is unavailable. Our team still reviews the saved brief.';
const unrelatedHistoricalCaveat = 'Generated regression caveat: retain this exact historical text.';

/** Create only this test's new preparation through the ordinary reviewed command.
 * No pre-existing learner request or completed workflow is changed. */
async function freshPlanning(page: Page, label: string, selectedEvidence: BriefInput['selectedEvidence'] = []) {
  await enterCustomer(page);
  const context = await currentContext(page), purpose = `Generated copy regression: ${label}.`;
  const area = { latitude: 52.6, longitude: -9.7, radiusKm: 25, method: 'coordinates' as const, generation: 1 };
  const brief: BriefInput = {
    ...createEmptyBrief(), purpose, areaReviewedPurpose: purpose, observationIntent: 'single-observation', sensor: 'SAR',
    latitude: '52.6', longitude: '-9.7', radiusKm: '25', areaChoice: area, areaConfirmation: areaSignature(area),
    contact: { name: 'Generated copy-test contact', email: 'copy-regression@example.test', organization: 'Generated copy-test organization' },
    selectedEvidence, catalogContext: { sourceKind: 'DEMONSTRATION' }, acknowledged: true,
  };
  const raw = { contextGeneration: context.contextGeneration, contextToken: context.contextToken,
    target: { organizationId: 'org-a' }, expected: {}, payload: { brief } };
  const headers = { origin: new URL(page.url()).origin, 'x-coruscant-csrf': context.csrfToken! };
  const preview = await page.request.post('/api/command-reviews/savePlanningRequest', { headers, data: raw });
  expect(preview.status(), await preview.text()).toBe(200);
  const review = await preview.json() as SubmissionReview;
  const saved = await page.request.post('/api/commands/savePlanningRequest', { headers, data: { ...raw, commandId: randomUUID(), reviewToken: review.reviewToken } });
  expect(saved.status(), await saved.text()).toBe(201);
  const outcome = await saved.json() as SubmissionOutcome;
  const path = `/api/customer/org-a/requests/${outcome.requestId}`;
  const response = await page.request.get(path); expect(response.status()).toBe(200);
  const request = await response.json() as RequestProjection;
  expect(request.status).toBe('Planning'); expect(request.submittedAt).toBeNull(); expect(request.humanReview).toBe('Not submitted');
  expect(request.history.map(event => event.type)).toEqual(['Planning saved']);
  return { request, path };
}

async function expandedEvidence(page: Page, state: 'Planning' | 'Submitted') {
  const summary = page.locator('summary').filter({ hasText: new RegExp(`^${state} brief and evidence · Revision `) });
  await expect(summary).toHaveCount(1);
  const details = summary.locator('..');
  if (!await details.getAttribute('open').then(value => value !== null)) await summary.click();
  await expect(details).toHaveAttribute('open', '');
  return details;
}

test('empty saved Planning evidence never implies queued review; explicit same-record submission changes the copy @planning-copy @slice-09 @r022', async ({ page }, info) => {
  const { request, path } = await freshPlanning(page, `empty selection ${info.project.name}`);
  expect(request.evidence).toEqual([]);
  await page.goto(`/workspaces/org-a/service-requests/${request.id}`);
  await expect(page.locator('.page-heading').getByText('Planning', { exact: true })).toBeVisible();
  const evidence = await expandedEvidence(page, 'Planning');
  await expect(evidence.getByText(`No catalog selection. ${planningReview}`, { exact: true })).toBeVisible();
  await expect(evidence).not.toContainText('Our team will review the brief.');
  await expect(page.getByRole('button', { name: 'Submit request for review…', exact: true })).toBeVisible();
  await page.reload();
  await expect((await expandedEvidence(page, 'Planning')).getByText(`No catalog selection. ${planningReview}`, { exact: true })).toBeVisible();
  await submitSavedPlanning(page);
  const submittedEvidence = await expandedEvidence(page, 'Submitted');
  await expect(submittedEvidence.getByText('No catalog selection. Our team will review the brief.', { exact: true })).toBeVisible();
  await expect(submittedEvidence).not.toContainText(planningReview);
  const submitted = await (await page.request.get(path)).json() as RequestProjection;
  expect(submitted.id).toBe(request.id); expect(submitted.reference).toBe(request.reference); expect(submitted.evidence).toEqual([]);
  expect(submitted.history.map(event => event.type)).toEqual(['Planning saved', 'Submitted']);
});

test('unverified Planning selection and known legacy boilerplate remain preparation while unrelated caveats and Submitted copy survive @planning-copy @slice-09 @r022', async ({ page }, info) => {
  const { request, path } = await freshPlanning(page, `unverified selection ${info.project.name}`,
    [{ itemId: 'generated-copy-test-unverified-intention', evidenceVersion: 'generated-copy-test-v1' }]);
  expect(request.evidence).toHaveLength(1); expect(request.evidence[0]!.verified).toBe(false);
  // A generated read-response double exercises historical wording compatibility.
  // The saved record remains the fresh, ordinary unverified intention above.
  await page.route(`**${path}`, async route => {
    const response = await route.fetch(); expect(response.status()).toBe(200);
    const body = await response.json() as RequestProjection;
    const item = body.evidence[0]!;
    await route.fulfill({ response, json: { ...body, evidence: [{ ...item, caveats: [...item.caveats, oldFallback, unrelatedHistoricalCaveat] }] } });
  });
  await page.goto(`/workspaces/org-a/service-requests/${request.id}`);
  const evidence = await expandedEvidence(page, 'Planning');
  await expect(evidence.getByText(`Selection could not be verified. ${planningReview}`, { exact: true })).toBeVisible();
  await expect(evidence.getByText(`The local preliminary check is unavailable. ${planningReview}`, { exact: true })).toBeVisible();
  await expect(evidence).not.toContainText('our team will review it');
  await expect(evidence).not.toContainText('Our team still reviews the saved brief.');
  await expect(evidence.getByText(unrelatedHistoricalCaveat, { exact: true })).toBeVisible();
  expect((await (await page.request.get(path)).json() as RequestProjection).evidence).toEqual(request.evidence);
  await submitSavedPlanning(page);
  const submittedEvidence = await expandedEvidence(page, 'Submitted');
  await expect(submittedEvidence.getByText('Selection could not be verified; our team will review it.', { exact: true })).toBeVisible();
  await expect(submittedEvidence.getByText(oldFallback, { exact: true })).toBeVisible();
  await expect(submittedEvidence.getByText(unrelatedHistoricalCaveat, { exact: true })).toBeVisible();
  await expect(submittedEvidence).not.toContainText(planningReview);
  const submitted = await (await page.request.get(path)).json() as RequestProjection;
  expect(submitted.evidence).toEqual(request.evidence); expect(submitted.reference).toBe(request.reference);
  await page.unroute(`**${path}`);
});
