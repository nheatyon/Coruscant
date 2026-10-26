import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RequestProjection } from '../../shared/contracts.js';
import { chooseDemonstrationCatalog, enterCustomer, enterStaff, showDiscoveryList } from './helpers.js';

test.setTimeout(120_000);
const questionField = (page: Page) => page.getByLabel('Search satellites and services', { exact: true });
async function openFilters(page: Page) {
  if (!await questionField(page).isVisible()) await page.getByRole('button', { name: 'Discover', exact: true }).click();
  await expect(questionField(page)).toBeVisible();
}
async function describe(page: Page, question: string) {
  await openFilters(page); await questionField(page).fill(question);
  await expect(page.getByText('Your mission question stays local.', { exact: false }).first()).toBeVisible();
}
async function findPhrase(page: Page, phrase: string) {
  await page.getByLabel('Place phrase', { exact: true }).fill(phrase);
  const find = page.getByRole('button', { name: 'Find place', exact: true });
  await expect(find).toBeEnabled(); const pending = page.waitForResponse(response => response.url().endsWith('/api/place-lookups') && response.request().method() === 'POST'); await find.click(); const response = await pending;
  const again = page.getByRole('button', { name: 'Try place lookup again', exact: true });
  // A shared limiter is part of the ordinary service. Only a deliberate second
  // button click is made after the displayed cooldown, never a hidden retry.
  if (response.status() === 429) { await expect(again).toBeVisible(); await expect(again).toBeEnabled({ timeout: 8000 }); await again.click(); }
}
async function readCatalogOnly(page: Page) {
  await page.getByRole('button', { name: 'Search catalog only', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Search catalog only', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Earth observation', exact: true }).click();
  const review = page.getByRole('button', { name: 'Use reviewed filters', exact: true });
  if (await review.isVisible()) await review.click();
}
async function applyLookup(page: Page) {
  await page.getByRole('button', { name: 'Apply proposed location', exact: true }).click();
  await expect(page.getByText('UNAPPLIED AREA PROPOSAL', { exact: true })).toHaveCount(0);
}
async function openBrief(page: Page) {
  await showDiscoveryList(page); await page.getByRole('button', { name: /Review this mission/ }).click();
  const panel = page.getByRole('dialog', { name: 'Your request', exact: true }); await expect(panel).toBeVisible(); return panel;
}
async function savePlanning(page: Page, loseResponse = false) {
  const saveAttempts: Record<string, unknown>[] = [];
  if (loseResponse) await page.route('**/api/commands/savePlanningRequest', async route => { saveAttempts.push(route.request().postDataJSON()); if (saveAttempts.length === 1) { const response = await route.fetch(); expect(response.status()).toBe(201); await route.abort('failed'); } else await route.continue(); });
  await page.getByRole('button', { name: 'Review request', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Save your planning request', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Open customer workspace', exact: true }).click();
  await page.getByRole('combobox', { name: 'Demonstration customer', exact: true }).selectOption('a-owner');
  await page.getByRole('button', { name: 'Continue to workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Review request in this workspace', exact: true }).click();
  await page.getByRole('checkbox', { name: 'I confirm this planning brief and destination. This does not request staff review.', exact: true }).check();
  const save = page.getByRole('button', { name: 'Save planning request', exact: true }); await expect(save).toBeEnabled(); await save.click();
  if (loseResponse) { const retry = page.getByRole('button', { name: 'Retry same planning save', exact: true }); await expect(retry).toBeEnabled(); await retry.click(); }
  await expect(page.getByRole('heading', { name: 'Request saved', exact: true })).toBeVisible();
  const reference = await page.locator('.receipt-reference').textContent();
  await page.getByRole('link', { name: 'Open request in Demo Estuary Research', exact: true }).click();
  const id = new URL(page.url()).pathname.split('/').at(-1)!;
  if (loseResponse) { await page.unroute('**/api/commands/savePlanningRequest'); expect(saveAttempts).toHaveLength(2); expect(saveAttempts[1]).toEqual(saveAttempts[0]); }
  const response = await page.request.get(`/api/customer/org-a/requests/${id}`); expect(response.status()).toBe(200);
  return { id, reference, row: await response.json() as RequestProjection };
}

