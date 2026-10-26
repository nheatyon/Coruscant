import { expect, type Page } from '@playwright/test';
import type { StaffMaterialRequestProjection } from '../../shared/material.js';

export const answer = 'In these illustrative images, the recent view shows a larger dark region contiguous with the river than the baseline view. This demonstrates how a supplied comparison can address the team’s question; it does not establish actual flooding.';
export const limitations = 'These scenes are synthetic. They cannot establish actual flood extent, rainfall causation, road passability, damage or calibrated area measurements. Matching dimensions are a viewing convenience, not georegistration.';
export async function staffDetail(page: Page, id: string) {
  const response = await page.request.get(`/api/staff/requests/${id}`);
  expect(response.status()).toBe(200);
  return response.json() as Promise<StaffMaterialRequestProjection>;
}
export async function prepareResult(page: Page, id: string, title: string) {
  await page.getByRole('button', { name: 'Create result set', exact: true }).click();
  await page.getByLabel('Result title', { exact: true }).fill(title);
  await page.getByLabel('Provider', { exact: true }).fill('Coruscant demonstration material');
  await page.getByLabel('Target label', { exact: true }).fill('Fictional estuary comparison — illustrative scene');
  await page.getByLabel('Source', { exact: true }).fill('Coruscant original synthetic estuary scene v1');
  await page.getByLabel('Uncertainty', { exact: true }).fill('Synthetic scenes illustrate a request; no real location, acquisition or radar measurements.');
  await page.getByLabel('Licence', { exact: true }).fill('Original Coruscant synthetic demonstration material.');
  await page.getByLabel('Permitted use', { exact: true }).fill('Local Coruscant testing and demonstration inspection.');
  await page.getByRole('button', { name: 'Save result draft', exact: true }).click();
  await expect.poll(async () => (await staffDetail(page, id)).result?.metadata.title).toBe(title);
  const savedMetadata = (await staffDetail(page, id)).result!;
  await expect(page.getByRole('region', { name: 'Result metadata', exact: true }).getByText(`RESULT METADATA / MATERIAL VERSION ${savedMetadata.materialVersion}`, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Prepare demonstration pair', exact: true }).click();
  await expect.poll(async () => (await staffDetail(page, id)).result?.images.length).toBe(2);
  const result = (await staffDetail(page, id)).result!;
  expect(result.images.every(item => item.currentVersion?.width === 1600 && item.currentVersion.height === 1000)).toBe(true);
  expect(result.images.map(item => item.currentVersion!.contentHash)[0]).not.toBe(result.images[1]!.currentVersion!.contentHash);
  return result.id;
}
export async function approveAndPublishImages(page: Page, id: string) {
  for (const role of ['Baseline', 'Recent']) {
    await page.getByRole('button', { name: `Approve ${role} image`, exact: true }).click();
    let dialog = page.getByRole('dialog').last();
    await dialog.getByLabel('Review reason', { exact: true }).fill(`Reviewed the ${role} synthetic scene, its original metadata and both date contexts.`);
    for (const checkbox of await dialog.getByRole('checkbox').all()) await checkbox.check();
    await dialog.getByRole('button', { name: 'Confirm image approval', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await staffDetail(page, id)).result?.images.find(item => item.role === role.toUpperCase())?.approvalValid).toBe(true);
    await page.getByRole('button', { name: `Publish ${role} image`, exact: true }).click();
    dialog = page.getByRole('dialog').last();
    await dialog.getByLabel('Publication reason', { exact: true }).fill(`Publish this reviewed ${role} demonstration version for the intended result.`);
    await dialog.getByRole('button', { name: 'Confirm publish image', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await staffDetail(page, id)).result?.images.find(item => item.role === role.toUpperCase())?.state).toBe('PUBLISHED');
  }
}
export async function publishFinding(page: Page, id: string, mismatch = false, beforeSave?: () => Promise<void>) {
  await page.getByLabel('Finding', { exact: true }).fill(answer);
  const comparison = (await staffDetail(page, id)).result!.dateComparison;
  const discrepancy = comparison.rows.filter(row => row.status === 'DIFFERENT').map(row => `${row.role === 'BASELINE' ? 'Baseline' : 'Recent'}: accepted reference ${row.requestedDate}; supplied illustrative date ${row.supplied!.illustrativeDate}.`).join(' ');
  await page.getByLabel('Uncertainty and limitations', { exact: true }).fill(mismatch ? `${limitations} ${discrepancy} This sample does not fulfill that requested date.` : limitations);
  for (const checkbox of await page.getByRole('group', { name: 'Evidence', exact: true }).getByRole('checkbox').all()) await checkbox.check();
  await beforeSave?.();
  await expect(page.getByLabel('Finding', { exact: true })).toHaveValue(answer);
  await expect(page.getByLabel('Uncertainty and limitations', { exact: true })).toHaveValue(mismatch ? `${limitations} ${discrepancy} This sample does not fulfill that requested date.` : limitations);
  await page.getByRole('button', { name: 'Save finding draft', exact: true }).click();
  await expect.poll(async () => (await staffDetail(page, id)).result?.finding?.currentVersion.answer).toBe(answer);
  await page.getByRole('button', { name: 'Review finding…', exact: true }).click();
  let dialog = page.getByRole('dialog').last();
  await dialog.getByLabel('Review reason', { exact: true }).fill(mismatch ? 'Reviewed the exact cited pair and disclosed the Baseline date discrepancy; acknowledgment changes no accepted terms.' : 'Reviewed the answer, exact pair, rights and accurate synthetic limitations against the original question.');
  for (const checkbox of await dialog.getByRole('checkbox').all()) await checkbox.check();
  await dialog.getByRole('button', { name: 'Confirm finding review', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await staffDetail(page, id)).result?.finding?.reviewValid).toBe(true);
  await page.getByRole('button', { name: 'Publish finding…', exact: true }).click();
  dialog = page.getByRole('dialog').last();
  await dialog.getByRole('button', { name: 'Confirm publish finding', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await staffDetail(page, id)).result?.finding?.state).toBe('PUBLISHED');
}
export async function grant(page: Page, id: string) {
  await page.getByLabel('Access reason', { exact: true }).fill('Permit Demo Estuary Research to inspect the published synthetic demonstration material under its stated rights.');
  await page.getByRole('button', { name: 'Review access change', exact: true }).click();
  const dialog = page.getByRole('dialog').last();
  await expect(dialog.getByText('Demo Estuary Research', { exact: false }).first()).toBeVisible();
  await dialog.getByRole('button', { name: 'Confirm access change', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await staffDetail(page, id)).result?.access?.active).toBe(true);
}
export async function viewState(page: Page, name: string) {
  const region = page.getByRole('region', { name, exact: true });
  await expect(region.locator('img')).toHaveJSProperty('naturalWidth', 1600);
  return region.evaluate(node => {
    const image = node.querySelector('img')!;
    const matrix = new DOMMatrix(getComputedStyle(image).transform);
    const fit = Math.min(node.clientWidth / image.naturalWidth, node.clientHeight / image.naturalHeight);
    return { zoom: matrix.a / fit, x: (node.clientWidth / 2 - matrix.e) / (matrix.a * image.naturalWidth), y: (node.clientHeight / 2 - matrix.f) / (matrix.a * image.naturalHeight) };
  });
}
export async function expectLinked(page: Page) {
  const main = await viewState(page, 'Baseline image viewer');
  const second = await viewState(page, 'Recent image viewer — pan only');
  expect(second.zoom).toBeCloseTo(main.zoom, 5);
  expect(second.x).toBeCloseTo(main.x, 5); expect(second.y).toBeCloseTo(main.y, 5);
}
