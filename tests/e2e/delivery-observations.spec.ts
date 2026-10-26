import { test, expect, type Page } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import type { CustomerResultProjection } from '../../shared/material.js';
import type { WorkflowCommandName } from '../../shared/workflow.js';
import { currentContext, enterCustomer, enterStaff, scheduledRequest } from './helpers.js';
import { answer, staffDetail, prepareResult, approveAndPublishImages, publishFinding, grant } from './material-helpers.js';

test.setTimeout(150_000);
async function customerResult(page: Page, resultId: string) {
  const response = await page.request.get(`/api/customer/org-a/results/${resultId}`);
  expect(response.status(), await response.text()).toBe(200);
  return response.json() as Promise<CustomerResultProjection>;
}
async function materialAction(page: Page, id: string, name: WorkflowCommandName, payload: Record<string, unknown>) {
  const context = await currentContext(page), request = await staffDetail(page, id), result = request.result!;
  const data = { commandId: crypto.randomUUID(), contextGeneration: context.contextGeneration, contextToken: context.contextToken,
    target: { requestId: id, resultId: result.id, ...(name === 'withdrawFinding' ? { findingId: result.finding!.id } : {}) },
    expected: { requestVersion: request.requestVersion, briefRevision: request.briefRevision, materialVersion: result.materialVersion,
      ...(name === 'withdrawFinding' ? { findingContentVersion: result.finding!.currentVersion.contentVersion } : {}) }, payload };
  const headers = { origin: new URL(page.url()).origin, 'x-coruscant-csrf': context.csrfToken! };
  const preview = await page.request.post(`/api/command-reviews/${name}`, { headers, data });
  expect(preview.status(), await preview.text()).toBe(200);
  const response = await page.request.post(`/api/commands/${name}`, { headers, data: { ...data, reviewToken: (await preview.json()).reviewToken } });
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}
async function readyResult(page: Page, purpose: string, title: string, mismatch = false) {
  const mission = await scheduledRequest(page, purpose, mismatch);
  const resultId = await prepareResult(page, mission.id, title);
  await approveAndPublishImages(page, mission.id);
  await publishFinding(page, mission.id, mismatch);
  if (!mismatch) {
    // Recover a granted-but-lost response after leaving its confirmation, without a new grant.
    await page.getByLabel('Access reason', { exact: true }).fill('Permit the intended organization to inspect the published synthetic demonstration under its stated rights.');
    await page.getByRole('button', { name: 'Review access change', exact: true }).click();
    await page.route('**/api/commands/grantResultAccess', async route => {
      const response = await route.fetch(); expect(response.status(), await response.text()).toBe(200); await route.abort('failed');
    });
    const access = page.getByRole('dialog', { name: 'Review access change', exact: true });
    await access.getByRole('button', { name: 'Confirm access change', exact: true }).click();
    await expect(access.getByRole('button', { name: 'Retry same access change', exact: true })).toBeEnabled();
    await page.unroute('**/api/commands/grantResultAccess');
    await access.getByRole('button', { name: 'Close Review access change', exact: true }).click();
    await page.getByRole('button', { name: 'Keep draft and continue', exact: true }).click();
    await expect(access).toHaveCount(0);
    await page.getByRole('button', { name: 'Retry same access change', exact: true }).first().click();
    await expect(page.getByRole('button', { name: 'Retry same access change', exact: true })).toHaveCount(0);
    expect((await staffDetail(page, mission.id)).result!.access!.version).toBe(1);
  } else await grant(page, mission.id);
  return { ...mission, resultId, title };
}
async function assertPointAttachment(page: Page, id: string, x: number, y: number) {
  const stage = page.getByRole('region', { name: 'Baseline image viewer', exact: true });
  const marker = stage.locator(`[data-observation-id="${id}"]`);
  await expect(marker).toBeVisible();
  const error = await stage.evaluate((node, point) => {
    const image = node.querySelector('img')!, marker = node.querySelector<HTMLElement>(`[data-observation-id="${point.id}"]`)!;
    const m = new DOMMatrix(getComputedStyle(image).transform), n = node.getBoundingClientRect(), p = marker.getBoundingClientRect();
    return { x: Math.abs(p.left + p.width / 2 - (n.left + node.clientLeft + m.e + point.x * image.naturalWidth * m.a)),
      y: Math.abs(p.top + p.height / 2 - (n.top + node.clientTop + m.f + point.y * image.naturalHeight * m.d)) };
  }, { id, x, y });
  expect(error.x).toBeLessThan(1); expect(error.y).toBeLessThan(1);
}