test('disclosed phrase lookup hands the sourced circle into Single-observation Planning, then separately submits the same request @slice-09', async ({ page }, info) => {
  await page.goto('/'); await chooseDemonstrationCatalog(page);
  const lookups: Record<string, unknown>[] = []; page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/place-lookups')) lookups.push(request.postDataJSON()); });
  const purpose = `Visible imagery of Busan Harbor. Research question ${info.project.name}.`;
  await describe(page, purpose);
  await expect(page.getByLabel('Place phrase', { exact: true })).toHaveValue('Busan Harbor');
  expect(lookups).toHaveLength(0);
  await page.getByRole('button', { name: 'Explore matches & find place', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Busan Harbor — generated provider-response test place', exact: true })).toBeVisible();
  expect(lookups).toHaveLength(1); expect(lookups[0]).toMatchObject({ query: 'Busan Harbor' });
  expect(Object.keys(lookups[0]!).sort()).toEqual(['contextGeneration','contextToken','generation','query']);
  expect(JSON.stringify(lookups[0])).not.toContain(purpose);
  await expect(page.getByRole('region', { name: 'Current area and place names', exact: true }).first()).toContainText('No area applied');
  await applyLookup(page);
  await page.getByRole('button', { name: 'Earth observation', exact: true }).click();
  const panel = await openBrief(page);
  await expect(panel.getByRole('radio', { name: 'Single observation', exact: true })).toBeChecked();
  await expect(panel.getByLabel('Baseline reference date', { exact: true })).toHaveCount(0);
  await expect(panel.getByLabel('Centre latitude', { exact: true })).toHaveValue('35.1017');
  await expect(panel.getByLabel('Centre longitude', { exact: true })).toHaveValue('129.0407');
  await expect(panel.getByLabel('Radius (km)', { exact: true })).toHaveValue('25');
  await expect(panel.getByRole('checkbox', { name: 'I chose this target and checked the area size.', exact: true })).not.toBeChecked();
  await panel.getByRole('checkbox', { name: 'I chose this target and checked the area size.', exact: true }).check();
  await expect(panel.getByLabel('Contact email', { exact: true })).toHaveValue('');
  const saved = await savePlanning(page, true);
  expect(saved.row.history.filter(event => event.type === 'Planning saved')).toHaveLength(1);
  expect(saved.row.status).toBe('Planning'); expect(saved.row.submittedAt).toBeNull(); expect(saved.row.submittedBy).toBeNull(); expect(saved.row.originalSubmittedContact).toBeNull();
  expect(saved.row.brief).toMatchObject({ purpose, observationIntent: 'single-observation', sensor: 'VISIBLE', baselineDate: '', recentDate: '', contact: { name: '', email: '', organization: '' }, areaSource: { sourcePhrase: 'Busan Harbor', provider: 'https://place-fixture.coruscant.invalid/search', sourceCenter: { latitude: 35.1017, longitude: 129.0407 } } });
  await expect(page.getByRole('heading', { name: 'No selected plan', exact: true })).toBeVisible();
  await page.reload(); await expect(page.locator('.page-heading').getByText('Planning', { exact: true })).toBeVisible();
  await page.goto('/workspaces/org-a/missions');
  await expect(page.locator('.mission-group').filter({ has: page.getByRole('heading', { name: 'Current', exact: true }) })).toContainText(saved.reference!);
  await expect(page.getByRole('region', { name: 'Upcoming windows', exact: true })).not.toContainText(saved.reference!);
  await enterStaff(page);
  const staffList = await (await page.request.get('/api/staff/requests')).json(); expect(staffList.requests.some((row: RequestProjection) => row.id === saved.id)).toBe(false);
  await enterCustomer(page); await page.goto(`/workspaces/org-a/service-requests/${saved.id}`);
  await page.getByRole('button', { name: 'Submit request for review…', exact: true }).click();
  const submit = page.getByRole('dialog', { name: 'Submit Planning request for review', exact: true });
  await submit.getByLabel('Contact name', { exact: true }).fill('Fresh planning test contact');
  await submit.getByLabel('Contact email', { exact: true }).fill('planning-test@example.test');
  await submit.getByLabel('Organisation name', { exact: true }).fill('Generated browser research group');
  await submit.getByRole('checkbox', { name: 'I request staff feasibility review for this brief and workspace. This is not a booking or collection.', exact: true }).check();
  await submit.getByRole('button', { name: 'Review submission', exact: true }).click();
  const submissionAttempts: Record<string, unknown>[] = [];
  await page.route('**/api/commands/submitPlanningRequest', async route => { submissionAttempts.push(route.request().postDataJSON()); if (submissionAttempts.length === 1) { const response = await route.fetch(); expect(response.status()).toBe(200); await route.abort('failed'); } else await route.continue(); });
  await submit.getByRole('button', { name: 'Submit request for review', exact: true }).click();
  await expect(submit.getByRole('button', { name: 'Retry same review submission', exact: true })).toBeEnabled();
  await submit.getByRole('button', { name: 'Close Submit Planning request for review', exact: true }).click();
  await page.getByRole('button', { name: 'Keep draft and continue', exact: true }).click(); await expect(submit).toHaveCount(0);
  await page.getByRole('button', { name: 'Refresh request', exact: true }).click();
  await expect(page.locator('.page-heading').getByText('Submitted', { exact: true })).toBeVisible();
  const recovery = page.getByRole('region', { name: 'Retained review submission', exact: true });
  await expect(recovery.getByRole('button', { name: 'Retry same review submission', exact: true })).toBeEnabled();
  await recovery.getByRole('button', { name: 'Retry same review submission', exact: true }).click(); await expect(recovery).toHaveCount(0);
  await page.unroute('**/api/commands/submitPlanningRequest'); expect(submissionAttempts).toHaveLength(2); expect(submissionAttempts[1]).toEqual(submissionAttempts[0]);
  const row = await (await page.request.get(`/api/customer/org-a/requests/${saved.id}`)).json() as RequestProjection;
  expect(row.history.filter(event => event.type === 'Submitted')).toHaveLength(1);
  expect(row.reference).toBe(saved.reference); expect(row.status).toBe('Submitted'); expect(row.submittedAt).toBeTruthy(); expect(row.originalSubmittedContact?.email).toBe('planning-test@example.test'); expect(row.brief.areaSource).toEqual(saved.row.brief.areaSource);
  const logs = readFileSync(join(String(info.config.metadata.dataRoot), 'place-fixture-requests.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(logs.some(value => value.query === 'Busan Harbor')).toBe(true);
  for (const value of logs) { expect(value.keys.sort()).toEqual(['accept-language','addressdetails','format','limit','q']); expect(value.authorization).toBeNull(); expect(value.cookie).toBeNull(); expect(value.userAgent).toContain('Coruscant'); }
  await page.screenshot({ path: info.outputPath('same-planning-submitted-request.png') });
});

test('ambiguous and corrected place results remain unapplied, and a new description cannot overwrite a confirmed target @slice-09', async ({ page }) => {
  await page.goto('/'); await chooseDemonstrationCatalog(page);
  await describe(page, 'SAR imagery of Busan Harbor.'); await readCatalogOnly(page); const panel = await openBrief(page);
  await panel.getByLabel('Centre latitude', { exact: true }).fill('52.6'); await panel.getByLabel('Centre longitude', { exact: true }).fill('-9.7'); await panel.getByLabel('Radius (km)', { exact: true }).fill('30');
  await panel.getByRole('button', { name: 'Use these coordinates', exact: true }).click(); await panel.getByRole('checkbox', { name: 'I chose this target and checked the area size.', exact: true }).check();
  await panel.getByLabel('Centre latitude', { exact: true }).fill('not-a-coordinate');
  await panel.getByRole('button', { name: 'Review request', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'Describe your mission', exact: true })).toBeVisible();
  await expect(panel.getByLabel('Centre latitude', { exact: true })).toHaveValue('not-a-coordinate');
  await expect(panel.getByRole('region', { name: 'Current area and place names', exact: true })).toContainText('52.6000°');
  await expect(panel.getByText('Apply or cancel the pending area preparation before reviewing this Planning brief.', { exact: true }).first()).toBeVisible();
  await panel.getByRole('button', { name: 'Cancel coordinate edits', exact: true }).click();
  await expect(panel.getByLabel('Centre latitude', { exact: true })).toHaveValue('52.6');
  await expect(panel.getByRole('checkbox', { name: 'I chose this target and checked the area size.', exact: true })).toBeChecked();
  await panel.getByRole('button', { name: 'Keep brief and close', exact: true }).click(); await expect(panel).toHaveCount(0);
  await describe(page, 'Visible imagery of Springfield.'); await findPhrase(page, 'Springfield');
  await expect(page.getByRole('button', { name: /Springfield North — generated/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Apply proposed location', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Current area and place names', exact: true }).first()).toContainText('52.6000°');
  await page.getByRole('button', { name: /Springfield South — generated/ }).click();
  await page.getByRole('button', { name: 'Keep existing target', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Current area and place names', exact: true }).first()).toContainText('Size confirmed');
  await findPhrase(page, 'Busan Harbor'); await expect(page.getByRole('heading', { name: /Busan Harbor — generated/ })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel proposal', exact: true }).click();
  await expect(page.getByText(/Lookup or area proposal canceled/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Apply proposed location', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Preview returned location', exact: true }).click();
  await expect(page.getByText(/Lookup or area proposal canceled/)).toHaveCount(0); await applyLookup(page);
  await readCatalogOnly(page); const changed = await openBrief(page);
  await expect(changed.getByLabel('Centre latitude', { exact: true })).toHaveValue('35.1017');
  await expect(changed.getByRole('checkbox', { name: 'I chose this target and checked the area size.', exact: true })).not.toBeChecked();
  await changed.getByRole('radio', { name: 'Baseline–recent comparison', exact: true }).check();
  await expect(changed.getByLabel('Baseline reference date', { exact: true })).toHaveValue(''); await expect(changed.getByLabel('Recent reference date', { exact: true })).toHaveValue('');
  await changed.getByLabel('Baseline reference date', { exact: true }).fill('2026-01-01'); await changed.getByLabel('Recent reference date', { exact: true }).fill('2026-02-01');
  await changed.getByRole('radio', { name: 'Single observation', exact: true }).check(); await expect(changed.getByLabel('Baseline reference date', { exact: true })).toHaveCount(0);
  await changed.getByRole('radio', { name: 'Baseline–recent comparison', exact: true }).check(); await expect(changed.getByLabel('Baseline reference date', { exact: true })).toHaveValue('2026-01-01');
});

test('late or canceled place responses cannot move a target and lookup failure preserves numeric fallback @slice-09', async ({ page }) => {
  await page.goto('/'); await chooseDemonstrationCatalog(page); await describe(page, 'Visible imagery of Busan Harbor.');
  let release!: () => void, captured!: () => void, completed!: () => void, intentionallyCanceled = false;
  const arrived = new Promise<void>(resolve => { captured = resolve; }), held = new Promise<void>(resolve => { release = resolve; }), finished = new Promise<void>(resolve => { completed = resolve; });
  await page.route('**/api/place-lookups', async route => {
    try { const response = await route.fetch(); captured(); await held; await route.fulfill({ response }); }
    catch (error) { if (!intentionallyCanceled || !/already handled|abort|cancel/i.test(String(error))) throw error; }
    finally { completed(); }
  });
  await page.getByRole('button', { name: 'Explore matches & find place', exact: true }).click(); await arrived;
  intentionallyCanceled = true; await questionField(page).fill('Thermal imagery of another deliberate region.'); release(); await finished; await page.unroute('**/api/place-lookups');
  await expect(page.getByRole('button', { name: 'Apply proposed location', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Current area and place names', exact: true }).first()).toContainText('No area applied');
  await page.route('**/api/place-lookups', route => route.fulfill({ status: 503, json: { code: 'PLACE_LOOKUP_UNAVAILABLE', message: 'Generated browser offline response. Your target is retained.' } }));
  await findPhrase(page, 'Unavailable Test Place'); await expect(page.getByText(/Place lookup unavailable/)).toBeVisible();
  await readCatalogOnly(page); const panel = await openBrief(page);
  await panel.getByLabel('Centre latitude', { exact: true }).fill('0'); await panel.getByLabel('Centre longitude', { exact: true }).fill('0'); await panel.getByLabel('Radius (km)', { exact: true }).fill('1');
  await panel.getByRole('button', { name: 'Use these coordinates', exact: true }).click();
  await expect(panel.getByRole('region', { name: 'Current area and place names', exact: true })).toContainText('0.0000°');
  await expect(panel.getByLabel('Mission purpose', { exact: true })).toHaveValue('Thermal imagery of another deliberate region.');
});

test('numeric editing immediately cancels a pending place read and keeps its own proposal after a late response @slice-09', async ({ page }) => {
  await page.goto('/'); await chooseDemonstrationCatalog(page); await describe(page,'Visible imagery of Busan Harbor.'); await readCatalogOnly(page);
  let release!:()=>void, arrived!:()=>void, finished!:()=>void;
  const held=new Promise<void>(r=>{release=r;}), captured=new Promise<void>(r=>{arrived=r;}), done=new Promise<void>(r=>{finished=r;});
  await page.route('**/api/place-lookups',async route=>{try{const response=await route.fetch();arrived();await held;await route.fulfill({response}).catch(()=>{});}finally{finished();}});
  await page.getByRole('button',{name:'Find place',exact:true}).click();await captured;
  const panel=await openBrief(page);await panel.getByLabel('Centre latitude',{exact:true}).fill('1');
  await expect(panel.getByRole('button',{name:'Cancel lookup',exact:true})).toHaveCount(0);
  await expect(panel.getByText(/Looking up only/)).toHaveCount(0);
  await expect(panel.getByRole('heading',{name:'Coordinate proposal',exact:true})).toBeVisible();
  release();await done;await page.unroute('**/api/place-lookups');
  await expect(panel.getByLabel('Centre latitude',{exact:true})).toHaveValue('1');
  await expect(panel.getByRole('heading',{name:'Busan Harbor — generated provider-response test place',exact:true})).toHaveCount(0);
  await panel.getByRole('button',{name:'Use these coordinates',exact:true}).click();
  await expect(panel.getByRole('region',{name:'Current area and place names',exact:true})).toContainText('1.0000°');
  await expect(panel.getByRole('checkbox',{name:'I chose this target and checked the area size.',exact:true})).not.toBeChecked();
});

test('unavailable lookup provenance can be explicitly replaced by the same manual circle without WebGL or lost inputs @slice-09', async ({ page }, info) => {
  await page.addInitScript(() => { const original = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function(this: HTMLCanvasElement, kind, ...args) { return kind === 'webgl2' ? null : Reflect.apply(original, this, [kind, ...args]); } as typeof original; });
  await page.goto('/'); await chooseDemonstrationCatalog(page);
  const purpose = `SAR imagery of Busan Harbor. Manual fallback ${info.project.name}.`;
  await describe(page, purpose); await page.getByRole('button', { name: 'Explore matches & find place', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Apply proposed location', exact: true })).toBeVisible(); await applyLookup(page);
  await page.getByRole('button', { name: 'Earth observation', exact: true }).click();
  await page.getByRole('button', { name: 'List view · continue without WebGL', exact: true }).click();
  const panel = await openBrief(page);
  await panel.getByRole('checkbox', { name: 'I chose this target and checked the area size.', exact: true }).check();
  await panel.getByLabel('Contact name', { exact: true }).fill('Retained fallback contact');
  await panel.getByLabel('Contact email', { exact: true }).fill('manual-fallback@example.test');
  await panel.getByLabel('Organisation name', { exact: true }).fill('Retained environmental team');
  await panel.getByLabel('Details still to confirm', { exact: true }).fill('Retain this unresolved detail.');
  let rejectedLookupReview = 0;
  await page.route('**/api/command-reviews/savePlanningRequest', async route => {
    if (route.request().postDataJSON().payload.brief.areaSource) { ++rejectedLookupReview; await route.fulfill({ status: 409, json: { code: 'PLACE_SOURCE_UNAVAILABLE', message: 'Generated unavailable-source review response. Your input is retained.', fieldErrors: { areaSource: 'The exact selected place source could not be verified.' } } }); }
    else await route.continue();
  });
  await panel.getByRole('button', { name: 'Review request', exact: true }).click();
  await page.getByRole('link', { name: 'Open customer workspace', exact: true }).click();
  await page.getByRole('combobox', { name: 'Demonstration customer', exact: true }).selectOption('a-owner');
  await page.getByRole('button', { name: 'Continue to workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Review request in this workspace', exact: true }).click();
  await page.getByRole('checkbox', { name: 'I confirm this planning brief and destination. This does not request staff review.', exact: true }).check();
  await expect(page.getByText('Generated unavailable-source review response. Your input is retained.', { exact: true })).toBeVisible(); expect(rejectedLookupReview).toBe(1);
  await panel.getByRole('button', { name: 'Edit brief', exact: true }).click();
  await panel.getByRole('button', { name: 'Review as manual coordinates', exact: true }).click();
  await expect(panel.getByLabel('Centre latitude', { exact: true })).toHaveValue('35.1017'); await expect(panel.getByLabel('Centre longitude', { exact: true })).toHaveValue('129.0407'); await expect(panel.getByLabel('Radius (km)', { exact: true })).toHaveValue('25');
  await expect(panel.getByRole('checkbox', { name: 'I chose this target and checked the area size.', exact: true })).toBeChecked(); // Staging alone leaves the applied circle unchanged.
  await panel.getByRole('button', { name: 'Use these coordinates', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Review as manual coordinates', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('checkbox', { name: 'I chose this target and checked the area size.', exact: true })).not.toBeChecked();
  await panel.getByRole('checkbox', { name: 'I chose this target and checked the area size.', exact: true }).check();
  await expect(panel.getByLabel('Mission purpose', { exact: true })).toHaveValue(purpose); await expect(panel.getByLabel('Contact email', { exact: true })).toHaveValue('manual-fallback@example.test'); await expect(panel.getByLabel('Details still to confirm', { exact: true })).toHaveValue('Retain this unresolved detail.');
  await panel.getByRole('button', { name: 'Review request', exact: true }).click();
  await panel.getByRole('checkbox', { name: 'I confirm this planning brief and destination. This does not request staff review.', exact: true }).check();
  await panel.getByRole('button', { name: 'Save planning request', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Request saved', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Open request in Demo Estuary Research', exact: true }).click();
  const id = new URL(page.url()).pathname.split('/').at(-1)!;
  const row = await (await page.request.get(`/api/customer/org-a/requests/${id}`)).json() as RequestProjection;
  expect(row.status).toBe('Planning'); expect(row.brief.areaSource).toBeNull(); expect(row.brief.area).toMatchObject({ method: 'coordinates', latitude: 35.1017, longitude: 129.0407, radiusKm: 25 }); expect(row.brief.purpose).toBe(purpose); expect(row.brief.contact.email).toBe('manual-fallback@example.test'); expect(row.brief.unknowns).toEqual(['Retain this unresolved detail.']); expect(rejectedLookupReview).toBe(1);
});

test('hiding during a pending lookup cancels its state and cannot restore a preview after return @slice-09', async ({ page }) => {
  await page.goto('/'); await chooseDemonstrationCatalog(page); const purpose = 'Visible imagery of Busan Harbor. Pending visibility check.'; await describe(page, purpose);
  let release!: () => void, captured!: () => void, completed!: () => void, intentionallyCanceled = false;
  const arrived = new Promise<void>(resolve => { captured = resolve; }), held = new Promise<void>(resolve => { release = resolve; }), finished = new Promise<void>(resolve => { completed = resolve; });
  await page.route('**/api/place-lookups', async route => { try { const response = await route.fetch(); captured(); await held; await route.fulfill({ response }); } catch (error) { if (!intentionallyCanceled || !/already handled|abort|cancel/i.test(String(error))) throw error; } finally { completed(); } });
  await page.getByRole('button', { name: 'Explore matches & find place', exact: true }).click(); await arrived;
  intentionallyCanceled = true; await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  release(); await finished;
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.unroute('**/api/place-lookups');
  await expect(page.getByText(/Lookup or area proposal canceled/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Find place', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Apply proposed location', exact: true })).toHaveCount(0); await expect(questionField(page)).toHaveValue(purpose);
});