test('aligned saved journey, receipt-first delivery recovery and exact-version own observations @slice-04', async ({ page }, info) => {
  const mission = await readyResult(page, `Follow one estuary question through delivery and own notes (${info.project.name}).`, `Delivered comparison (${info.project.name})`);
  const before = await staffDetail(page, mission.id);
  expect(before.result!.readiness.ready).toBe(true);
  const note = 'The reviewed synthetic pair and finding are supplied for the agreed local demonstration. This is not a real acquisition.';
  await page.getByLabel('Delivery note', { exact: true }).fill(note);
  await page.getByRole('button', { name: 'Review delivery', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Review delivery', exact: true });
  await expect(review.getByText(note, { exact: true })).toBeVisible();
  let deliveredEnvelope: Record<string, unknown> | undefined;
  await page.route('**/api/commands/recordDelivery', async route => {
    deliveredEnvelope = route.request().postDataJSON();
    const response = await route.fetch(); expect(response.status(), await response.text()).toBe(200);
    // The original succeeds, then currently readable material changes before response recovery.
    await materialAction(page, mission.id, 'withdrawFinding', { reason: 'Test the distinction between historical delivery and current published finding availability.' });
    await route.abort('failed');
  });
  await review.getByRole('button', { name: 'Confirm record delivery', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Review delivery', exact: true }).getByRole('button', { name: 'Retry same delivery', exact: true })).toBeEnabled();
  await page.unroute('**/api/commands/recordDelivery');
  const committed = await staffDetail(page, mission.id);
  expect(committed.status).toBe('Delivered'); expect(committed.result!.finding!.state).toBe('WITHDRAWN');
  expect(deliveredEnvelope).toBeDefined();
  const uncertainReview = page.getByRole('dialog', { name: 'Review delivery', exact: true });
  await uncertainReview.getByRole('button', { name: 'Close Review delivery', exact: true }).click();
  await page.getByRole('button', { name: 'Keep draft and continue', exact: true }).click();
  await expect(uncertainReview).toHaveCount(0);
  await page.getByRole('button', { name: 'Retry same delivery', exact: true }).first().click();
  await expect(page.getByRole('button', { name: 'Retry same delivery', exact: true })).toHaveCount(0);
  const recovered = await staffDetail(page, mission.id);
  expect(recovered.result!.delivery).toEqual(committed.result!.delivery);
  expect(recovered.result!.delivery!.note).toBe(note);
  expect(recovered.history.filter(item => item.type === 'Delivered')).toHaveLength(1);
  await enterCustomer(page); await page.goto(`/workspaces/org-a/missions/${mission.id}`);
  await expect(page.locator('.page-heading').getByText('Delivered', { exact: true })).toBeVisible();
  await expect(page.getByText(mission.reference, { exact: true }).first()).toBeVisible();
  await page.getByRole('link', { name: mission.title, exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No published finding', exact: true })).toBeVisible();
  await expect(page.getByText(answer, { exact: true })).toHaveCount(0);
  const initial = await customerResult(page, mission.resultId);
  expect(initial.observations).toHaveLength(0); expect(initial.delivery!.id).toBe(recovered.result!.delivery!.id);
  await page.getByRole('button', { name: 'Point', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Your observations', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByLabel('Point X', { exact: true }).fill('0.25'); await page.getByLabel('Point X', { exact: true }).press('Enter');
  await page.getByLabel('Point Y', { exact: true }).fill('0.75'); await page.getByLabel('Point Y', { exact: true }).press('Enter');
  await expect(page.locator('[data-provisional-point]')).toHaveCount(1);
  expect((await customerResult(page, mission.resultId)).observations).toHaveLength(0);
  await page.getByRole('button', { name: 'Start point at centre', exact: true }).click();
  expect((await customerResult(page, mission.resultId)).observations).toHaveLength(0);
  const x = .312345678901, y = .623456789012;
  await page.getByLabel('Point X', { exact: true }).fill(String(x)); await page.getByLabel('Point X', { exact: true }).press('Enter');
  await page.getByLabel('Point Y', { exact: true }).fill(String(y)); await page.getByLabel('Point Y', { exact: true }).press('Enter');
  const text = 'My own illustrative river observation, bound to this exact Baseline image version.';
  await page.getByLabel('Observation note', { exact: true }).fill(text);
  await page.getByRole('tab', { name: 'Staff finding', exact: true }).click();
  await page.getByRole('tab', { name: 'Your observations', exact: true }).click();
  await expect(page.getByLabel('Observation note', { exact: true })).toHaveValue(text);
  // A deliberate image switch retains the raw work under its original exact version.
  await page.locator('.rail-image').nth(1).click();
  await page.getByRole('button', { name: 'Keep draft and continue', exact: true }).click();
  await expect(page.getByLabel('Observation note', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Point X', { exact: true })).toHaveValue('');
  await page.locator('.rail-image').nth(0).click();
  await expect(page.getByLabel('Observation note', { exact: true })).toHaveValue(text);
  await expect(page.getByLabel('Point X', { exact: true })).toHaveValue(x.toFixed(4));
  await page.getByRole('button', { name: 'Point', exact: true }).click();
  // At Fit, reject an actual letterbox click without moving the provisional point.
  const main = page.getByRole('region', { name: 'Baseline image viewer', exact: true });
  const letterbox = await main.evaluate(node => {
    const image = node.querySelector('img')!, m = new DOMMatrix(getComputedStyle(image).transform);
    return m.f > 6 ? { x: node.clientWidth / 2, y: 2 } : m.e > 6 ? { x: 2, y: node.clientHeight / 2 } : null;
  });
  expect(letterbox).not.toBeNull();
  await main.click({ position: letterbox! });
  await expect(page.getByLabel('Point X', { exact: true })).toHaveValue(x.toFixed(4));
  await expect(page.getByLabel('Point Y', { exact: true })).toHaveValue(y.toFixed(4));
  const second = initial.images.find(image => image.role === 'RECENT')!;
  await page.getByRole('combobox', { name: 'Compare with', exact: true }).selectOption(`${second.assetId}:${second.contentVersion}`);
  await page.getByRole('region', { name: 'Recent image viewer — pan only', exact: true }).click();
  await expect(page.getByLabel('Point X', { exact: true })).toHaveValue(x.toFixed(4));
  let savedEnvelope: Record<string, unknown> | undefined;
  await page.route('**/api/commands/createObservation', async route => {
    savedEnvelope = route.request().postDataJSON(); const response = await route.fetch();
    expect(response.status(), await response.text()).toBe(200); await route.abort('failed');
  });
  await page.getByRole('button', { name: 'Save observation', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry same observation save', exact: true }).first()).toBeEnabled();
  await expect(page.getByLabel('Observation note', { exact: true })).toHaveValue(text);
  await page.unroute('**/api/commands/createObservation');
  const once = (await customerResult(page, mission.resultId)).observations;
  expect(once).toHaveLength(1); expect(savedEnvelope).toBeDefined();
  await page.getByRole('button', { name: 'Retry same observation save', exact: true }).first().click();
  await expect(page.getByRole('button', { name: 'Retry same observation save', exact: true })).toHaveCount(0);
  const saved = (await customerResult(page, mission.resultId)).observations;
  expect(saved).toHaveLength(1); expect(saved[0]!.id).toBe(once[0]!.id);
  expect(saved[0]!.x).toBe(x); expect(saved[0]!.y).toBe(y); expect(saved[0]!.text).toBe(text);
  expect(saved[0]!.assetId).toBe(initial.images[0]!.assetId);
  await expect(page.getByText('Choose a point inside the actual image. Letterboxing is not image content.', { exact: true })).toHaveCount(0);
  await assertPointAttachment(page, saved[0]!.id, x, y);
  await page.screenshot({ path: info.outputPath('saved-point-1440.png') });
  await page.getByRole('button', { name: 'Pan', exact: true }).click();
  await page.getByRole('button', { name: 'Zoom in', exact: true }).first().click();
  await main.focus(); await main.press('ArrowRight'); await assertPointAttachment(page, saved[0]!.id, x, y);
  for (const width of [1024, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await assertPointAttachment(page, saved[0]!.id, x, y);
  }
  await page.screenshot({ path: info.outputPath('saved-point-390.png') });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('link', { name: 'Return to this mission', exact: true }).click();
  await page.getByRole('link', { name: mission.title, exact: true }).click(); await page.reload();
  await page.getByRole('tab', { name: 'Your observations', exact: true }).click();
  await expect(page.getByText(text, { exact: true })).toBeVisible();
  await assertPointAttachment(page, saved[0]!.id, x, y);
  expect((await customerResult(page, mission.resultId)).observations[0]).toEqual(saved[0]);
  await enterCustomer(page, 'a-requester'); await page.goto(`/workspaces/org-a/results/${mission.resultId}`);
  await page.getByRole('tab', { name: 'Your observations', exact: true }).click();
  await expect(page.getByText(text, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Edit observation by/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Delete observation by/ })).toHaveCount(0);
  await enterCustomer(page, 'a-viewer'); await page.goto(`/workspaces/org-a/results/${mission.resultId}`);
  await page.getByRole('tab', { name: 'Your observations', exact: true }).click();
  await expect(page.getByText(text, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Point', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: /^Save observation|^Save changes|^Edit observation|^Delete observation/ })).toHaveCount(0);
  await enterCustomer(page); await page.goto(`/workspaces/org-a/results/${mission.resultId}`);
  await page.getByRole('tab', { name: 'Your observations', exact: true }).click();
  await page.getByRole('button', { name: /^Edit observation by/ }).click();
  await page.getByLabel('Observation note', { exact: true }).fill(`${text} Edited by its author.`);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await customerResult(page, mission.resultId)).observations[0]!.text).toBe(text);
  await page.getByRole('button', { name: /^Edit observation by/ }).click();
  const retained = `${text} Keep this stale draft until I review the current note.`;
  await page.getByLabel('Observation note', { exact: true }).fill(retained);
  const current = await customerResult(page, mission.resultId), context = await currentContext(page), existing = current.observations[0]!;
  const parallel = await page.request.post('/api/commands/updateObservation', {
    headers: { origin: new URL(page.url()).origin, 'x-coruscant-csrf': context.csrfToken! },
    data: { commandId: crypto.randomUUID(), contextGeneration: context.contextGeneration, contextToken: context.contextToken,
      target: { requestId: current.requestId, resultId: current.id, assetId: existing.assetId, observationId: existing.id },
      expected: { requestVersion: current.requestVersion, briefRevision: current.briefRevision, imageContentVersion: existing.contentVersion, observationVersion: existing.version },
      payload: { observation: { x: existing.x, y: existing.y, text: 'A valid parallel edit by this same author.' } } },
  });
  expect(parallel.status(), await parallel.text()).toBe(200);
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByText('Action needs attention', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Observation note', { exact: true })).toHaveValue(retained);
  await page.getByRole('button', { name: 'Refresh current request', exact: true }).click();
  await page.getByText('Review current observation; retain my draft', { exact: true }).click();
  await expect(page.getByText('A valid parallel edit by this same author.', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Observation note', { exact: true })).toHaveValue(retained);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: /^Edit observation by/ }).click();
  await expect(page.getByLabel('Observation note', { exact: true })).toHaveValue('A valid parallel edit by this same author.');
  await page.getByLabel('Observation note', { exact: true }).fill(`${text} Edited by its author.`);
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByText(`${text} Edited by its author.`, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Delete observation by/ }).click();
  const deletion = page.getByRole('dialog', { name: 'Delete observation', exact: true });
  await deletion.getByRole('button', { name: 'Confirm delete', exact: true }).click();
  await expect(deletion).toHaveCount(0);
  await expect.poll(async () => (await customerResult(page, mission.resultId)).observations.length).toBe(0);
});

test('a fully published entitled mismatched pair blocks a new delivery without losing the entered note @slice-04', async ({ page }, info) => {
  const mission = await readyResult(page, `Check strict date-alignment delivery (${info.project.name}).`, `Date-blocked comparison (${info.project.name})`, true);
  const before = await staffDetail(page, mission.id);
  expect(before.result!.dateComparison.status).toBe('DIFFERENT');
  expect(before.result!.images.every(image => image.state === 'PUBLISHED' && image.approvalValid)).toBe(true);
  expect(before.result!.finding!.state).toBe('PUBLISHED'); expect(before.result!.finding!.reviewValid).toBe(true);
  expect(before.result!.access!.active).toBe(true);
  const note = 'Keep my proposed delivery note for review; acknowledging the sample discrepancy does not change the accepted dates.';
  await page.getByLabel('Delivery note', { exact: true }).fill(note);
  await page.getByRole('button', { name: 'Review delivery', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Review delivery', exact: true });
  await expect(dialog.getByText('Delivery blocked: supplied comparison dates differ from the accepted reference dates.', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Confirm record delivery', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Close Review delivery', exact: true }).click();
  await page.getByRole('button', { name: 'Keep draft and continue', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel('Delivery note', { exact: true })).toHaveValue(note);
  const after = await staffDetail(page, mission.id);
  expect(after.status).toBe('Scheduled'); expect(after.acceptedQuote).toEqual(before.acceptedQuote);
  expect(after.result!.delivery).toBeNull();
  const testRoot = info.config.metadata.dataRoot as string; expect(testRoot).toContain('coruscant-e2e-');
  const db = new DatabaseSync(join(testRoot, 'coruscant.sqlite'));
  try {
    expect(db.prepare('SELECT count(*) AS n FROM deliveries WHERE request_id=?').get(mission.id)?.n).toBe(0);
    expect(db.prepare("SELECT count(*) AS n FROM request_events WHERE request_id=? AND type='Delivered'").get(mission.id)?.n).toBe(0);
    expect(db.prepare("SELECT count(*) AS n FROM action_receipts WHERE json_extract(outcome_json,'$.requestId')=? AND command_name='recordDelivery'").get(mission.id)?.n).toBe(0);
  } finally { db.close(); }
  await page.screenshot({ path: info.outputPath('delivery-date-blocked.png') });
  await enterCustomer(page); await page.goto(`/workspaces/org-a/missions/${mission.id}`);
  await page.getByRole('link', { name: mission.title, exact: true }).click();
  await expect(page.getByText('Requested comparison dates differ from supplied illustrative dates', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/This sample does not fulfill that requested date/)).toBeVisible();
});
